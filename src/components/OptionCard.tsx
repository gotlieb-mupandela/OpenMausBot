import { memo, useState } from "react";
import { Check, X } from "lucide-react";
import { useStore, type Message } from "@/state/store";
import { cn } from "@/lib/cn";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

export const OptionCard = memo(function OptionCard({
  botId,
  message,
}: {
  botId: string;
  message: Message;
}) {
  const { dispatch } = useStore();
  const [custom, setCustom] = useState("");
  const card = message.card;
  if (!card || card.dismissed) return null;

  const answer = (text: string) => {
    if (!text.trim()) return;
    dispatch({ type: "answerCard", botId, messageId: message.id, answer: text.trim() });
  };

  // Settled cards shrink to a one-liner so onboarding / approvals don't
  // dominate the viewport above a long computer-use transcript.
  if (card.answered) {
    return (
      <div className="flex w-full max-w-[840px] items-center gap-2 rounded-xl border border-hairline/40 bg-raised/40 px-3 py-2 text-[13px] text-ink-secondary">
        <Check size={14} className="shrink-0 text-success" />
        <span className="min-w-0 truncate">
          <span className="font-medium text-ink">{card.title}</span>
          <span className="mx-1.5 text-ink-secondary/60">·</span>
          {card.answered}
        </span>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[840px] shrink-0 rounded-2xl border border-hairline/50 bg-card p-3.5 sm:p-4">
      <div className="flex items-start justify-between gap-3 sm:gap-4">
        <div>
          <div className="text-[16px] font-semibold text-ink">{card.title}</div>
          <div className="mt-0.5 text-[14px] text-ink-secondary">{card.subtitle}</div>
        </div>
        <button
          onClick={() => dispatch({ type: "dismissCard", botId, messageId: message.id })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      <div className="mt-3 overflow-hidden rounded-xl border border-hairline/40">
        {card.options.map((opt, i) => (
          <button
            key={opt}
            onClick={() => answer(opt)}
            className={cn(
              "flex w-full items-start gap-3 px-3 py-3 text-left text-[15px] text-ink hover:bg-raised/60",
              i > 0 && "border-t border-hairline/40",
            )}
          >
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-raised text-[12px] font-medium text-ink-secondary">
              {LETTERS[i]}
            </span>
            <span className="min-w-0 flex-1 break-words">{opt}</span>
          </button>
        ))}
      </div>

      <input
        value={custom}
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && answer(custom)}
        placeholder="Type your own answer"
        className="mt-3 w-full rounded-xl border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
      />
    </div>
  );
});
