// Model picker: an instance rail + model list, backed by /api/instances.
// Routing is by exact instanceId only — an entry is never inferred from a
// driver kind, and unavailable instances render disabled with the reason.
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { useStore, type Bot, type InstanceInfo } from "@/state/store";
import { ProviderMark } from "./ProviderIcons";
import { cn } from "@/lib/cn";

function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  return instance?.models.options.find((o) => o.id === model)?.label ?? model;
}

function PickerBody({
  state,
  selection,
  railInstance,
  setRailId,
  pick,
}: {
  state: ReturnType<typeof useStore>["state"];
  selection: Bot["modelSelection"];
  railInstance: InstanceInfo | undefined;
  setRailId: (id: string) => void;
  pick: (instance: InstanceInfo, model: string) => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-1 border-r border-hairline/40 bg-panel p-2">
        {state.instances.map((instance) => {
          const unavailable = instance.snapshot.state !== "available";
          const onRail = instance.instanceId === railInstance?.instanceId;
          return (
            <button
              key={instance.instanceId}
              onClick={() => setRailId(instance.instanceId)}
              title={
                unavailable
                  ? `${instance.displayName} — ${instance.snapshot.reason ?? "unavailable"}`
                  : instance.displayName
              }
              className={cn(
                "flex size-9 items-center justify-center rounded-lg",
                onRail ? "bg-raised" : "hover:bg-raised/60",
                unavailable && "opacity-40",
              )}
            >
              <ProviderMark driverKind={instance.driverKind} size={18} />
            </button>
          );
        })}
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-2">
        {railInstance ? (
          <>
            <div className="px-2 pb-1 pt-1">
              <div className="text-[13px] font-semibold text-ink">{railInstance.displayName}</div>
              <div className="truncate text-[11px] text-ink-secondary">
                {railInstance.snapshot.state === "available"
                  ? (railInstance.snapshot.version ?? "ready")
                  : (railInstance.snapshot.reason ?? "unavailable")}
              </div>
            </div>
            {railInstance.models.options.map((option) => {
              const current =
                selection.instanceId === railInstance.instanceId && selection.model === option.id;
              const disabled = railInstance.snapshot.state !== "available";
              return (
                <button
                  key={option.id}
                  disabled={disabled}
                  onClick={() => pick(railInstance, option.id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2.5 text-left text-[13px] sm:py-1.5",
                    disabled ? "cursor-not-allowed text-ink-secondary/50" : "text-ink hover:bg-raised/60",
                    current && "bg-raised",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{option.label}</span>
                    {option.id === railInstance.models.default && (
                      <span className="shrink-0 rounded bg-inset px-1 py-px text-[10px] text-ink-secondary">
                        default
                      </span>
                    )}
                  </span>
                  {current && <Check size={14} className="shrink-0 text-accent" />}
                </button>
              );
            })}
          </>
        ) : (
          <div className="px-2 py-3 text-[13px] text-ink-secondary">
            No providers — is the server running?
          </div>
        )}
      </div>
    </>
  );
}

export function ModelPicker({ bot, className }: { bot: Bot; className?: string }) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [railId, setRailId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const selection = bot.modelSelection;
  const active = state.instances.find((i) => i.instanceId === selection.instanceId);
  const railInstance =
    state.instances.find((i) => i.instanceId === (railId ?? selection.instanceId)) ??
    state.instances[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (instance: InstanceInfo, model: string) => {
    dispatch({ type: "setModel", botId: bot.id, selection: { instanceId: instance.instanceId, model } });
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        onClick={() => {
          setRailId(selection.instanceId);
          setOpen((o) => !o);
        }}
        className="flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 py-1 pl-2 pr-2.5 text-[13px] text-ink hover:bg-raised"
        title={active ? `${active.displayName} · ${modelLabel(active, selection.model)}` : selection.model}
      >
        {active && <ProviderMark driverKind={active.driverKind} size={14} />}
        <span className="max-w-[min(28vw,160px)] truncate sm:max-w-[160px]">
          {modelLabel(active, selection.model)}
        </span>
        <ChevronDown size={14} className="shrink-0 text-ink-secondary" />
      </button>

      {open && (
        <>
          {/* Mobile: bottom sheet */}
          <div
            className="fixed inset-0 z-50 flex items-end bg-black/40 md:hidden"
            onClick={() => setOpen(false)}
          >
            <div
              data-model-picker-content
              className="animate-pop-in flex max-h-[70vh] w-full flex-col overflow-hidden rounded-t-2xl border border-hairline/50 bg-card pb-[env(safe-area-inset-bottom)] shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-hairline/40 px-4 py-3">
                <span className="text-[15px] font-semibold text-ink">Model</span>
                <button
                  onClick={() => setOpen(false)}
                  className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="flex min-h-0 flex-1 overflow-hidden">
                <PickerBody
                  state={state}
                  selection={selection}
                  railInstance={railInstance}
                  setRailId={setRailId}
                  pick={pick}
                />
              </div>
            </div>
          </div>

          {/* Desktop: anchored dropdown */}
          <div
            data-model-picker-content
            className="absolute right-0 top-full z-30 mt-2 hidden w-[320px] overflow-hidden rounded-xl border border-hairline/50 bg-card shadow-2xl shadow-black/50 md:flex"
          >
            <PickerBody
              state={state}
              selection={selection}
              railInstance={railInstance}
              setRailId={setRailId}
              pick={pick}
            />
          </div>
        </>
      )}
    </div>
  );
}
