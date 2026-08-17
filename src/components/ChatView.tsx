import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ChevronLeft, Loader2, Monitor, Square } from "lucide-react";
import { useStore, formatTime, type Bot, type Message } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { ChatMarkdown } from "./ChatMarkdown";
import { OptionCard } from "./OptionCard";
import { Composer } from "./Composer";
import { ModelPicker } from "./ModelPicker";
import { cn } from "@/lib/cn";
import { useMobileNav } from "@/lib/mobile-nav";

/** Long user messages collapse behind a fade so pasted walls of text don't
 * bury the conversation; bots get full markdown. */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

function Bubble({ message }: { message: Message }) {
  const user = message.role === "user";
  const [expanded, setExpanded] = useState(false);
  const text = message.text ?? "";
  const collapsible =
    user && !expanded && (text.length > USER_COLLAPSE_CHARS || text.split("\n").length > USER_COLLAPSE_LINES);
  return (
    <div className={cn("flex w-full", user ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[min(85%,28rem)] rounded-2xl px-3.5 py-2.5 text-[15px] leading-relaxed sm:max-w-[70%] sm:px-4",
          user ? "whitespace-pre-wrap bg-bubble-user text-ink" : "bg-card text-ink",
        )}
      >
        {user ? (
          <>
            <div
              className={cn(collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}
            >
              {text}
            </div>
            {collapsible && (
              <button onClick={() => setExpanded(true)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                Show full message
              </button>
            )}
          </>
        ) : (
          <ChatMarkdown text={text} />
        )}
      </div>
    </div>
  );
}

function ScreenFrame({ png, mime, live }: { png: string; mime?: string; live?: boolean }) {
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "overflow-hidden rounded-2xl border border-hairline/40 bg-inset",
          "w-full max-w-[min(85%,28rem)] sm:max-w-[min(70%,36rem)]",
        )}
      >
        {live && (
          <div className="flex items-center gap-1.5 border-b border-hairline/30 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">
            <span className="size-1.5 animate-pulse rounded-full bg-accent" />
            Live desktop
          </div>
        )}
        <div className="flex max-h-[min(42vh,320px)] items-center justify-center bg-black/40 p-1.5 sm:max-h-[min(48vh,380px)]">
          <img
            src={`data:${mime ?? "image/png"};base64,${png}`}
            alt={live ? "Live bot desktop" : "Bot's screen"}
            className="max-h-[min(40vh,300px)] w-auto max-w-full object-contain sm:max-h-[min(46vh,360px)]"
          />
        </div>
      </div>
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[min(85%,28rem)] rounded-2xl bg-card px-3.5 py-2.5 text-[15px] leading-relaxed text-ink sm:max-w-[70%] sm:px-4">
        <ChatMarkdown text={text} streaming />
        <span className="ml-0.5 inline-block h-[14px] w-[2px] animate-pulse bg-ink-secondary align-middle" />
      </div>
    </div>
  );
}

/** "Working for 12s" that ticks by mutating textContent on an interval —
 * no React commit per second while a turn streams (upstream trick). */
function WorkingTimer({ since }: { since: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const tick = () => {
      if (ref.current) ref.current.textContent = `Working for ${Math.max(0, Math.round((Date.now() - since) / 1000))}s`;
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [since]);
  return <span ref={ref} className="text-[12.5px] text-ink-secondary" />;
}

type FeedItem =
  | { key: string; kind: "single"; message: Message }
  | { key: string; kind: "screen"; message: Message };

/** Skip tool activity chips in chat (tools run silently). Keep the last
 * screen frame in a streak; mid-turn live preview replaces transcript screens. */
function buildFeed(messages: Message[], busy: boolean): FeedItem[] {
  const items: FeedItem[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (m.kind === "activity") {
      while (i < messages.length && messages[i]!.kind === "activity") i += 1;
      continue;
    }
    if (m.kind === "screen") {
      const streak: Message[] = [];
      while (i < messages.length && messages[i]!.kind === "screen") {
        streak.push(messages[i]!);
        i += 1;
      }
      if (busy) continue;
      const last = streak[streak.length - 1]!;
      if (last.png) items.push({ key: last.id, kind: "screen", message: last });
      continue;
    }
    items.push({ key: m.id, kind: "single", message: m });
    i += 1;
  }
  return items;
}

export function ChatView({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const { openList } = useMobileNav();
  const scrollRef = useRef<HTMLDivElement>(null);

  const streaming = state.streaming[bot.threadId];
  const provisioning = state.provisioning[bot.id];
  const liveScreen = state.screens[bot.id];
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;

  const feed = useMemo(() => buildFeed(bot.messages, bot.busy ?? false), [bot.messages, bot.busy]);

  // Follow the live end until the user scrolls away. Programmatic stick-to-bottom
  // must not count as a user scroll (that used to re-arm follow and yank the view).
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  followRef.current = follow;
  const sticking = useRef(false);
  const touchY = useRef(0);

  const atEnd = (el: HTMLDivElement, pad = 80) =>
    el.scrollHeight - el.scrollTop - el.clientHeight < pad;

  const stickToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    sticking.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      sticking.current = false;
    });
  };

  useEffect(() => setFollow(true), [bot.id]);
  useEffect(() => {
    if (follow) stickToBottom();
  }, [bot.id, feed.length, streaming, bot.busy, liveScreen?.png, follow]);

  // Viewing this chat clears the unread badge (including after a turn finishes).
  useEffect(() => {
    if (!bot.unread) return;
    dispatch({ type: "updateBot", botId: bot.id, patch: { unread: false } });
  }, [bot.id, bot.unread, dispatch]);

  const jumpToLatest = () => {
    setFollow(true);
    stickToBottom();
  };

  const first = bot.messages[0];
  const workSince = [...bot.messages].reverse().find((m) => m.role === "user")?.at ?? Date.now();

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-hairline/30 px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] sm:border-b-0 sm:px-5 sm:py-3 sm:pt-3">
        <div className="flex min-w-0 items-center gap-1">
          <button
            onClick={openList}
            className="shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink md:hidden"
            title="Back to chats"
            aria-label="Back to chats"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            onClick={() => dispatch({ type: "toggleSettings" })}
            data-tour="bot-settings"
            className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 hover:bg-raised/50 sm:gap-2.5 sm:px-1.5"
            title="Bot settings"
          >
            <MausAvatar
              color={bot.color}
              state={stateForBot(bot)}
              size={28}
              motion={mascotMotion?.kind ?? "none"}
              motionKey={mascotMotion?.nonce ?? 0}
            />
            <span className="truncate text-[15px] font-semibold text-ink">{bot.name}</span>
            {bot.busy && <Loader2 size={14} className="shrink-0 animate-spin text-ink-secondary" />}
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          {bot.busy && (
            <button
              onClick={() => dispatch({ type: "interrupt", botId: bot.id })}
              className="flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 px-2 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink sm:px-2.5"
              title="Stop this turn"
            >
              <Square size={12} className="fill-current" />
              <span className="hidden sm:inline">Stop</span>
            </button>
          )}
          <ModelPicker bot={bot} />
          <button
            onClick={() => dispatch({ type: "toggleComputer" })}
            data-tour="computer"
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              state.computerOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title="Bot's computer"
          >
            <Monitor size={18} />
          </button>
        </div>
      </div>

      {/* Error banner */}
      {state.error && (
        <div className="mx-auto w-full max-w-[900px] px-3 sm:px-5">
          <div className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {state.error}
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        className={cn(
          "flex-1 overflow-y-auto px-3 sm:px-5",
          follow ? "[overflow-anchor:none]" : "[overflow-anchor:auto]",
        )}
        onWheel={(e) => {
          if (e.deltaY < 0) setFollow(false);
        }}
        onTouchStart={(e) => (touchY.current = e.touches[0]?.clientY ?? 0)}
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY ?? 0;
          if (y > touchY.current + 8) setFollow(false);
        }}
        onScroll={() => {
          if (sticking.current) return;
          const el = scrollRef.current;
          if (!el) return;
          const pinned = atEnd(el);
          if (pinned !== followRef.current) setFollow(pinned);
        }}
      >
        <div className="mx-auto flex max-w-[900px] flex-col gap-3 pb-4">
          {first && (
            <div className="py-3 text-center text-[13px] text-ink-secondary">
              Today {formatTime(first.at)}
            </div>
          )}
          {feed.map((item) => {
            if (item.kind === "screen") {
              return item.message.png ? (
                <ScreenFrame key={item.key} png={item.message.png} mime={item.message.mime} />
              ) : null;
            }
            const m = item.message;
            if (m.kind === "options") {
              return <OptionCard key={m.id} botId={bot.id} message={m} />;
            }
            return <Bubble key={m.id} message={m} />;
          })}
          {provisioning && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
                <Loader2 size={13} className="animate-spin" />
                Setting up this bot's computer…
              </div>
            </div>
          )}
          {bot.busy && liveScreen?.png && (
            <ScreenFrame png={liveScreen.png} mime={liveScreen.mime} live />
          )}
          {streaming ? (
            <StreamingBubble text={streaming} />
          ) : (
            bot.busy && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2.5 rounded-2xl bg-raised px-4 py-3">
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:0ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:150ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:300ms]" />
                  </span>
                  <WorkingTimer since={workSince} />
                </div>
              </div>
            )
          )}
        </div>
      </div>

      {/* Reading scrollback while new content arrives — one tap back to live */}
      {!follow && (bot.busy || Boolean(streaming)) && (
        <button
          onClick={jumpToLatest}
          className="absolute bottom-24 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
        >
          <ArrowDown size={13} /> Jump to latest
        </button>
      )}

      <Composer bot={bot} />
    </main>
  );
}
