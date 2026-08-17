import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { MausAvatar } from "./Avatar";
import type { SaasUser } from "./AuthScreen";

export function BillingSuccess({
  user,
  onContinue,
}: {
  user: SaasUser;
  onContinue: (user: SaasUser) => void;
}) {
  const [latest, setLatest] = useState(user);
  const plus = Boolean(latest.plus);

  useEffect(() => {
    if (plus) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/auth/me", { credentials: "include" });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { user?: SaasUser };
        if (data.user && alive) setLatest(data.user);
      } catch {
        /* webhook may still be in flight */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1500);
    const stop = window.setTimeout(() => window.clearInterval(id), 45_000);
    return () => {
      alive = false;
      window.clearInterval(id);
      window.clearTimeout(stop);
    };
  }, [plus]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-app p-0 sm:items-center sm:p-4">
      <div className="my-auto flex w-full max-w-[420px] flex-col rounded-t-2xl border border-hairline/40 bg-panel p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:rounded-2xl sm:p-8">
        <div className="flex flex-col items-center text-center">
          <MausAvatar color="blue" state="happy" size={64} />
          <h1 className="mt-4 text-[22px] font-semibold text-ink">
            {plus ? "You're on Aishe Plus" : "Payment received"}
          </h1>
          <p className="mt-1.5 text-[14px] text-ink-secondary">
            {plus
              ? "N$350 / month. Thanks — Plus is active on this account."
              : "Polar confirmed the checkout. Waiting for Plus to activate on your account…"}
          </p>
          {!plus && <Loader2 size={18} className="mt-4 animate-spin text-ink-secondary" />}
        </div>
        <button
          onClick={() => onContinue(latest)}
          className="mt-6 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white hover:brightness-110"
        >
          Continue to Aishe
        </button>
      </div>
    </div>
  );
}
