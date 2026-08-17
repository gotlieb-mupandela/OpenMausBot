import { useCallback, useEffect, useState } from "react";
import { Bot, MessageSquare, Monitor, Puzzle, Settings, Sparkles, User } from "lucide-react";
import { MausAvatar } from "./Avatar";
import { track } from "@/lib/analytics";
import { useMobileNav } from "@/lib/mobile-nav";
import type { SaasUser } from "./AuthScreen";

type Step = {
  id: string;
  title: string;
  body: string;
  icon: React.ReactNode;
  /** CSS selector for spotlight target; omit for centered welcome/done cards. */
  target?: string;
};

const STEPS: Step[] = [
  {
    id: "welcome",
    title: "Welcome to Aishe",
    body: "Your AI bot team lives in the cloud — each bot gets its own personality, tools, and a real computer. This quick tour shows you around.",
    icon: <Sparkles size={22} className="text-accent" />,
  },
  {
    id: "bots",
    title: "Your bot team",
    body: "Every bot is a separate chat. Switch between them here — each one remembers its own work and style.",
    icon: <Bot size={22} className="text-accent" />,
    target: '[data-tour="sidebar-bots"]',
  },
  {
    id: "new-bot",
    title: "Create a bot",
    body: "Tap + to spin up a teammate. Each bot is its own chat, memory, and style.",
    icon: <Bot size={22} className="text-accent" />,
    target: '[data-tour="new-bot"]',
  },
  {
    id: "chat",
    title: "Chat & voice",
    body: "Type a message or tap the mic to dictate. Bots run turns on their own — you'll see activity and results stream in.",
    icon: <MessageSquare size={22} className="text-accent" />,
    target: '[data-tour="composer"]',
  },
  {
    id: "settings",
    title: "Bot settings",
    body: "Tap your bot's name to rename it, change its model, or tweak how it behaves.",
    icon: <Settings size={22} className="text-accent" />,
    target: '[data-tour="bot-settings"]',
  },
  {
    id: "computer",
    title: "Cloud computer",
    body: "Open the monitor icon for a real cloud desktop — browse, code, and take screenshots.",
    icon: <Monitor size={22} className="text-accent" />,
    target: '[data-tour="computer"]',
  },
  {
    id: "plugins",
    title: "Plugins & apps",
    body: "Connect Gmail, Slack, GitHub, and more so bots can act on your tools — no API keys to paste.",
    icon: <Puzzle size={22} className="text-accent" />,
    target: '[data-tour="plugins"]',
  },
  {
    id: "account",
    title: "Your account",
    body: "Profile and sign-out live here. Extra bots, cloud computer, plugins, and routines are included.",
    icon: <User size={22} className="text-accent" />,
    target: '[data-tour="account"]',
  },
  {
    id: "done",
    title: "You're all set",
    body: "Send your first message whenever you're ready. You can replay this tour from App Settings later.",
    icon: <Sparkles size={22} className="text-accent" />,
  },
];

function useTargetRect(selector: string | undefined, step: number) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!selector) {
      setRect(null);
      return;
    }
    const update = () => {
      const el = document.querySelector(selector);
      if (!el) {
        setRect(null);
        return;
      }
      const box = el.getBoundingClientRect();
      const pad = 8;
      setRect(
        new DOMRect(box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2),
      );
    };
    update();
    const t = window.setInterval(update, 250);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      clearInterval(t);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [selector, step]);

  return rect;
}

function Spotlight({ rect }: { rect: DOMRect }) {
  return (
    <div
      className="pointer-events-none fixed z-[100] rounded-xl ring-2 ring-accent/80 ring-offset-2 ring-offset-transparent transition-all duration-300"
      style={{
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        boxShadow: "0 0 0 9999px rgba(0,0,0,0.72)",
      }}
    />
  );
}

function TooltipCard({
  step,
  index,
  total,
  rect,
  onNext,
  onSkip,
  busy,
}: {
  step: Step;
  index: number;
  total: number;
  rect: DOMRect | null;
  onNext: () => void;
  onSkip: () => void;
  busy: boolean;
}) {
  const centered = !rect;
  const card = (
    <div className="w-full max-w-[380px] rounded-2xl border border-white/10 bg-[#141414] p-5 shadow-2xl shadow-black/60">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0">{step.icon}</span>
        <div className="min-w-0">
          <h2 className="text-[17px] font-semibold text-white">{step.title}</h2>
          <p className="mt-2 text-[14px] leading-relaxed text-white/70">{step.body}</p>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-[12px] text-white/50">
          {index + 1} / {total}
        </span>
        <div className="flex items-center gap-2">
          {index < total - 1 && (
            <button
              onClick={onSkip}
              disabled={busy}
              className="rounded-lg px-3 py-1.5 text-[13px] text-white/60 hover:text-white disabled:opacity-40"
            >
              Skip tour
            </button>
          )}
          <button
            onClick={onNext}
            disabled={busy}
            className="rounded-lg bg-accent px-4 py-1.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            {index === total - 1 ? "Get started" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );

  if (centered) {
    return (
      <div className="fixed inset-0 z-[101] flex items-center justify-center bg-black/72 p-4">
        {card}
      </div>
    );
  }

  const below = rect.top + rect.height + 16 + 200 < window.innerHeight;
  const left = Math.min(Math.max(rect.left, 12), window.innerWidth - 392);
  const topAbove = Math.max(12, rect.top - 16);
  const topBelow = rect.top + rect.height + 16;

  return (
    <div
      className="fixed z-[101] px-3"
      style={{
        top: below ? topBelow : topAbove,
        left,
        width: Math.min(380, window.innerWidth - 24),
        transform: below ? undefined : "translateY(-100%)",
      }}
    >
      {card}
    </div>
  );
}

export function SaasOnboarding({
  user,
  onDone,
}: {
  user: SaasUser;
  onDone: (updated: SaasUser) => void;
}) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const { openList, closeList } = useMobileNav();
  const current = STEPS[step]!;
  const rect = useTargetRect(current.target, step);

  useEffect(() => {
    track("saas_onboarding_step", { step: step + 1, id: current.id });
  }, [step, current.id]);

  useEffect(() => {
    if (step === 0 || step >= STEPS.length - 1) return;
    const mobile = window.matchMedia("(max-width: 767px)").matches;
    if (!mobile) return;
    const id = current.id;
    if (id === "bots" || id === "new-bot" || id === "plugins" || id === "account") openList();
    if (id === "chat" || id === "settings" || id === "computer") closeList();
  }, [step, current.id, openList, closeList]);

  const finish = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/auth/onboarding-complete", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      track("saas_onboarding_completed");
      if (res.ok && data.user) onDone(data.user as SaasUser);
      else onDone({ ...user, needsOnboarding: false });
    } catch {
      onDone({ ...user, needsOnboarding: false });
    } finally {
      setBusy(false);
    }
  }, [onDone, user]);

  const next = () => {
    if (step >= STEPS.length - 1) void finish();
    else setStep((s) => s + 1);
  };

  const firstName = user.name.trim().split(/\s+/)[0] || "there";
  const welcomeBody =
    step === 0
      ? `Hey ${firstName}! Your AI bot team lives in the cloud — each bot gets its own personality, tools, and a real computer. This quick tour shows you around.`
      : current.body;

  const displayStep = step === 0 ? { ...current, body: welcomeBody } : current;

  return (
    <>
      {step === 0 && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black/72 p-4">
          <div className="flex w-full max-w-[400px] flex-col items-center rounded-2xl border border-hairline/40 bg-panel p-6 sm:p-8">
            <MausAvatar color="blue" state="happy" size={72} />
            <h1 className="mt-4 text-center text-[20px] font-semibold text-ink">{displayStep.title}</h1>
            <p className="mt-2 text-center text-[14px] leading-relaxed text-ink-secondary">{displayStep.body}</p>
            <button
              onClick={next}
              className="mt-5 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white hover:brightness-110"
            >
              Start tour
            </button>
            <button
              onClick={() => void finish()}
              disabled={busy}
              className="mt-3 text-[12px] text-ink-secondary hover:text-ink disabled:opacity-40"
            >
              Skip for now
            </button>
          </div>
        </div>
      )}

      {step > 0 && step < STEPS.length - 1 && (
        <>
          {!rect && <div className="fixed inset-0 z-[100] bg-black/72" />}
          {rect && <Spotlight rect={rect} />}
          <TooltipCard
            step={displayStep}
            index={step}
            total={STEPS.length}
            rect={rect}
            onNext={next}
            onSkip={() => void finish()}
            busy={busy}
          />
        </>
      )}

      {step === STEPS.length - 1 && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black/72 p-4">
          <div className="flex w-full max-w-[400px] flex-col items-center rounded-2xl border border-hairline/40 bg-panel p-6 sm:p-8">
            <MausAvatar color="blue" state="celebrate" size={72} />
            <h1 className="mt-4 text-center text-[20px] font-semibold text-ink">{current.title}</h1>
            <p className="mt-2 text-center text-[14px] leading-relaxed text-ink-secondary">{current.body}</p>
            <button
              onClick={() => void finish()}
              disabled={busy}
              className="mt-5 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white hover:brightness-110 disabled:opacity-40"
            >
              {busy ? "Saving…" : "Get started"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
