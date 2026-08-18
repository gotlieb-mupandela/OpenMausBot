// Connected apps marketplace, backed by Composio Connect. Catalog comes
// from /api/connectors/catalog — the full toolkit list with logos when a
// Composio API key is configured, a curated set otherwise. Icons resolve
// logo → favicon → monogram.
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, X } from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";

interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  domain: string | null;
}

const STATUS_EXTRA_SLUGS = [
  "gmail",
  "github",
  "notion",
  "slack",
  "googlecalendar",
  "whatsapp",
  "discord",
  "telegram",
];

function extraCardDomain(slug: string): string | null {
  if (slug === "gmail") return "gmail.com";
  if (slug.startsWith("whatsapp")) return "whatsapp.com";
  return null;
}

function ServiceIcon({ card }: { card: ToolkitCard }) {
  // 0 = official logo, 1 = favicon by domain, 2 = monogram
  const [stage, setStage] = useState(card.logo ? 0 : card.domain ? 1 : 2);
  if (stage === 0 && card.logo) {
    return <img src={card.logo} alt="" className="size-8 rounded-md" onError={() => setStage(1)} />;
  }
  if (stage === 1 && card.domain) {
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${card.domain}&sz=64`}
        alt=""
        className="size-8 rounded-md"
        onError={() => setStage(2)}
      />
    );
  }
  return (
    <div className="flex size-8 items-center justify-center rounded-md bg-raised text-[13px] font-semibold text-ink-secondary">
      {card.label.slice(0, 1).toUpperCase()}
    </div>
  );
}

export function PluginsPanel({ saasMode = false }: { saasMode?: boolean }) {
  const { dispatch } = useStore();
  const [cards, setCards] = useState<ToolkitCard[] | null>(null);
  const [source, setSource] = useState<"api" | "curated">("curated");
  const [configured, setConfigured] = useState(true);
  const [status, setStatus] = useState<Record<string, { connected: boolean }>>({});
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"marketplace" | "yours">("marketplace");
  const statusRef = useRef(status);
  statusRef.current = status;
  const cardsRef = useRef(cards);
  cardsRef.current = cards;

  const refreshStatus = useCallback((slugs: string[]) => {
    if (!slugs.length) return Promise.resolve();
    setRefreshing(true);
    return api(`/api/connectors?services=${encodeURIComponent(slugs.join(","))}`)
      .then((r) => {
        setError(null);
        setStatus((prev) => ({ ...prev, ...(r.services ?? {}) }));
        if (r.configured === false) setConfigured(false);
        else if (r.configured === true) setConfigured(true);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRefreshing(false));
  }, []);

  const refreshVisible = useCallback(() => {
    const list = cardsRef.current ?? [];
    const slugs = list.map((c) => c.slug).slice(0, 80);
    // Always include common apps so a just-connected Gmail isn't missed
    // when the catalog page is truncated.
    for (const extra of STATUS_EXTRA_SLUGS) {
      if (!slugs.includes(extra)) slugs.push(extra);
    }
    return refreshStatus(slugs);
  }, [refreshStatus]);

  useEffect(() => {
    let alive = true;
    api("/api/connectors/catalog")
      .then((r) => {
        if (!alive) return;
        setCards(r.cards ?? []);
        setSource(r.source ?? "curated");
        setConfigured(Boolean(r.configured));
        if (r.configured) {
          const slugs = (r.cards ?? []).map((c: ToolkitCard) => c.slug).slice(0, 80);
          for (const extra of STATUS_EXTRA_SLUGS) {
            if (!slugs.includes(extra)) slugs.push(extra);
          }
          void refreshStatus(slugs);
        }
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [refreshStatus]);

  useEffect(() => {
    const onFocus = () => {
      if (configured) void refreshVisible();
    };
    const onVis = () => {
      if (document.visibilityState === "visible") onFocus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    const poll = configured
      ? setInterval(() => {
          void refreshVisible();
        }, 20_000)
      : null;
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
      if (poll) clearInterval(poll);
    };
  }, [configured, refreshVisible]);

  const connect = (slug: string) => {
    setBusySlug(slug);
    setError(null);
    api(`/api/connectors/${slug}/authorize`, { method: "POST" })
      .then(({ url }) => {
        window.location.assign(url);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusySlug(null));
  };

  const disconnect = (slug: string) => {
    setBusySlug(slug);
    api(`/api/connectors/${slug}`, { method: "DELETE" })
      .then(() => refreshStatus([slug]))
      .catch((e) => setError(e.message))
      .finally(() => setBusySlug(null));
  };

  const yours = (() => {
    const list = cards ?? [];
    const fromCatalog = list.filter((c) => status[c.slug]?.connected);
    const seen = new Set(fromCatalog.map((c) => c.slug));
    // Connected apps may sit outside the first catalog page — still list them in Yours.
    const extras: ToolkitCard[] = Object.entries(status)
      .filter(([slug, s]) => s.connected && !seen.has(slug))
      .map(([slug]) => ({
        slug,
        label: slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        blurb: "Connected",
        logo: null,
        domain: extraCardDomain(slug),
      }));
    return [...fromCatalog, ...extras];
  })();
  const visible = (tab === "yours" ? yours : cards ?? []).filter(
    (c) => !search || `${c.label} ${c.slug} ${c.blurb}`.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div
      className="absolute inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onClick={() => dispatch({ type: "togglePlugins", open: false })}
    >
      <div
        className="animate-pop-in flex max-h-[min(92dvh,920px)] w-full flex-col rounded-t-2xl border border-hairline/50 bg-panel p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl sm:max-h-[80%] sm:w-[min(640px,100%)] sm:rounded-2xl sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pt-[env(safe-area-inset-top)] sm:pt-0">
          <div className="text-[17px] font-semibold text-ink">Plugins</div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void refreshVisible()}
              className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
              title="Refresh connection status"
            >
              <RefreshCw size={15} className={cn(refreshing && "animate-spin")} />
            </button>
            <button
              onClick={() => dispatch({ type: "togglePlugins", open: false })}
              className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex rounded-lg border border-hairline/40 p-0.5">
            {(["marketplace", "yours"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-[13px] capitalize",
                  tab === t ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
                )}
              >
                {t === "marketplace" ? "Marketplace" : "Yours"}
                {t === "yours" && yours.length > 0 ? ` · ${yours.length}` : ""}
              </button>
            ))}
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search plugins"
            className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </div>

        <div className="mt-2 text-[12px] text-ink-secondary">
          {source === "api" ? "Full catalog" : "Curated apps"} · connections stay on your account
        </div>

        {!configured && (
          <div className="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[13px] text-warning">
            {saasMode ? (
              <>Apps aren&apos;t available right now. You can still chat with your bots.</>
            ) : (
              <>
                Paste a Composio project API key (
                <code className="rounded bg-raised/60 px-1">ak_…</code>) in App Settings to Add apps — from
                Platform → project → Settings → API Keys.{" "}
                <button
                  className="underline"
                  onClick={() => {
                    dispatch({ type: "togglePlugins", open: false });
                    dispatch({ type: "toggleAppSettings", open: true });
                  }}
                >
                  Open App Settings
                </button>
                . Saving applies immediately — no restart.
              </>
            )}
          </div>
        )}

        {error && (
          <div className="mt-2 text-[13px] text-danger">
            {saasMode && /api key|composio|ak_|ck_/i.test(error)
              ? "Couldn't load apps. Try again in a moment."
              : error}
          </div>
        )}

        <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto">
          {cards === null ? (
            <div className="flex justify-center py-10">
              <Loader2 size={18} className="animate-spin text-ink-secondary" />
            </div>
          ) : visible.length === 0 ? (
            <div className="py-8 text-center text-[13px] text-ink-secondary">
              {tab === "yours" ? "No connected apps yet — add some from Marketplace." : "No apps match."}
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {visible.map((card) => {
                const connected = Boolean(status[card.slug]?.connected);
                const busy = busySlug === card.slug;
                return (
                  <div
                    key={card.slug}
                    className="flex items-center gap-3 rounded-xl border border-hairline/40 bg-card px-3 py-3"
                  >
                    <ServiceIcon card={card} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-medium text-ink">{card.label}</div>
                      <div className="line-clamp-2 text-[12px] text-ink-secondary">{card.blurb}</div>
                    </div>
                    <button
                      disabled={!configured || busy}
                      onClick={() => (connected ? disconnect(card.slug) : connect(card.slug))}
                      className={cn(
                        "w-[72px] shrink-0 rounded-lg py-1.5 text-[13px] disabled:opacity-50",
                        connected
                          ? "bg-raised text-ink-secondary hover:text-danger"
                          : "bg-raised text-ink hover:bg-raised-hover",
                      )}
                    >
                      {busy ? (
                        <Loader2 size={13} className="mx-auto animate-spin" />
                      ) : connected ? (
                        "Remove"
                      ) : (
                        "Add"
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
