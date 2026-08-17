import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { SaasUser } from "./AuthScreen";

export function BillingBanner({
  user,
  onUpdated,
}: {
  user: SaasUser;
  onUpdated: (user: SaasUser) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Soft trial / upgrade nag is off — only show when chat is blocked.
  if (user.canChat) return null;

  const subscribe = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Checkout failed");
      if (data.user) onUpdated(data.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const ends =
    user.subscriptionEndsAt != null
      ? new Date(user.subscriptionEndsAt).toLocaleDateString()
      : null;

  return (
    <div className="border-b border-hairline/40 bg-raised/40 px-4 py-2.5">
      <div className="mx-auto flex max-w-[900px] flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-[13px] text-ink">
          {user.subscriptionStatus === "trialing" ? (
            <>
              <span className="font-medium">Trial ended</span>
              <span className="text-ink-secondary">
                {ends ? ` · ended ${ends}` : ""} · subscribe to keep chatting ({user.plan.priceLabel})
              </span>
            </>
          ) : (
            <>
              <span className="font-medium">Subscription required</span>
              <span className="text-ink-secondary"> · {user.plan.priceLabel} for hosted bots</span>
            </>
          )}
          {error && <div className="text-danger">{error}</div>}
        </div>
        <button
          onClick={() => void subscribe()}
          disabled={busy}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          Subscribe · {user.plan.priceLabel}
        </button>
      </div>
    </div>
  );
}
