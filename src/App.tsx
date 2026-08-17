import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import { Loader2 } from "lucide-react";
import { StoreProvider, useStore } from "@/state/store";
import { emailGateDone, initAnalytics } from "@/lib/analytics";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { UpdateBanner } from "@/components/UpdateBanner";
import { MobileNavProvider } from "@/lib/mobile-nav";
import { AuthScreen, type SaasUser } from "@/components/AuthScreen";
import { AccessProvider, useAccess } from "@/lib/access";
import { PlusFeaturePanel, PlusGate } from "@/components/PlusGate";

const Onboarding = lazy(() =>
  import("@/components/Onboarding").then((m) => ({ default: m.Onboarding })),
);
const SettingsPanel = lazy(() =>
  import("@/components/SettingsPanel").then((m) => ({ default: m.SettingsPanel })),
);
const PluginsPanel = lazy(() =>
  import("@/components/PluginsPanel").then((m) => ({ default: m.PluginsPanel })),
);
const ComputerPanel = lazy(() =>
  import("@/components/ComputerPanel").then((m) => ({ default: m.ComputerPanel })),
);
const AppSettingsPanel = lazy(() =>
  import("@/components/AppSettingsPanel").then((m) => ({ default: m.AppSettingsPanel })),
);
const NewBotWizard = lazy(() =>
  import("@/components/NewBotWizard").then((m) => ({ default: m.NewBotWizard })),
);
const SaasOnboarding = lazy(() =>
  import("@/components/SaasOnboarding").then((m) => ({ default: m.SaasOnboarding })),
);
const BillingSuccess = lazy(() =>
  import("@/components/BillingSuccess").then((m) => ({ default: m.BillingSuccess })),
);

function PanelFallback() {
  return (
    <div className="flex h-full w-[min(100%,400px)] shrink-0 items-center justify-center bg-panel text-ink-secondary">
      <Loader2 size={18} className="animate-spin" />
    </div>
  );
}

function lazyPanel<P extends object>(Comp: ComponentType<P>, props: P) {
  return (
    <Suspense fallback={<PanelFallback />}>
      <Comp {...props} />
    </Suspense>
  );
}

function Shell({
  saasMode,
  saasUser,
  onReplayTour,
}: {
  saasMode: boolean;
  saasUser: SaasUser | null;
  onReplayTour?: () => void;
}) {
  const { state, dispatch } = useStore();
  const { plus } = useAccess();
  const bot = state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0];

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("plugins") !== "1" && q.get("status") !== "success") return;
    dispatch({ type: "togglePlugins", open: true });
    q.delete("plugins");
    q.delete("status");
    q.delete("connected_account_id");
    const next = `${window.location.pathname}${q.toString() ? `?${q}` : ""}`;
    window.history.replaceState({}, "", next);
  }, [dispatch]);
  return (
    <div className="flex h-full flex-col">
      <UpdateBanner />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <Sidebar saasMode={saasMode} />
        {bot ? (
          <ChatView bot={bot} />
        ) : (
          <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app px-6 text-center text-ink-secondary">
            {!state.connected ? (
              <>
                <Loader2 size={20} className="animate-spin" />
                <div className="text-[14px]">Connecting to the bot server…</div>
                {!saasMode && (
                  <div className="text-[12px]">
                    Start it with <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="text-[14px] text-ink">No bots yet</div>
                <div className="text-[13px]">Create your first bot to start chatting.</div>
                <button
                  onClick={() => dispatch({ type: "toggleNewBotWizard", open: true })}
                  className="mt-1 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:brightness-110"
                >
                  Create a bot
                </button>
              </>
            )}
          </main>
        )}
        {state.settingsOpen && bot && lazyPanel(SettingsPanel, { bot, saasMode })}
        {state.computerOpen &&
          bot &&
          (saasMode && !plus ? (
            <PlusFeaturePanel
              title="Computer"
              feature="Cloud computer"
              onClose={() => dispatch({ type: "toggleComputer", open: false })}
            />
          ) : (
            lazyPanel(ComputerPanel, { bot, saasMode })
          ))}
        {state.appSettingsOpen &&
          lazyPanel(AppSettingsPanel, { saasUser, onReplayTour })}
        {state.pluginsOpen &&
          (saasMode && !plus ? (
            <div
              className="absolute inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
              onClick={() => dispatch({ type: "togglePlugins", open: false })}
            >
              <div
                className="animate-pop-in w-full rounded-t-2xl border border-hairline/50 bg-panel p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl sm:w-[min(420px,100%)] sm:rounded-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <PlusGate feature="Plugins" />
              </div>
            </div>
          ) : (
            lazyPanel(PluginsPanel, { saasMode })
          ))}
      </div>
      {state.newBotWizardOpen && (
        <Suspense fallback={null}>
          <NewBotWizard onClose={() => dispatch({ type: "toggleNewBotWizard", open: false })} />
        </Suspense>
      )}
    </div>
  );
}

export default function App() {
  const [saasMode, setSaasMode] = useState<boolean | null>(null);
  const [saasUser, setSaasUser] = useState<SaasUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [saasBootError, setSaasBootError] = useState<string | null>(null);
  const [googleAuth, setGoogleAuth] = useState(false);
  const [gated, setGated] = useState(() => !emailGateDone());
  const [showSaasTour, setShowSaasTour] = useState(false);
  const billingSuccess = window.location.pathname === "/billing/success";

  useEffect(() => {
    if (saasUser?.needsOnboarding) setShowSaasTour(true);
  }, [saasUser?.needsOnboarding]);

  useEffect(() => {
    initAnalytics();
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const modeRes = await fetch("/api/saas", { credentials: "include" });
        if (modeRes.ok) {
          if (!alive) return;
          setSaasMode(true);
          setSaasBootError(null);
          const mode = (await modeRes.json().catch(() => ({}))) as {
            googleAuth?: boolean;
            user?: SaasUser | null;
          };
          if (alive) {
            setGoogleAuth(Boolean(mode.googleAuth));
            if (mode.user) setSaasUser(mode.user);
          }
        } else if (modeRes.status === 404) {
          if (alive) setSaasMode(false);
        } else {
          if (alive) {
            setSaasMode(true);
            setSaasBootError("Couldn't reach the cloud API. Check your connection and retry.");
          }
        }
      } catch {
        if (!alive) return;
        try {
          const probe = await fetch("/api/health", { credentials: "include" });
          if (probe.ok) {
            setSaasMode(false);
          } else {
            setSaasMode(true);
            setSaasBootError("Couldn't reach the bot server. Retry in a moment.");
          }
        } catch {
          setSaasMode(true);
          setSaasBootError("Couldn't reach the bot server. Retry in a moment.");
        }
      } finally {
        if (alive) setAuthReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!authReady || saasMode === null) {
    return (
      <div className="flex h-full items-center justify-center bg-app text-ink-secondary">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  if (saasMode && saasBootError && !saasUser) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-app px-6 text-center">
        <div className="text-[14px] text-ink">{saasBootError}</div>
        <button
          onClick={() => window.location.reload()}
          className="rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-white"
        >
          Retry
        </button>
      </div>
    );
  }

  if (saasMode && !saasUser) {
    return <AuthScreen googleAuth={googleAuth} />;
  }

  if (saasMode && billingSuccess && saasUser) {
    return (
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center bg-app text-ink-secondary">
            <Loader2 size={20} className="animate-spin" />
          </div>
        }
      >
        <BillingSuccess
          user={saasUser}
          onContinue={(updated) => {
            setSaasUser(updated);
            window.history.replaceState({}, "", "/");
          }}
        />
      </Suspense>
    );
  }

  return (
    <StoreProvider>
      <AccessProvider saas={saasMode} user={saasUser}>
      <MobileNavProvider>
        <Shell
          saasMode={saasMode}
          saasUser={saasUser}
          onReplayTour={saasMode ? () => setShowSaasTour(true) : undefined}
        />
        {saasMode && showSaasTour && saasUser && (
          <Suspense fallback={null}>
            <SaasOnboarding
              user={saasUser}
              onDone={(updated) => {
                setSaasUser(updated);
                setShowSaasTour(false);
              }}
            />
          </Suspense>
        )}
        {!saasMode && gated && (
          <Suspense fallback={null}>
            <Onboarding onDone={() => setGated(false)} />
          </Suspense>
        )}
      </MobileNavProvider>
      </AccessProvider>
    </StoreProvider>
  );
}
