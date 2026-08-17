import { track } from "@/lib/analytics";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Plus, Mic, Square } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { MausAvatar } from "./Avatar";
import { normalizeState } from "@/lib/mascot";
import { browserSpeechSupported, startBrowserSpeech } from "@/lib/web-speech";

/** The active @mention query at the caret: the text between an `@` that
 * starts a word and the caret. null = no mention being typed. */
function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null; // user@host, not a tag
  const query = upto.slice(at + 1);
  if (query.length > 24 || query.includes("@") || query.includes("\n")) return null;
  return { start: at, query };
}

function slashQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const slash = upto.lastIndexOf("/");
  if (slash === -1) return null;
  if (slash > 0 && !/\s/.test(upto[slash - 1])) return null;
  const query = upto.slice(slash + 1);
  if (query.length > 32 || query.includes(" ") || query.includes("\n") || query.includes("/")) return null;
  return { start: slash, query };
}

const SLASH_COMMANDS: Array<{
  id: string;
  label: string;
  kind: "Skill" | "Action";
  blurb: string;
  run: (ctx: {
    dispatch: ReturnType<typeof useStore>["dispatch"];
    setText: (t: string) => void;
  }) => void;
}> = [
  {
    id: "add-connector",
    label: "add-connector",
    kind: "Skill",
    blurb: "Walk through connecting a new app",
    run: ({ dispatch, setText }) => {
      setText("");
      dispatch({ type: "togglePlugins", open: true });
    },
  },
  {
    id: "chat-settings",
    label: "Chat Settings",
    kind: "Action",
    blurb: "Current chat",
    run: ({ dispatch, setText }) => {
      setText("");
      dispatch({ type: "toggleSettings", open: true });
    },
  },
  {
    id: "settings-general",
    label: "Settings: General",
    kind: "Action",
    blurb: "Settings",
    run: ({ dispatch, setText }) => {
      setText("");
      dispatch({ type: "toggleAppSettings", open: true });
    },
  },
  {
    id: "plugins",
    label: "Plugins",
    kind: "Action",
    blurb: "Connected apps marketplace",
    run: ({ dispatch, setText }) => {
      setText("");
      dispatch({ type: "togglePlugins", open: true });
    },
  },
  {
    id: "computer",
    label: "Computer",
    kind: "Action",
    blurb: "Open the shared desktop",
    run: ({ dispatch, setText }) => {
      setText("");
      dispatch({ type: "toggleComputer", open: true });
    },
  },
];

export function Composer({ bot, canChat = true }: { bot: Bot; canChat?: boolean }) {
  const { state, dispatch } = useStore();
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null); // Esc'd this @
  const [slashDismissed, setSlashDismissed] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // what was typed before the mic went on — partials append after it
  const baseText = useRef("");

  // ── @mention picker (tag another bot; the agent reaches it via ask_bot) ──
  const mention = mentionQueryAt(text, caret);
  const candidates = useMemo(() => {
    if (!mention || mention.start === dismissedAt) return [];
    const q = mention.query.trim().toLowerCase();
    return state.bots
      .filter((b) => b.id !== bot.id && !b.hidden)
      .filter((b) => !q || b.name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [mention, dismissedAt, state.bots, bot.id]);
  const pickerOpen = candidates.length > 0;

  const slash = slashQueryAt(text, caret);
  const slashItems = useMemo(() => {
    if (!slash || slash.start === slashDismissed) return [];
    const q = slash.query.toLowerCase();
    return SLASH_COMMANDS.filter(
      (c) => !q || c.id.includes(q) || c.label.toLowerCase().includes(q) || c.blurb.toLowerCase().includes(q),
    ).slice(0, 8);
  }, [slash, slashDismissed]);
  const slashOpen = !pickerOpen && slashItems.length > 0;

  const locked = !canChat || !state.connected;
  const canSend = Boolean(text.trim()) && !bot.busy && !locked;

  useEffect(() => setHighlight(0), [mention?.start, mention?.query, slash?.start, slash?.query]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [text]);

  const pickMention = (peer: Bot) => {
    if (!mention) return;
    const after = text.slice(caret);
    const next = `${text.slice(0, mention.start)}@${peer.name} ${after}`;
    setText(next);
    const newCaret = mention.start + peer.name.length + 2;
    setCaret(newCaret);
    setDismissedAt(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(newCaret, newCaret);
    });
  };

  const send = () => {
    if (!text.trim() || bot.busy || locked) return;
    dispatch({ type: "send", botId: bot.id, text: text.trim() });
    track("message_sent", { driver: bot.modelSelection?.instanceId });
    setText("");
  };

  // Dictation: Electron uses the native Swift helper; the browser uses
  // the Web Speech API (Chrome / Edge). Partials stream into the input;
  // the final transcript stays in the box, ready to edit/send.
  useEffect(() => {
    if (!recording) return;
    setSpeechError(null);

    const applyLine = (line: { text?: string; error?: string }) => {
      if (line.error === "network") {
        setSpeechError("Voice input needs a network connection. Check it and try again.");
        return;
      }
      if (line.error === "not-allowed" || line.error === "service-not-allowed") {
        setSpeechError("Microphone was blocked. Allow it in the browser and try again.");
        return;
      }
      if (typeof line.text === "string") {
        const base = baseText.current;
        setText(base ? `${base} ${line.text}` : line.text);
      }
    };

    const bridge = window.ogb;
    if (bridge) {
      const offTranscript = bridge.onSpeechTranscript(applyLine);
      const offEnd = bridge.onSpeechEnd(({ code }) => {
        setRecording(false);
        if (code === 1) {
          setSpeechError(
            "Dictation needs Microphone + Speech Recognition access — System Settings → Privacy & Security.",
          );
        }
      });
      void bridge.speechStart();
      return () => {
        offTranscript();
        offEnd();
        void bridge.speechStop();
      };
    }

    if (!browserSpeechSupported()) {
      setRecording(false);
      setSpeechError("Voice input isn't supported in this browser. Try Chrome or Edge.");
      return;
    }

    const stop = startBrowserSpeech({
      onTranscript: applyLine,
      onEnd: ({ code }) => {
        setRecording(false);
        if (code === 1) {
          setSpeechError("Microphone was blocked. Allow it in the browser and try again.");
        }
      },
    });
    return () => stop();
  }, [recording]);

  const toggleMic = () => {
    if (!window.ogb && !browserSpeechSupported()) {
      setSpeechError("Voice input isn't supported in this browser. Try Chrome or Edge.");
      return;
    }
    baseText.current = text.trim();
    setSpeechError(null);
    setRecording((r) => !r);
  };

  const syncCaret = (el: HTMLTextAreaElement) => {
    setCaret(el.selectionStart ?? el.value.length);
  };

  return (
    <div className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-5 sm:pb-5">
      {speechError && (
        <div className="mx-auto mb-2 max-w-[900px] rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          {speechError}
        </div>
      )}
      <div className="relative mx-auto max-w-[900px]">
        {slashOpen && (
          <div className="absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden rounded-xl border border-hairline/40 bg-raised shadow-xl sm:left-2 sm:w-[min(22rem,calc(100%-0.5rem))]">
            {slashItems.map((item, i) => (
              <button
                key={item.id}
                onClick={() => item.run({ dispatch, setText })}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full items-center gap-3 border-b border-hairline/20 px-3 py-2.5 text-left last:border-b-0",
                  i === highlight ? "bg-raised-hover" : "hover:bg-raised/80",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-ink">{item.label}</div>
                  <div className="truncate text-[12px] text-ink-secondary">{item.blurb}</div>
                </div>
                <span className="shrink-0 rounded-md bg-inset px-1.5 py-0.5 text-[11px] text-ink-secondary">
                  {item.kind}
                </span>
              </button>
            ))}
          </div>
        )}
        {pickerOpen && (
          <div className="absolute bottom-full left-2 z-20 mb-2 w-[min(18rem,calc(100%-0.5rem))] overflow-hidden rounded-xl border border-hairline/40 bg-raised shadow-lg sm:left-10 sm:w-72">
            {candidates.map((peer, i) => (
              <button
                key={peer.id}
                onClick={() => pickMention(peer)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2.5 text-left sm:py-2",
                  i === highlight ? "bg-raised-hover" : "",
                )}
              >
                <MausAvatar color={peer.color} state={normalizeState(peer.mascotExpression) ?? "happy"} size={24} />
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{peer.name}</span>
                <span className="shrink-0 text-xs text-ink-secondary">Agent</span>
              </button>
            ))}
          </div>
        )}
        <div
          className={cn(
            "flex items-end gap-2 border border-hairline/40 bg-raised/60 py-2 pl-2 pr-2",
            text.includes("\n") || text.length > 48 ? "rounded-[22px]" : "rounded-full",
          )}
        >
          <button
            className="mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"
            title="Commands — type /"
            onClick={() => {
              setText((t) => (t.endsWith("/") || t === "" ? `${t || ""}/` : `${t} /`));
              setSlashDismissed(null);
              requestAnimationFrame(() => {
                const el = inputRef.current;
                if (!el) return;
                el.focus();
                const end = el.value.length;
                el.setSelectionRange(end, end);
                setCaret(end);
              });
            }}
          >
            <Plus size={20} />
          </button>
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            enterKeyHint="send"
            disabled={locked && !bot.busy}
            onChange={(e) => {
              setText(e.target.value);
              syncCaret(e.target);
              setDismissedAt(null);
              setSlashDismissed(null);
            }}
            onKeyUp={(e) => syncCaret(e.currentTarget)}
            onClick={(e) => syncCaret(e.currentTarget)}
            onKeyDown={(e) => {
              if (slashOpen) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const delta = e.key === "ArrowDown" ? 1 : -1;
                  setHighlight((h) => (h + delta + slashItems.length) % slashItems.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  slashItems[highlight]?.run({ dispatch, setText });
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setSlashDismissed(slash?.start ?? null);
                  return;
                }
              }
              if (pickerOpen) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const delta = e.key === "ArrowDown" ? 1 : -1;
                  setHighlight((h) => (h + delta + candidates.length) % candidates.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  pickMention(candidates[highlight]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDismissedAt(mention?.start ?? null);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
              if (e.key === "Escape" && recording) setRecording(false);
            }}
            placeholder={
              !state.connected
                ? "Reconnecting…"
                : !canChat
                  ? "Subscribe to continue chatting"
                  : recording
                    ? "Listening…"
                    : bot.busy
                      ? `${bot.name} is working…`
                      : `Message ${bot.name}`
            }
            className="max-h-32 min-h-[24px] w-full resize-none bg-transparent py-1.5 text-[15px] leading-snug text-ink placeholder:text-ink-secondary focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />
          {bot.busy ? (
            <button
              onClick={() => dispatch({ type: "interrupt", botId: bot.id })}
              className="mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"
              title="Stop"
            >
              <Square size={14} className="fill-current" />
            </button>
          ) : canSend ? (
            <button
              onClick={send}
              className="mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-white hover:brightness-110"
              title="Send"
            >
              <ArrowUp size={18} strokeWidth={2.5} />
            </button>
          ) : (
            <button
              onClick={toggleMic}
              disabled={locked}
              className={cn(
                "mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
                recording
                  ? "animate-pulse bg-danger/20 text-danger"
                  : "text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40",
              )}
              title={locked ? (!canChat ? "Subscribe to continue" : "Reconnecting") : recording ? "Stop dictation (Esc)" : "Dictate"}
            >
              <Mic size={18} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
