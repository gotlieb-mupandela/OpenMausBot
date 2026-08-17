import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { StoreProvider, useStore } from "@/state/store";
import { Onboarding } from "@/components/Onboarding";
import { emailGateDone, initAnalytics } from "@/lib/analytics";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { SettingsPanel } from "@/components/SettingsPanel";
import { PluginsPanel } from "@/components/PluginsPanel";
import { ComputerPanel } from "@/components/ComputerPanel";
import { AppSettingsPanel } from "@/components/AppSettingsPanel";
import { UpdateBanner } from "@/components/UpdateBanner";
import { MobileNavProvider } from "@/lib/mobile-nav";
import { AuthScreen, type SaasUser } from "@/components/AuthScreen";
import { BillingBanner } from "@/components/BillingBanner";
import { NewBotWizard } from "@/components/NewBotWizard";

function Shell({
  saasMode,
  saasUser,
  onSaasUser,
}: {
  saasMode: boolean;
  saasUser: SaasUser | null;
  onSaasUser: (u: SaasUser) => void;
}) {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0];
  return (
    <div className="flex h-full flex-col">
      <UpdateBanner />
      {saasUser && <BillingBanner user={saasUser} onUpdated={onSaasUser} />}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <Sidebar saasMode={saasMode} />
        {bot ? (
          <ChatView bot={bot} canChat={saasUser ? saasUser.canChat : true} />
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
        {state.settingsOpen && bot && <SettingsPanel bot={bot} saasMode={saasMode} />}
        {state.computerOpen && bot && <ComputerPanel bot={bot} saasMode={saasMode} />}
        {state.appSettingsOpen && <AppSettingsPanel saasUser={saasUser} onSaasUser={onSaasUser} />}
        {state.pluginsOpen && <PluginsPanel saasMode={saasMode} />}
      </div>
      {state.newBotWizardOpen && (
        <NewBotWizard onClose={() => dispatch({ type: "toggleNewBotWizard", open: false })} />
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
          const mode = (await modeRes.json().catch(() => ({}))) as { googleAuth?: boolean };
          if (alive) setGoogleAuth(Boolean(mode.googleAuth));
          const me = await fetch("/api/auth/me", { credentials: "include" });
          if (me.ok) {
            const data = await me.json();
            if (alive) setSaasUser(data.user);
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
        // No proxy / harness down: treat as SaaS outage when Vite still proxies,
        // otherwise desktop. Prefer retry UI over flashing desktop onboarding.
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
    return <AuthScreen onAuthed={setSaasUser} googleAuth={googleAuth} />;
  }

  return (
    <StoreProvider>
      <MobileNavProvider>
        <Shell saasMode={saasMode} saasUser={saasUser} onSaasUser={setSaasUser} />
        {!saasMode && gated && <Onboarding onDone={() => setGated(false)} />}
      </MobileNavProvider>
    </StoreProvider>
  );
}
