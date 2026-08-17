// The bot's computer, in the right-side slot. Where it runs decides the
// whole flow: cloud → provision the box on open (idempotent) and preview
// via SSE frames or a ~4s screenshot poll; local ("This Mac") → frames
// come from the Electron main process (desktopCapturer over the preload
// bridge — box endpoints are never touched); off → parked. Auto (unset)
// prefers the cloud box when one exists, else local inside the app.
import { useEffect, useRef, useState } from "react";
import {
  CalendarClock,
  ExternalLink,
  Loader2,
  Monitor,
  Moon,
  Play,
  Power,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { ApiKeyRow } from "./ApiKeys";
import { cn } from "@/lib/cn";
import { PANEL_SHELL } from "@/lib/panel-shell";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

type Phase =
  | "checking"
  | "unconfigured"
  | "starting"
  | "ready"
  | "local"
  | "local-unavailable"
  | "off"
  | "error";

type Routine = {
  id: string;
  name: string;
  instruction: string;
  kind: "daily" | "interval";
  hour?: number;
  minute?: number;
  timezone?: string;
  intervalMinutes?: number;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt: number | null;
};

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function scheduleLabel(r: Routine): string {
  if (r.kind === "interval") {
    const m = r.intervalMinutes ?? 60;
    if (m % 60 === 0) return `Every ${m / 60}h`;
    return `Every ${m} min`;
  }
  const tz = r.timezone ? ` ${r.timezone.replace(/_/g, " ")}` : "";
  return `Daily at ${pad2(r.hour ?? 9)}:${pad2(r.minute ?? 0)}${tz}`;
}

function RoutinesSection({ botId }: { botId: string }) {
  const [rows, setRows] = useState<Routine[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [kind, setKind] = useState<"daily" | "interval">("daily");
  const [time, setTime] = useState("09:00");
  const [intervalHours, setIntervalHours] = useState("1");

  const load = () => {
    setLoading(true);
    return api(`/api/bots/${botId}/routines`)
      .then((d) => {
        setRows(d.routines ?? []);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  const create = async () => {
    setBusyId("create");
    try {
      const [h, mi] = time.split(":").map(Number);
      const hours = Math.max(0.25, Number(intervalHours) || 1);
      await api(`/api/bots/${botId}/routines`, {
        method: "POST",
        body: JSON.stringify({
          name,
          instruction,
          kind,
          hour: h,
          minute: mi,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          intervalMinutes: Math.round(hours * 60),
        }),
      });
      setName("");
      setInstruction("");
      setCreating(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusyId(id);
    try {
      await api(`/api/bots/${botId}/routines/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      await api(`/api/bots/${botId}/routines/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async (id: string) => {
    setBusyId(id);
    try {
      await api(`/api/bots/${botId}/routines/${id}/run`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

  return (
    <div className="mt-4 rounded-xl border border-hairline/40 bg-card p-4">
      <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
        <CalendarClock size={16} className="text-ink-secondary" />
        Routines
      </div>
      <div className="mt-1 text-[13px] leading-snug text-ink-secondary">
        Recurring tasks this bot runs on a schedule — same as sending the instruction in chat.
      </div>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}

      {loading && !rows.length ? (
        <div className="mt-3 flex items-center gap-2 text-[13px] text-ink-secondary">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 && !creating ? (
        <div className="mt-3 rounded-lg bg-inset px-3 py-2.5 text-[12px] text-ink-secondary">
          No routines yet. Name one, write the instruction, and pick a schedule.
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {rows.map((r) => (
            <div key={r.id} className="rounded-lg border border-hairline/30 bg-inset px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-ink">{r.name}</div>
                  <div className="mt-0.5 text-[12px] text-ink-secondary">{scheduleLabel(r)}</div>
                  <div className="mt-0.5 text-[11px] text-ink-secondary">
                    Next {new Date(r.nextRunAt).toLocaleString()}
                    {r.lastRunAt ? ` · last ${new Date(r.lastRunAt).toLocaleString()}` : ""}
                  </div>
                </div>
                <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-secondary">
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    disabled={busyId === r.id}
                    onChange={(e) => void patch(r.id, { enabled: e.target.checked })}
                  />
                  On
                </label>
              </div>
              <p className="mt-1.5 line-clamp-2 text-[12px] text-ink-secondary">{r.instruction}</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busyId === r.id}
                  onClick={() => void runNow(r.id)}
                  className="flex items-center gap-1 rounded-md bg-raised px-2 py-1 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-40"
                >
                  <Play size={12} /> Run now
                </button>
                <button
                  type="button"
                  disabled={busyId === r.id}
                  onClick={() => void remove(r.id)}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-danger hover:bg-danger/10 disabled:opacity-40"
                >
                  <Trash2 size={12} /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {creating ? (
        <div className="mt-3 flex flex-col gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={inputClass} />
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Instruction — what should the bot do?"
            rows={3}
            className={inputClass}
          />
          <div className="flex overflow-hidden rounded-lg border border-hairline/40">
            {(
              [
                ["daily", "Daily"],
                ["interval", "Every…"],
              ] as const
            ).map(([k, label], i) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={cn(
                  "flex-1 py-1.5 text-[13px]",
                  i > 0 && "border-l border-hairline/40",
                  kind === k ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {kind === "daily" ? (
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={inputClass} />
          ) : (
            <input
              type="number"
              min={0.25}
              step={0.25}
              value={intervalHours}
              onChange={(e) => setIntervalHours(e.target.value)}
              placeholder="Hours between runs"
              className={inputClass}
            />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busyId === "create" || !name.trim() || !instruction.trim()}
              onClick={() => void create()}
              className="flex-1 rounded-xl bg-accent py-2 text-[13px] font-medium text-white disabled:opacity-40"
            >
              {busyId === "create" ? "Saving…" : "Save routine"}
            </button>
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="rounded-xl border border-hairline/40 px-3 py-2 text-[13px] text-ink-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="mt-4 w-full rounded-xl border border-hairline/60 bg-transparent py-2.5 text-[14px] font-medium text-ink hover:bg-raised/50"
        >
          Create Routine
        </button>
      )}
    </div>
  );
}

export function ComputerPanel({ bot, saasMode = false }: { bot: Bot; saasMode?: boolean }) {
  const { state, dispatch } = useStore();
  const [phase, setPhase] = useState<Phase>("checking");
  const [boxState, setBoxState] = useState<string | null>(null);
  const [shared, setShared] = useState(false);
  const [polledFrame, setPolledFrame] = useState<{ png: string; mime: string } | null>(null);
  const [localFrame, setLocalFrame] = useState<string | null>(null);
  const [pending, setPending] = useState<"join" | "sleep" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // bumped when a Box token is saved inline, to re-run the spin-up flow
  const [retry, setRetry] = useState(0);

  // resolve the mode on open; box endpoints are only ever hit on the
  // cloud path, so local/off can never render a JSON error as an image
  useEffect(() => {
    let alive = true;
    setPhase("checking");
    setPolledFrame(null);
    setLocalFrame(null);
    setError(null);
    const isElectron = Boolean(window.ogb);
    if (bot.computer === "off") {
      setPhase("off");
      return;
    }
    if (bot.computer === "local") {
      setPhase(isElectron ? "local" : "local-unavailable");
      return;
    }
    // cloud, or auto (cloud box wins when one exists, else local in-app)
    api(`/api/bots/${bot.id}/computer`)
      .then((status) => {
        if (!alive) return;
        setShared(Boolean(status.shared));
        const autoLocal = !saasMode && bot.computer !== "cloud" && isElectron;
        if (!status.configured) {
          setPhase(autoLocal ? "local" : "unconfigured");
          return;
        }
        if (!status.box && autoLocal) {
          setPhase("local");
          return;
        }
        setPhase("starting");
        return api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" }).then((r) => {
          if (!alive) return;
          setBoxState(r.state ?? null);
          setShared(Boolean(r.shared) || Boolean(status.shared));
          setPhase("ready");
        });
      })
      .catch((e) => {
        if (!alive) return;
        setError(e.message);
        setPhase("error");
      });
    return () => {
      alive = false;
    };
  }, [bot.id, bot.computer, retry, saasMode]);

  // cloud preview: SSE frames win while the bot works; otherwise poll
  const live = state.screens[bot.id];
  const sseFlowing = Boolean(bot.busy && live);
  const inFlight = useRef(false);
  useEffect(() => {
    if (phase !== "ready" || sseFlowing) return;
    let alive = true;
    const shoot = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const { png, format } = await api(`/api/bots/${bot.id}/computer/screenshot`, { method: "POST" });
        if (alive) setPolledFrame({ png, mime: format === "jpeg" ? "image/jpeg" : "image/png" });
      } catch {
        /* box mid-command or asleep — next tick */
      } finally {
        inFlight.current = false;
      }
    };
    void shoot();
    const timer = setInterval(shoot, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase, sseFlowing, bot.id]);

  // local preview: frames from the Electron main process. The FIRST capture
  // attempt is what makes macOS show the Screen Recording prompt (there is
  // no reliable pre-grant flow on macOS 15+), so repeated empty frames mean
  // the user denied — surface the Settings repair path instead of spinning.
  const [localMisses, setLocalMisses] = useState(0);
  useEffect(() => {
    if (phase !== "local" || !window.ogb) return;
    let alive = true;
    setLocalMisses(0);
    const shoot = async () => {
      try {
        const url = await window.ogb!.screenFrame();
        if (alive && url) setLocalFrame(url);
        else if (alive) setLocalMisses((n) => n + 1);
      } catch {
        if (alive) setLocalMisses((n) => n + 1);
      }
    };
    void shoot();
    const timer = setInterval(shoot, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase]);

  const lastScreenMessage = [...bot.messages].reverse().find((m) => m.kind === "screen" && m.png);
  const cloudFrame =
    live ??
    polledFrame ??
    (lastScreenMessage ? { png: lastScreenMessage.png!, mime: lastScreenMessage.mime ?? "image/png" } : null);
  const frameSrc =
    phase === "local"
      ? localFrame
      : phase === "ready" || phase === "starting"
        ? cloudFrame && `data:${cloudFrame.mime};base64,${cloudFrame.png}`
        : null;

  const run = (kind: "join" | "sleep") => {
    setPending(kind);
    setError(null);
    api(`/api/bots/${bot.id}/computer/${kind}`, { method: "POST" })
      .then((result) => {
        // the join URL's stream token rotates — always freshly minted, never cached
        if (kind === "join" && result.joinUrl) window.open(result.joinUrl);
        if (kind === "sleep") setBoxState("archived");
      })
      .catch((e) => setError(e.message))
      .finally(() => setPending(null));
  };

  const emptyState: Record<Exclude<Phase, "ready" | "local">, string> = {
    checking: "Checking…",
    starting: shared || saasMode ? "Starting your team's computer…" : "Starting your bot's computer…",
    unconfigured: saasMode
      ? "The team computer isn't ready yet"
      : "No cloud computer configured",
    "local-unavailable": "This Mac preview is only in the desktop app",
    off: "This bot's computer is off",
    error: "Couldn't reach the computer",
  };

  return (
    <aside className={PANEL_SHELL}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: true })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          title="Bot settings"
        >
          <Settings size={18} />
        </button>
        <span className="text-[15px] font-semibold text-ink">Computer</span>
        <button
          onClick={() => dispatch({ type: "toggleComputer", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-5 sm:pb-5">
        {/* Screen preview */}
        <div className="mb-1.5 mt-2 flex items-center justify-between text-[13px] text-ink-secondary">
          <span>{shared || saasMode ? "Team computer" : `${bot.name}'s screen`}</span>
          {phase === "local" && <span className="text-[11px]">this Mac</span>}
          {(shared || saasMode) && phase === "ready" && (
            <span className="text-[11px]">shared by all bots</span>
          )}
        </div>
        <div className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-card">
          {frameSrc ? (
            <img src={frameSrc} alt={`${bot.name}'s screen`} className="h-full w-full object-contain" />
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
              {phase === "checking" || phase === "starting" || phase === "local" ? (
                <Loader2 size={18} className="animate-spin" />
              ) : phase === "off" ? (
                <Power size={22} />
              ) : (
                <Monitor size={22} />
              )}
              <span className="text-[12px]">
                {phase === "ready"
                  ? "Waiting for the first frame…"
                  : phase === "local"
                    ? localMisses >= 3
                      ? "No frames yet — the preview needs Screen Recording permission. After granting, relaunch the app (macOS applies it on next launch)."
                      : "Capturing this Mac's screen…"
                    : emptyState[phase]}
              </span>
              {phase === "local" && localMisses >= 3 && (
                <button
                  onClick={() => window.ogb?.permOpenSettings?.("screen")}
                  className="mt-1 rounded-lg bg-raised px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  Open Settings
                </button>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {(() => {
              if (saasMode) {
                return "Couldn't start the computer. Try again in a moment.";
              }
              const billingMatch = error.match(/https:\/\/box\.ascii\.dev[^\s]*/);
              if (!billingMatch) return error;
              const url = billingMatch[0];
              const before = error.slice(0, billingMatch.index).trim();
              return (
                <span>
                  {before || "Box billing is required to start the computer."}{" "}
                  <a href={url} target="_blank" rel="noreferrer" className="underline hover:text-ink">
                    Open Box billing
                  </a>
                </span>
              );
            })()}
          </div>
        )}
        {phase === "error" && !saasMode && /billing|402|subscription/i.test(error ?? "") && (
          <a
            href="https://box.ascii.dev/box/dashboard?tab=billing&box_api_url=https%3A%2F%2Fascii.dev"
            target="_blank"
            rel="noreferrer"
            className="mt-3 flex w-full items-center justify-center rounded-xl bg-accent py-2.5 text-[13px] font-medium text-white hover:brightness-110"
          >
            Start Box plan ($20/mo)
          </a>
        )}
        {phase === "unconfigured" && !saasMode && (
          <div className="mt-3 rounded-xl bg-card p-4">
            <div className="mb-3 text-[13px] text-ink-secondary">
              Paste a Box token from box.ascii.dev to give this bot a cloud computer — it spins up right here.
            </div>
            <ApiKeyRow
              section="box"
              label="Box token"
              placeholder="Token from box.ascii.dev"
              onSaved={(configured) => configured && setRetry((n) => n + 1)}
            />
          </div>
        )}
        {phase === "unconfigured" && saasMode && (
          <div className="mt-3 rounded-xl bg-card p-4 text-[13px] text-ink-secondary">
            The team computer isn&apos;t available yet. You can still chat with your bots.
          </div>
        )}

        {/* Cloud-only actions */}
        {phase === "ready" && (
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => run("join")}
              disabled={pending === "join"}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            >
              {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
              Open desktop
            </button>
            {boxState !== "archived" && (
              <button
                onClick={() => run("sleep")}
                disabled={pending === "sleep"}
                className="flex items-center justify-center gap-2 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                title="Put the computer to sleep"
              >
                {pending === "sleep" ? <Loader2 size={14} className="animate-spin" /> : <Moon size={14} />}
                Sleep
              </button>
            )}
          </div>
        )}

        {/* Computer source */}
        <div className="mt-4 rounded-xl bg-card p-4">
          <div className="text-[15px] font-medium text-ink">Runs on</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            {saasMode
              ? "All bots share one cloud computer (files and browser sessions included)."
              : bot.computer
                ? ""
                : "Auto: the cloud box when one exists, else this Mac. "}
            {!saasMode && "Pick where this bot's computer lives."}
          </div>
          {!saasMode && (
          <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
            {(
              [
                ["cloud", "Cloud box"],
                ["local", "This Mac"],
                ["off", "Off"],
              ] as const
            ).map(([mode, label], i) => (
              <button
                key={mode}
                onClick={() => dispatch({ type: "updateBot", botId: bot.id, patch: { computer: mode } })}
                className={cn(
                  "flex-1 px-1 py-2 text-[12px] sm:py-1.5 sm:text-[13px]",
                  i > 0 && "border-l border-hairline/40",
                  bot.computer === mode
                    ? "bg-raised text-ink"
                    : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
                )}
              >
                <span className="sm:hidden">{mode === "cloud" ? "Cloud" : mode === "local" ? "Local" : "Off"}</span>
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>
          )}
        </div>

        <RoutinesSection botId={bot.id} />
      </div>
    </aside>
  );
}
