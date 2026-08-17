import { X } from "lucide-react";
import { PANEL_SHELL } from "@/lib/panel-shell";

export function PlusGate({ feature }: { feature: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <div className="text-[15px] font-medium text-ink">{feature} is on Aishe Plus</div>
      <p className="max-w-[280px] text-[13px] text-ink-secondary">
        Free includes one bot and chat. Plus adds extra bots, the cloud computer, plugins, routines, and bots
        that can talk to each other.
      </p>
      <a
        href="/api/billing/checkout"
        className="mt-1 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:brightness-110"
      >
        Subscribe — N$350 / month
      </a>
    </div>
  );
}

export function PlusFeaturePanel({
  title,
  feature,
  onClose,
}: {
  title: string;
  feature: string;
  onClose: () => void;
}) {
  return (
    <aside className={PANEL_SHELL}>
      <div className="flex items-center justify-between px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <span className="w-6" />
        <span className="text-[15px] font-semibold text-ink">{title}</span>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>
      <PlusGate feature={feature} />
    </aside>
  );
}
