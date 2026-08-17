// App-level settings, in the right-side slot: who you are + credentials
// shared by all bots. Per-bot settings (name, persona, model, computer)
// live in SettingsPanel; contextual Box-token entry stays in ComputerPanel.
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useStore } from "@/state/store";
import { ApiKeyRow } from "./ApiKeys";
import { useUpdaterState } from "@/lib/updater";
import { PANEL_SHELL } from "@/lib/panel-shell";
import type { SaasUser } from "./AuthScreen";

/** Name + email, persisted to /api/config {profile} on blur. Prefilled from
 * the current config (the values are echoed back — they're not secrets). */
function ProfileFields() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  // adopt late-arriving config exactly once per open (config loads async)
  useEffect(() => {
    setName(state.config?.profile?.name ?? "");
    setEmail(state.config?.profile?.email ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.config?.profile?.name, state.config?.profile?.email]);

  const save = () => {
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
    })
      .then((r) => r.json())
      .then((config) => dispatch({ type: "configStatus", config }))
      .catch(() => {});
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  return (
    <div className="flex flex-col gap-3">
      <input value={name} onChange={(e) => setName(e.target.value)} onBlur={save} placeholder="Your name" className={inputClass} />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={save}
        placeholder="you@example.com"
        className={inputClass}
      />
    </div>
  );
}

/** Manual update check row — packaged app only (no bridge in dev). */
function UpdatesRow() {
  const s = useUpdaterState();
  if (!window.ogb?.updater) return null;
  const updater = window.ogb.updater;
  const label =
    s?.status === "checking"
      ? "Checking…"
      : s?.status === "available"
        ? `${s.version} available`
        : s?.status === "downloading"
          ? `Downloading… ${Math.round(s.percent ?? 0)}%`
          : s?.status === "downloaded"
            ? `${s.version} ready — restart to apply`
            : s?.status === "error"
              ? `Check failed: ${s.message ?? "unknown error"}`
              : "You're on the latest version we know of.";
  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">App updates</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{label}</div>
      <div className="mt-3 flex gap-2">
        {s?.status === "available" ? (
          <button
            onClick={() => void updater.download()}
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white"
          >
            Download
          </button>
        ) : s?.status === "downloaded" ? (
          <button
            onClick={() => void updater.install()}
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white"
          >
            Restart to update
          </button>
        ) : (
          <button
            onClick={() => void updater.check()}
            disabled={s?.status === "checking" || s?.status === "downloading"}
            className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40"
          >
            Check for updates
          </button>
        )}
      </div>
    </div>
  );
}

export function AppSettingsPanel({
  saasUser,
  onSaasUser,
}: {
  saasUser?: SaasUser | null;
  onSaasUser?: (user: SaasUser) => void;
}) {
  const { dispatch } = useStore();
  const [billingBusy, setBillingBusy] = useState(false);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    window.location.reload();
  };

  const activate = async () => {
    setBillingBusy(true);
    try {
      const res = await fetch("/api/billing/checkout", { method: "POST", credentials: "include" });
      const data = await res.json();
      if (res.ok && data.user) onSaasUser?.(data.user);
    } finally {
      setBillingBusy(false);
    }
  };

  return (
    <aside className={PANEL_SHELL}>
      <div className="flex items-center justify-between px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <span className="w-6" />
        <span className="text-[15px] font-semibold text-ink">App Settings</span>
        <button
          onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-5 sm:pb-5">
        <div className="mt-2 rounded-xl bg-card p-4">
          <div className="text-[15px] font-medium text-ink">Profile</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">Shown in the sidebar. Saved as you go.</div>
          <div className="mt-4">
            <ProfileFields />
          </div>
        </div>

        {saasUser ? (
          <>
            <div className="mt-4 rounded-xl bg-card p-4">
              <div className="text-[15px] font-medium text-ink">Subscription</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {saasUser.plan.name} · {saasUser.plan.priceLabel} · {saasUser.subscriptionStatus}
                {saasUser.subscriptionEndsAt
                  ? ` · until ${new Date(saasUser.subscriptionEndsAt).toLocaleDateString()}`
                  : ""}
              </div>
              <p className="mt-2 text-[13px] text-ink-secondary">
                Models are hosted for you — no API keys to manage. Stripe Checkout plugs in when
                STRIPE_SECRET_KEY is set.
              </p>
              <button
                onClick={() => void activate()}
                disabled={billingBusy || saasUser.subscriptionStatus === "active"}
                className="mt-3 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
              >
                {saasUser.subscriptionStatus === "active" ? "Active" : `Activate · ${saasUser.plan.priceLabel}`}
              </button>
            </div>
            <div className="mt-4 rounded-xl bg-card p-4">
              <div className="text-[15px] font-medium text-ink">Account</div>
              <div className="mt-0.5 truncate text-[13px] text-ink-secondary">{saasUser.email}</div>
              <button
                onClick={() => void logout()}
                className="mt-3 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
              >
                Log out
              </button>
            </div>
            <div className="mt-4 rounded-xl bg-card p-4">
              <div className="text-[15px] font-medium text-ink">Plugins</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                Paste your Composio project API key (
                <code className="rounded bg-raised px-1">ak_…</code>) from Platform → project → Settings →
                API Keys — enough to Add apps. Optional: Connect key (
                <code className="rounded bg-raised px-1">ck_…</code>) from sidebar{" "}
                <span className="font-medium">Install</span> (aka AI Clients) → your client → Your API Key.
                Saving applies immediately (no restart).
              </div>
              <div className="mt-4 flex flex-col gap-4">
                <ApiKeyRow
                  section="composioApi"
                  label="Composio API key (Add apps + catalog)"
                  placeholder="ak_… from Platform → Settings → API Keys"
                />
                <ApiKeyRow
                  section="composio"
                  label="Composio Connect key (optional, agent MCP tools)"
                  placeholder="ck_… from Install / AI Clients"
                />
              </div>
            </div>
          </>
        ) : (
          <div className="mt-4 rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">Connections</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              Shared by all bots. Saving a key reloads providers instantly; keys are stored locally and never
              shown again. For plugins, <code className="rounded bg-raised px-1">ak_…</code> alone is enough
              to Add apps.
            </div>
            <div className="mt-4 flex flex-col gap-4">
              <ApiKeyRow section="ollama" label="Ollama Cloud API key" placeholder="Key from ollama.com/settings/keys" />
              <ApiKeyRow
                section="composioApi"
                label="Composio API key (Add apps + catalog)"
                placeholder="ak_… from Platform → Settings → API Keys"
              />
              <ApiKeyRow
                section="composio"
                label="Composio Connect key (optional, agent MCP tools)"
                placeholder="ck_… from Install / AI Clients"
              />
              <ApiKeyRow section="box" label="Box token" placeholder="Token from box.ascii.dev" />
            </div>
          </div>
        )}

        <UpdatesRow />
      </div>
    </aside>
  );
}
