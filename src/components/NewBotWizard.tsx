import { useState } from "react";
import { X } from "lucide-react";
import { useStore } from "@/state/store";
import { MausAvatar } from "./Avatar";
import {
  MAUS_COLOR_NAMES,
  MAUS_COLORS,
  PICKABLE_STATES,
  type MausColor,
  type MausState,
} from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { useMobileNav } from "@/lib/mobile-nav";

const PRESETS: Array<{
  id: string;
  name: string;
  blurb: string;
  color: MausColor;
  expression: MausState;
  title: string;
  description: string;
}> = [
  {
    id: "night-shift",
    name: "Night Shift",
    blurb: "Works overnight and preps your morning digest.",
    color: "orange",
    expression: "working",
    title: "Overnight operator",
    description: "Runs overnight checks and prepares a morning digest of what matters.",
  },
  {
    id: "inbox-triage",
    name: "Inbox Triage",
    blurb: "Sorts your email and drafts replies in your voice.",
    color: "pink",
    expression: "listening",
    title: "Inbox partner",
    description: "Triages email, flags what needs you, and drafts replies in your voice.",
  },
  {
    id: "chief-of-staff",
    name: "Chief of Staff",
    blurb: "Manages your other bots and pulls you in for decisions.",
    color: "red",
    expression: "proud",
    title: "Bot coordinator",
    description: "Coordinates your other bots and escalates only the decisions that need you.",
  },
  {
    id: "negotiator",
    name: "Negotiator",
    blurb: "Researches options and helps you push for better terms.",
    color: "green",
    expression: "curious",
    title: "Deal helper",
    description: "Researches options, compares terms, and helps you negotiate with clear asks.",
  },
];

export function NewBotWizard({ onClose }: { onClose: () => void }) {
  const { dispatch } = useStore();
  const { closeList } = useMobileNav();
  const [name, setName] = useState("New Bot");
  const [color, setColor] = useState<MausColor>("blue");
  const [expression, setExpression] = useState<MausState>("happy");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setName(preset.name);
    setColor(preset.color);
    setExpression(preset.expression);
    setTitle(preset.title);
    setDescription(preset.description);
  };

  const start = () => {
    if (busy) return;
    setBusy(true);
    dispatch({
      type: "newBot",
      draft: {
        name: name.trim() || "New Bot",
        title: title.trim(),
        description: description.trim(),
        color,
        mascotExpression: expression,
      },
    });
    closeList();
    onClose();
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="animate-pop-in flex max-h-[min(94dvh,900px)] w-full flex-col overflow-hidden rounded-t-2xl border border-hairline/50 bg-app shadow-2xl sm:max-h-[88vh] sm:w-[min(720px,100%)] sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-hairline/30 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-5">
          <div className="flex items-center gap-2.5">
            <MausAvatar color={color} state={expression} size={28} animated={false} />
            <span className="text-[15px] font-semibold text-ink">New Bot</span>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8 sm:py-8">
          <div className="mx-auto flex max-w-md flex-col items-center">
            <MausAvatar key={`${color}-${expression}`} color={color} state={expression} size={112} />

            <div className="mt-6 flex flex-wrap justify-center gap-2.5">
              {MAUS_COLOR_NAMES.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={cn(
                    "size-7 rounded-full transition-transform hover:scale-110",
                    color === c && "ring-2 ring-white ring-offset-2 ring-offset-app",
                  )}
                  style={{ backgroundColor: MAUS_COLORS[c] }}
                  title={c}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>

            <div className="mt-5 flex max-w-full gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {PICKABLE_STATES.slice(0, 9).map((state) => (
                <button
                  key={state}
                  onClick={() => setExpression(state)}
                  className={cn(
                    "flex size-12 shrink-0 items-center justify-center rounded-xl bg-card transition-colors hover:bg-raised",
                    expression === state && "ring-2 ring-accent-border",
                  )}
                  title={state}
                  aria-label={`Expression ${state}`}
                >
                  <MausAvatar color={color} state={state} size={36} animated={false} />
                </button>
              ))}
            </div>

            <label className="mt-6 w-full">
              <span className="mb-1.5 block text-[13px] text-ink-secondary">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && start()}
                placeholder="New Bot"
                autoFocus
                className="w-full rounded-xl border border-hairline/40 bg-card px-3.5 py-3 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
              />
            </label>

            <button
              onClick={start}
              disabled={busy}
              className="mt-4 w-full rounded-xl bg-accent py-3 text-[15px] font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              Get started
            </button>
          </div>

          <div className="mx-auto mt-8 max-w-3xl">
            <div className="mb-3 text-[13px] font-medium text-ink-secondary">Suggestions</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => applyPreset(preset)}
                  className="flex items-start gap-3 rounded-xl border border-hairline/40 bg-card px-3.5 py-3 text-left transition-colors hover:bg-raised/60"
                >
                  <MausAvatar color={preset.color} state={preset.expression} size={36} animated={false} />
                  <div className="min-w-0">
                    <div className="text-[14px] font-semibold text-ink">{preset.name}</div>
                    <div className="mt-0.5 text-[12.5px] leading-snug text-ink-secondary">{preset.blurb}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
