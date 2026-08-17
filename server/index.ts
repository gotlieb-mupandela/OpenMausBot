// Aishe server — the harness host. Clients hold no transports
// (upstream rule): the React app dispatches typed commands over HTTP and
// folds one SSE event stream; every provider process runs here.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as box from "./box.ts";
import * as composio from "./composio.ts";
import { ensureDirs, instanceConfigs, loadConfig, saveConfig, EVENTS_DIR, NATIVE_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";

import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { EventBus } from "./harness/bus.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { mentionedBots, type Message } from "./store.ts";
import { SAAS_MODE, SAAS_HOST } from "./saas/mode.ts";
import { MAX_MESSAGES_PER_THREAD, trimThreadMessages, turnGate } from "./saas/capacity.ts";
import * as auth from "./saas/auth.ts";
import * as google from "./saas/google.ts";
import * as polar from "./saas/polar.ts";
import { TenantStores } from "./saas/tenants.ts";
import * as routines from "./saas/routines.ts";
import { FREE_BOT_LIMIT, plusRequiredPayload, plusUnlocked } from "./saas/plan.ts";

const PORT = Number(process.env.OMB_PORT || process.env.OGB_PORT || 8799);
const STATIC_DIR = process.env.OMB_STATIC_DIR || null;
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

ensureDirs();
const cfg = loadConfig();
const registry = new ProviderRegistry(BUILT_IN_DRIVERS);
await registry.load(instanceConfigs(cfg));

const bus = new EventBus();
bus.attach(registry.instances());

// ── peer-agent comms wiring ────────────────────────────────────────────
// A shared secret guards the localhost-only /api/internal endpoints the
// agents-proxy calls; regenerated each boot (the proxy gets it via env).
const COMMS_TOKEN = randomBytes(24).toString("hex");
// Cap message chains: depth 0 = a user-initiated turn (may ask a peer);
// a peer invoked via ask_bot runs at depth 1 and gets NO agents tool, so
// A→B is allowed but B→C (and A→B→A loops) never start.
const MAX_COMMS_DEPTH = 1;
/** Cancel in-flight startTurn prep (labels / box) when the user hits Stop. */
const turnDispatchAborts = new Map<string, AbortController>();
// proxy entry: .ts in dev (node type-strips), .js in the packaged dist-server
const agentsProxyPath = (() => {
  const ts = join(dirname(fileURLToPath(import.meta.url)), "drivers", "agents-proxy.ts");
  return existsSync(ts) ? ts : ts.replace(/\.ts$/, ".js");
})();
// in the packaged app process.execPath is Electron — run the proxy as node
const AGENTS_NODE_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

function agentsIntegration(botId: string, depth: number) {
  return {
    command: process.execPath,
    args: [agentsProxyPath],
    env: {
      ...AGENTS_NODE_FLAG,
      OMB_HARNESS_URL: `http://127.0.0.1:${PORT}`,
      OMB_BOT_ID: botId,
      OMB_COMMS_TOKEN: COMMS_TOKEN,
      OMB_TURN_DEPTH: String(depth),
    },
  };
}

/** Run a turn on `targetBotId` and resolve with its assistant text — the
 * synchronous half of ask_bot. Subscribes to the bus, folds assistant_text
 * for that thread, resolves on turn.completed (or a 4-min ceiling). */
function askBotAndWait(targetBotId: string, message: string, depth: number): Promise<string> {
  const store = storeForBot(targetBotId);
  const target = store?.bot(targetBotId);
  if (!target || !store) return Promise.resolve("(no such bot)");
  const threadId = target.threadId;
  return new Promise((resolve) => {
    let text = "";
    let done = false;
    const finish = (out: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve(out);
    };
    const unsub = bus.subscribe((e: RuntimeEvent) => {
      if (e.threadId !== threadId) return;
      if (e.type === "item.completed" && e.itemType === "assistant_text") {
        text += (text ? "\n" : "") + e.text;
      } else if (e.type === "turn.completed") {
        finish(text || "(the bot finished without a text reply)");
      }
    });
    const timer = setTimeout(() => finish(text || "(timed out waiting for the bot to reply)"), 4 * 60_000);
    startTurn(targetBotId, message, { commsDepth: depth + 1 }).catch((err) =>
      finish(`(couldn't start that bot: ${err instanceof Error ? err.message : String(err)})`),
    );
  });
}

// default selection for new bots: prefer cloud API providers that are ready,
// then Claude CLI, then whatever else is available
async function defaultSelection() {
  const described = await registry.describe();
  const available = described.filter((d) => d.snapshot.state === "available");
  const pick =
    available.find((d) => d.driverKind === "ollama") ??
    available.find((d) => d.driverKind === "grok") ??
    available.find((d) => d.driverKind === "claudeAgent") ??
    available[0] ??
    described[0];
  return {
    instanceId: pick?.instanceId ?? "ollama",
    model: pick?.models.default || "gpt-oss:120b",
  };
}
let bootSelection = { instanceId: "ollama", model: "gpt-oss:120b" };
const tenants = new TenantStores(() => bootSelection);
bootSelection = await defaultSelection();
const desktopStore = tenants.desktop();
if (!SAAS_MODE) desktopStore.seedIfEmpty();

function storeForBot(botId: string) {
  if (!SAAS_MODE) return desktopStore;
  return tenants.findByBotId(botId)?.store ?? null;
}

function ownerForThread(threadId: string) {
  if (!SAAS_MODE) return { userId: "__desktop__", store: desktopStore };
  return tenants.findByThread(threadId);
}

// ── SSE fan-out to clients (scoped per user in SaaS) ───────────────────
const sseClients = new Map<string, Set<ServerResponse>>();
function broadcastTo(userId: string, payload: unknown) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  const set = sseClients.get(userId);
  if (!set) return;
  for (const res of [...set]) {
    try {
      res.write(frame);
      // Node / some proxies buffer until flush — keep EventSource live.
      const flushable = res as ServerResponse & { flush?: () => void };
      flushable.flush?.();
    } catch {
      set.delete(res);
    }
  }
}

// ── server-side event folding (upstream's ingestion worker, miniature) ──
// The canonical stream is the source of truth; the persisted transcript
// and every client view are projections of it.
const toolMessageByItem = new Map<string, string>(); // itemId -> messageId
const askMessageByRequest = new Map<string, string>(); // requestId -> messageId

bus.subscribe((event: RuntimeEvent) => {
  const owned = ownerForThread(event.threadId);
  if (!owned) return;
  const { userId, store } = owned;
  const broadcast = (payload: unknown) => broadcastTo(userId, payload);
  broadcast({ kind: "runtime", event });
  const bot = store.botByThread(event.threadId);
  if (!bot) return;

  const pushMessage = (m: Omit<Message, "id" | "at">) => {
    const message = store.appendMessage(event.threadId, m);
    broadcast({ kind: "message", threadId: event.threadId, message });
    return message;
  };

  switch (event.type) {
    case "session.started":
      if (event.sessionId && event.providerInstanceId) {
        store.setResumeCursor(bot.id, event.providerInstanceId, event.sessionId);
      }
      break;
    case "item.completed":
      if (event.itemType === "assistant_text") {
        pushMessage({ role: "bot", kind: "text", text: event.text });
      } else if (event.itemType === "tool" && event.itemId) {
        const messageId = toolMessageByItem.get(event.itemId);
        if (messageId) {
          const patched = store.patchMessage(event.threadId, messageId, {
            tool: { name: store.messagesFor(event.threadId).find((m) => m.id === messageId)?.tool?.name ?? "tool", ok: event.ok },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
          toolMessageByItem.delete(event.itemId);
        }
        // the bot just finished acting — refresh its screen preview now
        pokeScreenPoller(bot.id);
      }
      break;
    case "item.started":
      if (event.itemType === "tool") {
        const message = pushMessage({ role: "bot", kind: "activity", tool: { name: event.title ?? "tool" } });
        if (event.itemId) toolMessageByItem.set(event.itemId, message.id);
      }
      break;
    case "request.opened": {
      const permission = event.requestType === "permission";
      const message = pushMessage({
        role: "bot",
        kind: "options",
        card: {
          title: permission ? "Approval needed" : "Your bot has a question",
          subtitle: event.summary,
          options: event.choices?.length ? event.choices : permission ? ["Allow", "Deny"] : [],
          requestId: event.requestId,
        },
      });
      if (event.requestId) askMessageByRequest.set(event.requestId, message.id);
      break;
    }
    case "request.resolved": {
      const messageId = event.requestId ? askMessageByRequest.get(event.requestId) : null;
      if (messageId) {
        const existing = store.messagesFor(event.threadId).find((m) => m.id === messageId);
        if (existing?.card && !existing.card.answered) {
          const patched = store.patchMessage(event.threadId, messageId, {
            card: { ...existing.card, answered: event.behavior, dismissed: event.source !== "user" },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
        }
        if (event.requestId) askMessageByRequest.delete(event.requestId);
      }
      break;
    }
    case "runtime.error":
      pushMessage({ role: "bot", kind: "activity", tool: { name: `error: ${event.message.slice(0, 160)}`, ok: false } });
      break;
    case "turn.completed": {
      // the last live frame becomes a settled inline screen message —
      // the screenshot-in-chat moment
      const frame = stopScreenPoller(bot.id);
      if (frame) pushMessage({ role: "bot", kind: "screen", png: frame.png, mime: frame.mime });
      store.patchBot(bot.id, { busy: false, unread: true });
      turnGate.release(bot.id, userId);
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
      break;
    }
  }
});

function boxOwnerFor(userId: string | null | undefined, botId: string): box.BoxOwner {
  if (SAAS_MODE && userId && userId !== "__desktop__") return { kind: "user", userId };
  return { kind: "bot", botId };
}

// ── live screen: poll the owner's box while the bot works ─────────────
type Frame = { png: string; mime: string };
const screenPollers = new Map<
  string,
  { timer: ReturnType<typeof setInterval>; capture: () => Promise<void>; last: Frame | null; userId: string }
>();

function startScreenPoller(botId: string, owner: box.BoxOwner, userId: string) {
  if (screenPollers.has(botId) || !box.boxConfigured(cfg)) return;
  let inFlight = false;
  const capture = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const { png } = await box.screenshotBox(cfg, owner);
      const frame = { png, mime: "image/png" as const };
      entry.last = frame;
      broadcastTo(userId, { kind: "screen", botId, ...frame });
    } catch {
      /* box asleep or mid-command — try again next tick */
    } finally {
      inFlight = false;
    }
  };
  const entry = {
    timer: setInterval(capture, 4000),
    capture,
    last: null as Frame | null,
    userId,
  };
  screenPollers.set(botId, entry);
}

/** Event-driven refresh: capture NOW (the bot just acted on its screen)
 * instead of waiting for the next interval tick. */
function pokeScreenPoller(botId: string) {
  void screenPollers.get(botId)?.capture();
}

function stopScreenPoller(botId: string): Frame | null {
  const entry = screenPollers.get(botId);
  if (!entry) return null;
  clearInterval(entry.timer);
  screenPollers.delete(botId);
  return entry.last;
}

tenants.setHooks({
  isPinned: (userId) => (sseClients.get(userId)?.size ?? 0) > 0,
  onEvict: (_userId, store) => {
    for (const b of store.bots) stopScreenPoller(b.id);
  },
});

// Local computer-use contract written by Electron main on startup
// (~/Library/Application Support/Aishe/cua-connection.json). Read
// fresh each turn — Electron may restart or permissions may change.
function readCuaConnection(): { command: string; args: string[]; env: Record<string, string> } | null {
  // new name first; pre-rename desktop builds used the old directory
  for (const dir of ["Aishe", "aishe", "OpenMausBot", "openmausbot", "OpenGrokBot", "opengrokbot"]) {
    try {
      const p = join(homedir(), "Library", "Application Support", dir, "cua-connection.json");
      const conn = JSON.parse(readFileSync(p, "utf8"));
      if (!conn || conn.mode === "unavailable" || !conn.mcpCommand) continue;
      return { command: conn.mcpCommand, args: conn.mcpArgs ?? ["mcp"], env: conn.mcpEnv ?? {} };
    } catch {
      /* try the next location */
    }
  }
  return null;
}

// ── turn dispatch (upstream ProviderCommandReactor, miniature) ──────────
async function startTurn(botId: string, text: string, opts?: { commsDepth?: number; userId?: string }) {
  const owned =
    opts?.userId && opts.userId !== "__desktop__"
      ? { userId: opts.userId, store: await tenants.touch(opts.userId) }
      : opts?.userId === "__desktop__" || !SAAS_MODE
        ? { userId: "__desktop__", store: desktopStore }
        : tenants.findByBotId(botId);
  const store = owned?.store;
  if (!store) throw Object.assign(new Error("no such bot"), { status: 404 });
  const userId = owned!.userId;
  const broadcast = (payload: unknown) => broadcastTo(userId, payload);
  const bot = store.bot(botId);
  if (!bot) throw Object.assign(new Error("no such bot"), { status: 404 });
  if (bot.busy) throw Object.assign(new Error("the bot is already working — interrupt it first"), { status: 409 });
  const commsDepth = opts?.commsDepth ?? 0;

  const instance = registry.get(bot.modelSelection.instanceId);
  if (!instance) {
    throw Object.assign(
      new Error(`provider instance "${bot.modelSelection.instanceId}" is unavailable — pick another model in settings`),
      { status: 409 },
    );
  }
  const slot = turnGate.tryAcquire(userId, bot.id);
  if (!slot.ok) throw Object.assign(new Error(slot.error), { status: slot.status });

  const userMessage = store.appendMessage(bot.threadId, { role: "user", kind: "text", text });
  broadcast({ kind: "message", threadId: bot.threadId, message: userMessage });
  // Returned to the HTTP caller so the UI can paint the bubble even if SSE lags.

  // transcript for API-backed drivers: settled text turns only
  const transcript = store
    .messagesFor(bot.threadId)
    .filter((m) => m.kind === "text" && m.text && m.id !== userMessage.id)
    .slice(-40)
    .map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), text: m.text! }));

  const persona = [
    `You are ${bot.name}, a personal bot in Aishe.`,
    bot.title && `Role: ${bot.title}.`,
    bot.description && `About: ${bot.description}`,
  ]
    .filter(Boolean)
    .join(" ");

  // busy flips immediately so the composer locks; the dispatch itself runs
  // in the background — box provisioning can take ~90s and must never
  // hang the HTTP request
  store.patchBot(bot.id, { busy: true, unread: false });
  broadcast({ kind: "bot", bot: store.bot(bot.id) });

  turnDispatchAborts.get(bot.id)?.abort();
  const dispatchAbort = new AbortController();
  turnDispatchAborts.set(bot.id, dispatchAbort);

  void (async () => {
    try {
      if (dispatchAbort.signal.aborted) return;

      let plus = !SAAS_MODE || userId === "__desktop__";
      if (!plus) plus = plusUnlocked(await auth.findUserById(userId));

      const light = composio.isLightChatTurn(text);
      const recentUserTexts = transcript
        .filter((m) => m.role === "user")
        .map((m) => m.text)
        .slice(-8);
      const pluginIntent = plus ? composio.resolvePluginIntent(text, recentUserTexts) : null;
      const explicitComputer = plus && composio.messageNeedsComputer(text);

      // Resolve connected apps early so email/calendar turns can skip the desktop.
      let connectedSlugs: string[] = [];
      if (plus && composio.connectorsConfigured(cfg) && !light) {
        connectedSlugs = await Promise.race([
          composio
            .listConnectedToolkitSlugs(cfg, SAAS_MODE && userId !== "__desktop__" ? userId : undefined)
            .catch((e) => {
              console.warn("[composio] connected slugs:", e instanceof Error ? e.message : e);
              return [] as string[];
            }),
          new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 4_000)),
        ]);
      }
      if (dispatchAbort.signal.aborted) return;

      const pluginCoversIntent = Boolean(pluginIntent && connectedSlugs.includes(pluginIntent));
      // Plugin intents (email/calendar/youtube/…) never get a computer session unless the
      // user explicitly asks for desktop/browser — otherwise GPT-OSS opens Chrome
      // (jina.ai / "Choose your search engine") instead of Composio tools.
      const omitComputerForPlugin =
        Boolean(pluginIntent) && !explicitComputer && instance.driverKind !== "boxAgent";
      // SaaS: only attach the shared VM when the user asks for computer/desktop work.
      // Auto-attaching on every cloud-bot turn caused LIVE DESKTOP on calendar/email typos.
      const needsComputer =
        instance.driverKind === "boxAgent" ||
        explicitComputer ||
        (!SAAS_MODE && !light && !omitComputerForPlugin && bot.computer === "cloud");

      const integrations: NonNullable<Parameters<typeof instance.adapter.sendTurn>[0]["integrations"]> = {};
      // Attach Composio whenever ck_ and/or ak_ is configured (ak_-only uses Platform tools).
      // Light greetings still get the integration stub — Ollama skips tool listing for light turns.
      if (plus && composio.connectorsConfigured(cfg)) {
        integrations.composio = {
          key: composio.resolveConnectKey(cfg),
          url: cfg.composio?.url,
          apiKey: composio.resolveApiKey(cfg),
          ...(SAAS_MODE && userId !== "__desktop__" ? { userId } : {}),
          ...(pluginIntent ? { preferToolkit: pluginIntent } : {}),
        };
        if (omitComputerForPlugin) {
          console.log(
            `[turn] omitting computer for ${pluginIntent} intent (connected=${pluginCoversIntent ? "yes" : connectedSlugs.join(",") || "none"})`,
          );
        }
      }
      const wants = bot.computer; // 'cloud' | 'local' | 'off' | undefined(auto)
      const owner = boxOwnerFor(userId, bot.id);
      const canUseComputerTools =
        instance.adapter.capabilities.toolsInProcess === true ||
        instance.driverKind === "claudeAgent" ||
        instance.driverKind === "boxAgent";

      // Never block chat on Box provision for messages that don't need a computer.
      // Attach existing boxes only when this turn actually needs desktop tools.
      if (plus && wants !== "off" && wants !== "local" && box.boxConfigured(cfg) && needsComputer) {
        let b = await box.findBox(cfg, owner).catch(() => null);
        if (dispatchAbort.signal.aborted) return;
        const shouldAutoProvision =
          !b &&
          needsComputer &&
          (instance.driverKind === "boxAgent" || (SAAS_MODE && canUseComputerTools));
        let computerError: string | null = null;
        if (shouldAutoProvision) {
          broadcast({ kind: "computer", botId: bot.id, state: "provisioning" });
          try {
            await box.provisionBox(cfg, owner, SAAS_MODE ? "Team" : bot.name);
          } catch (e) {
            computerError = e instanceof Error ? e.message : String(e);
            console.warn("[computer] provision failed:", computerError);
            if (!SAAS_MODE && instance.driverKind === "boxAgent") throw e;
          }
          if (dispatchAbort.signal.aborted) return;
          b = await box.findBox(cfg, owner).catch(() => null);
        } else if (b && !["idle", "ready", "running"].includes(String(b.state))) {
          try {
            await box.joinBox(cfg, owner);
            b = await box.findBox(cfg, owner).catch(() => null);
          } catch (e) {
            computerError = e instanceof Error ? e.message : String(e);
            console.warn("[computer] wake failed:", computerError);
          }
        }
        if (dispatchAbort.signal.aborted) return;
        // Attach computer tools only when the turn needs them — otherwise GPT-OSS
        // runs a non-streaming tool round for "hi" and appears hung.
        if (b && cfg.box?.token) {
          integrations.computer = { boxId: b.id, token: cfg.box.token };
        } else if (canUseComputerTools && !computerError) {
          computerError =
            "cloud computer is not available right now — open Computer and retry, or check BOX_TOKEN / Box billing";
        }
        if (computerError && canUseComputerTools && !integrations.computer) {
          const notice = store.appendMessage(bot.threadId, {
            role: "bot",
            kind: "activity",
            tool: { name: `computer: ${computerError.slice(0, 140)}`, ok: false },
          });
          broadcast({ kind: "message", threadId: bot.threadId, message: notice });
        }
      }
      // local computer (this Mac) via the Electron-hosted cua-driver: the
      // Electron main process owns the daemon (TCC attribution) and writes
      // its spawn contract to cua-connection.json; the harness only reads it
      if (plus && !integrations.computer && needsComputer && wants !== "off" && wants !== "cloud") {
        const cua = readCuaConnection();
        if (cua) integrations.localComputer = cua;
      }
      // peer-agent comms: give a user-initiated turn the list_bots/ask_bot
      // tools. A comms-invoked turn (depth ≥ cap) gets none — hard recursion
      // stop, so the user's tokens can't be burned by a bot-to-bot loop.
      // Only drivers that mount the tools get the integration (and, via the
      // integrations.agents gate below, the prompt hint) — a bot on a driver
      // without it must not be told about tools it cannot call. Any bot can
      // still be the TARGET of ask_bot regardless of its driver.
      if (
        plus &&
        commsDepth < MAX_COMMS_DEPTH &&
        instance.adapter.capabilities.agentsMcp === true &&
        store.bots.filter((b) => b.id !== bot.id && !b.hidden).length > 0
      ) {
        integrations.agents = agentsIntegration(bot.id, commsDepth);
      }
      // @mentions in the user's message (the composer's tagging UI) become
      // an explicit delegation nudge — the agent still does the ask_bot call
      // itself, so the harness stays the single owner of turns/permissions
      const tagged = integrations.agents
        ? mentionedBots(
            text,
            store.bots.filter((b) => b.id !== bot.id),
          )
        : [];

      let connectedLabels: string[] = [];
      if (integrations.composio && !light) {
        if (connectedSlugs.length) {
          connectedLabels = connectedSlugs
            .map((slug) => {
              const curated = (
                [
                  ["gmail", "Gmail"],
                  ["googlecalendar", "Google Calendar"],
                  ["slack", "Slack"],
                  ["github", "GitHub"],
                  ["notion", "Notion"],
                  ["googlesheets", "Google Sheets"],
                  ["googledocs", "Google Docs"],
                  ["googledrive", "Google Drive"],
                ] as const
              ).find(([s]) => s === slug);
              return curated?.[1] ?? slug;
            })
            .sort((a, b) => a.localeCompare(b));
        } else {
          connectedLabels = await Promise.race([
            composio.listConnectedToolkitLabels(cfg, integrations.composio.userId ?? userId).catch((e) => {
              console.warn("[composio] connected labels:", e instanceof Error ? e.message : e);
              return [] as string[];
            }),
            new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 4_000)),
          ]);
        }
      }
      if (dispatchAbort.signal.aborted) return;

      const pluginsHint =
        pluginIntent === "gmail"
          ? ` Connected apps: ${connectedLabels.join(", ") || "Gmail"}. The user asked about email — you MUST call GMAIL_FETCH_EMAILS (or GMAIL_LIST_MESSAGES / GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID) with a high maxResults (50–100). If nextPageToken is present, keep paging until you have every message needed. For any row missing subject/from/date, call GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID. NEVER invent emails, NEVER pad with "(same)", "—", or "data not shown". If a field is missing after tools, say so — do not guess. Do NOT open a browser, screenshot, or use the cloud desktop.`
          : pluginIntent && connectedSlugs.includes(pluginIntent)
            ? ` Connected apps (ACTIVE): ${connectedLabels.join(", ") || pluginIntent}. ${pluginIntent} IS connected — never say it is missing. You MUST use the matching Composio ${pluginIntent.toUpperCase()}_* tools now. Do NOT invent missing records. Do NOT open a browser/desktop for this.`
            : pluginCoversIntent
              ? ` Connected apps: ${connectedLabels.join(", ") || pluginIntent}. The user asked about ${pluginIntent} — you MUST use the matching Composio ${pluginIntent?.toUpperCase()}_* tools. Do NOT invent missing records. Do NOT open a browser, screenshot, or use the cloud desktop for this request.`
              : connectedLabels.length > 0
                ? ` Connected apps (ACTIVE): ${connectedLabels.join(", ")}. Never claim one of these is disconnected. Prefer these Composio plugin tools over the browser for email, calendar, YouTube, docs, drive, chat, and similar. For requests like "read my last emails", "check my calendar", or "what can you do with my youtube plugin", call the matching app tools directly with enough page size / pagination to return complete real data — never invent or placeholder-fill rows. Do NOT open connected apps in the cloud browser/VM unless the user explicitly asks for desktop/browser/VM, no plugin covers the task, or visual UI work is required.`
                : integrations.composio
                  ? " Composio plugin tools may be available when apps are connected in Plugins — prefer those tools over opening a browser for email/calendar/docs."
                  : "";

      const sharedDesktopHint =
        integrations.computer && SAAS_MODE
          ? connectedLabels.length
            ? " You also have a shared cloud Linux desktop. Use computer tools (screenshot, click, type_text, open_url, computer_exec) only when the user asks for the desktop/browser/VM, when no connected plugin covers the task, or when visual UI work is required — never as a substitute for connected app tools like Gmail."
            : " You have full access to one shared cloud Linux desktop (the team computer) — the only computer you can control. Files, browser sessions, and the screen are shared with the user's other bots. When the user asks about the VM, the desktop, screenshots, or running commands, actively use the computer tools: screenshot, click, type_text, press_key, scroll, open_url, and computer_exec. Do not claim you lack a computer or only have limited access when these tools are available."
          : integrations.computer && instance.driverKind !== "boxAgent"
            ? connectedLabels.length
              ? " You also have a cloud computer — prefer connected Composio apps for email/calendar/docs; use screenshot/computer_exec/open_url only when the user asks for desktop/browser or plugins cannot do the job."
              : " You have your own cloud computer — use the computer tools (screenshot, computer_exec, open_url) whenever browsing or acting on a desktop helps."
            : integrations.localComputer
              ? " You can act on the user's computer through the computer tools — take a screenshot or read the desktop state first, prefer accessibility actions over raw coordinates, and act carefully."
              : canUseComputerTools &&
                  needsComputer &&
                  wants !== "off" &&
                  wants !== "local" &&
                  box.boxConfigured(cfg)
                ? " The cloud computer could not be attached for this turn — tell the user to open the Computer panel and retry, and do not invent desktop actions."
                : "";

      await instance.adapter.sendTurn({
        threadId: bot.threadId,
        text,
        model: bot.modelSelection.model,
        resumeCursor: bot.resumeCursors[bot.modelSelection.instanceId],
        transcript,
        system:
          persona +
          pluginsHint +
          sharedDesktopHint +
          (plus
            ? ""
            : " The user is on the Free plan: one bot and chat only. No cloud computer, plugins, scheduled routines, or talking to other bots. If they ask for those, tell them to upgrade to Aishe Plus (N$350/month) from App Settings.") +
          (integrations.agents
            ? " You can work with the user's other bots through the agents tools — list_bots shows who's available, ask_bot sends one of them a message and returns their reply."
            : "") +
          (tagged.length
            ? ` The user tagged ${tagged
                .map((t) => `@${t.name} (ask_bot bot_id ${t.id})`)
                .join(" and ")} in their message — bring them in with ask_bot and fold their reply into your answer.`
            : ""),
        integrations,
      });
      if (integrations.computer) startScreenPoller(bot.id, owner, userId);
    } catch (e) {
      if (dispatchAbort.signal.aborted) return;
      const message = e instanceof Error ? e.message : String(e);
      const failure = store.appendMessage(bot.threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `error: ${message.slice(0, 160)}`, ok: false },
      });
      broadcast({ kind: "message", threadId: bot.threadId, message: failure });
      store.patchBot(bot.id, { busy: false });
      turnGate.release(bot.id, userId);
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
    } finally {
      if (turnDispatchAborts.get(bot.id) === dispatchAbort) turnDispatchAborts.delete(bot.id);
    }
  })();

  return { threadId: bot.threadId, message: userMessage };
}

// ── config hot-reload ─────────────────────────────────────────────────
function configStatus() {
  const connectKey = composio.resolveConnectKey(cfg);
  const apiKey = composio.resolveApiKey(cfg);
  return {
    xai: { configured: Boolean(cfg.xai?.key) },
    ollama: { configured: Boolean(cfg.ollama?.key) },
    // configured = Connect ck_ only (App Settings row). Add apps also works with apiKey alone.
    composio: {
      configured: Boolean(connectKey),
      apiKeyConfigured: Boolean(apiKey),
      connectorsReady: composio.connectorsConfigured(cfg),
    },
    box: { configured: Boolean(cfg.box?.token) },
    // not a secret — the sidebar shows it
    profile: { name: cfg.profile?.name ?? "", email: cfg.profile?.email ?? "" },
  };
}

/** Rebuild the provider fleet after a config change so new keys take
 * effect without a server restart (kills any in-flight turns). */
async function reloadProviders() {
  bus.detachAll();
  await registry.disposeAll();
  await registry.load(instanceConfigs(cfg));
  bus.attach(registry.instances());
}

// ── HTTP plumbing ─────────────────────────────────────────────────────
function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  try {
    // ── SaaS auth (public) ─────────────────────────────────────────────
    if (SAAS_MODE && path.startsWith("/api/auth/")) {
      if (method === "POST" && (path === "/api/auth/signup" || path === "/api/auth/login")) {
        return json(res, 400, { error: "Sign in with Google" });
      }
      if (method === "GET" && path === "/api/auth/google") {
        try {
          google.startGoogleLogin(res, url.searchParams.get("next"));
        } catch (e) {
          const status = (e as { status?: number })?.status ?? 500;
          return json(res, status, { error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      if (method === "GET" && path === "/api/auth/google/callback") {
        try {
          const profile = await google.googleProfileFromCallback(req);
          const user = await auth.findOrCreateFromGoogle(profile);
          await tenants.touch(user.id);
          const next = google.consumeOauthNext(req, res);
          google.clearOauthCookie(res);
          auth.issueSession(res, user.id);
          res.writeHead(302, { location: `${google.publicOrigin()}${next}` });
          return res.end();
        } catch (e) {
          google.clearOauthCookie(res);
          const msg = e instanceof Error ? e.message : "Google sign-in failed";
          res.writeHead(302, {
            location: `${google.publicOrigin()}/?auth_error=${encodeURIComponent(msg)}`,
          });
          return res.end();
        }
      }
      if (method === "POST" && path === "/api/auth/logout") {
        auth.clearSession(res);
        return json(res, 200, { ok: true });
      }
      if (method === "GET" && path === "/api/auth/me") {
        const user = await auth.userFromRequest(req);
        if (!user) return json(res, 401, { error: "unauthorized", mode: "saas" });
        await tenants.touch(user.id);
        return json(res, 200, { user: auth.toPublic(user), mode: "saas" });
      }
      if (method === "POST" && path === "/api/auth/onboarding-complete") {
        const user = await auth.userFromRequest(req);
        if (!user) return json(res, 401, { error: "unauthorized", mode: "saas" });
        const updated = await auth.completeOnboarding(user.id);
        if (!updated) return json(res, 404, { error: "user not found" });
        return json(res, 200, { user: auth.toPublic(updated) });
      }
      return json(res, 404, { error: "unknown auth endpoint" });
    }

    if (method === "GET" && path === "/api/health") {
      return json(res, 200, { app: "aishe", pid: process.pid, static: Boolean(STATIC_DIR) });
    }

    if (SAAS_MODE && method === "GET" && path === "/api/saas") {
      return json(res, 200, { mode: "saas", googleAuth: google.googleConfigured() });
    }

    if (SAAS_MODE && method === "POST" && path === "/api/cron/routines") {
      const expected = process.env.OMB_HARNESS_SECRET?.trim();
      const got = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!expected || got !== expected) return json(res, 401, { error: "unauthorized" });
      const ran = await tickRoutines();
      return json(res, 200, ran);
    }

    if (SAAS_MODE && method === "POST" && path === "/api/billing/polar/webhook") {
      try {
        await polar.handleWebhook(req.headers, await readRawBody(req));
        res.writeHead(202);
        return res.end();
      } catch (e) {
        const status = (e as { status?: number })?.status ?? 500;
        if (status === 403) {
          res.writeHead(403);
          return res.end();
        }
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // ── resolve tenant store ───────────────────────────────────────────
    let store = desktopStore;
    let saasUser: auth.SaasUser | null = null;
    let sseUserId = "__desktop__";
    if (SAAS_MODE && path.startsWith("/api/") && !path.startsWith("/api/internal/")) {
      saasUser = await auth.userFromRequest(req);
      if (!saasUser) return json(res, 401, { error: "unauthorized", mode: "saas" });
      store = await tenants.touch(saasUser.id);
      sseUserId = saasUser.id;
    }
    const broadcastUser = (payload: unknown) => broadcastTo(sseUserId, payload);

    if (method === "POST" && path === "/api/routines/tick") {
      if (SAAS_MODE && saasUser && !plusUnlocked(saasUser)) return json(res, 402, plusRequiredPayload("Routines"));
      const ran = await tickRoutines();
      return json(res, 200, ran);
    }

    if (SAAS_MODE && saasUser && method === "GET" && path === "/api/billing/checkout") {
      res.writeHead(302, {
        location: polar.checkoutUrl({
          email: saasUser.email,
          name: saasUser.name,
          referenceId: saasUser.id,
        }),
      });
      return res.end();
    }

    // ── internal peer-agent comms (localhost + shared token only) ──────
    // The agents-proxy (spawned inside a bot's agent process) calls these to
    // discover peers and hand a message to one. Not part of the public API.
    if (path.startsWith("/api/internal/")) {
      if (req.headers.authorization !== `Bearer ${COMMS_TOKEN}`) {
        return json(res, 401, { error: "unauthorized" });
      }
      if (method === "GET" && path === "/api/internal/agents") {
        const self = url.searchParams.get("self");
        const owned = self ? tenants.findByBotId(self) : null;
        const s = owned?.store ?? desktopStore;
        const bots = s.bots
          .filter((b) => b.id !== self && !b.hidden)
          .map((b) => ({ id: b.id, name: b.name, model: b.modelSelection.model, busy: !!b.busy }));
        return json(res, 200, { bots });
      }
      if (method === "POST" && path === "/api/internal/ask-bot") {
        const body = await readBody(req);
        const fromBotId = String(body.fromBotId ?? "");
        const toBotId = String(body.toBotId ?? "");
        const message = String(body.message ?? "").trim();
        const depth = Number(body.depth ?? 0) || 0;
        if (!toBotId || !message) return json(res, 400, { error: "toBotId and message required" });
        if (toBotId === fromBotId) return json(res, 400, { error: "a bot cannot message itself" });
        if (depth >= MAX_COMMS_DEPTH) return json(res, 200, { error: "message chains are limited to one hop" });
        const owned = tenants.findByBotId(fromBotId) ?? { userId: "__desktop__", store: desktopStore };
        if (SAAS_MODE && owned.userId !== "__desktop__") {
          const ownerUser = await auth.findUserById(owned.userId);
          if (!plusUnlocked(ownerUser)) {
            return json(res, 200, { error: "Aishe Plus is required for bots to talk to each other." });
          }
        }
        const s = owned.store;
        const target = s.bot(toBotId);
        if (!target) return json(res, 404, { error: "no such bot" });
        if (target.busy) return json(res, 200, { busy: true });
        const from = s.bot(fromBotId);
        const fromName = from?.name ?? "another bot";
        if (from) {
          const note = s.appendMessage(from.threadId, {
            role: "bot",
            kind: "activity",
            tool: { name: `asked @${target.name}: ${message.slice(0, 80)}` },
          });
          broadcastTo(owned.userId, { kind: "message", threadId: from.threadId, message: note });
        }
        const prefixed = `[Message from @${fromName}, another bot in this Aishe workspace. Reply to them.]\n\n${message}`;
        const reply = await askBotAndWait(toBotId, prefixed, depth);
        return json(res, 200, { botName: target.name, text: reply });
      }
      return json(res, 404, { error: "unknown internal endpoint" });
    }

    // ── events stream ──
    if (method === "GET" && path === "/api/events") {
      void tickRoutines();
      // X-Accel-Buffering + flushHeaders: Vite/nginx must not hold SSE frames.
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.flushHeaders?.();
      res.write(`data: ${JSON.stringify({ kind: "hello" })}\n\n`);
      const flushable = res as ServerResponse & { flush?: () => void };
      flushable.flush?.();
      let set = sseClients.get(sseUserId);
      if (!set) {
        set = new Set();
        sseClients.set(sseUserId, set);
      }
      set.add(res);
      const keepalive = setInterval(() => {
        try {
          res.write(": keepalive\n\n");
          flushable.flush?.();
        } catch {}
      }, 15_000);
      req.on("close", () => {
        clearInterval(keepalive);
        set!.delete(res);
      });
      return;
    }

    // ── bots ──
    if (method === "GET" && path === "/api/bots") {
      return json(res, 200, {
        bots: store.bots.map((b) => ({
          ...b,
          messages: trimThreadMessages(store.messagesFor(b.threadId), MAX_MESSAGES_PER_THREAD),
        })),
      });
    }
    if (method === "POST" && path === "/api/bots") {
      if (
        SAAS_MODE &&
        !plusUnlocked(saasUser) &&
        store.bots.filter((b) => !b.hidden).length >= FREE_BOT_LIMIT
      ) {
        return json(res, 402, plusRequiredPayload("Extra bots"));
      }
      const bot = store.createBot();
      store.patchBot(bot.id, { modelSelection: await defaultSelection() });
      return json(res, 201, { bot: { ...store.bot(bot.id)!, messages: store.messagesFor(bot.threadId) } });
    }
    let m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      const patch: Record<string, unknown> = {};
      for (const key of ["name", "title", "description", "notifications", "modelSelection", "unread", "computer", "color", "mascotExpression", "pinned", "hidden"] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      const bot = store.patchBot(m[1], patch);
      if (!bot) return json(res, 404, { error: "no such bot" });
      broadcastUser({ kind: "bot", bot });
      return json(res, 200, { bot });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      // a running turn dies with its bot
      await registry.get(bot.modelSelection.instanceId)?.adapter.interruptTurn(bot.threadId).catch(() => {});
      stopScreenPoller(bot.id);
      store.deleteBot(bot.id);
      for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
        try {
          unlinkSync(join(dir, `${bot.threadId}.ndjson`));
        } catch {}
      }
      broadcastUser({ kind: "bot.deleted", botId: bot.id });
      return json(res, 200, { ok: true });
    }

    // onboarding/ask cards persist their answered/dismissed state
    m = path.match(/^\/api\/bots\/([\w-]+)\/cards\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const existing = store.messagesFor(bot.threadId).find((msg) => msg.id === m![2]);
      if (!existing?.card) return json(res, 404, { error: "no such card" });
      const body = await readBody(req);
      const patched = store.patchMessage(bot.threadId, m[2], {
        card: {
          ...existing.card,
          ...(body.answered !== undefined ? { answered: body.answered } : {}),
          ...(body.dismissed !== undefined ? { dismissed: body.dismissed } : {}),
        },
      });
      broadcastUser({ kind: "message.patch", threadId: bot.threadId, message: patched });
      return json(res, 200, { message: patched });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/routines$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const uid = saasUser?.id ?? "__desktop__";
      const rows = await routines.listForUser(uid);
      return json(res, 200, {
        routines: rows.map((r) => ({
          ...r,
          botName: store.bot(r.botId)?.name ?? "a bot",
        })),
      });
    }
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (SAAS_MODE && !plusUnlocked(saasUser)) return json(res, 402, plusRequiredPayload("Routines"));
      const uid = saasUser?.id ?? "__desktop__";
      const body = await readBody(req);
      const created = await routines.createRoutine(uid, bot.id, {
        name: String(body.name ?? ""),
        instruction: String(body.instruction ?? ""),
        kind: body.kind === "interval" ? "interval" : "daily",
        hour: body.hour != null ? Number(body.hour) : undefined,
        minute: body.minute != null ? Number(body.minute) : undefined,
        timezone: body.timezone != null ? String(body.timezone) : undefined,
        intervalMinutes: body.intervalMinutes != null ? Number(body.intervalMinutes) : undefined,
        enabled: body.enabled !== false,
      });
      return json(res, 201, { routine: created });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/routines\/([\w-]+)\/run$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (SAAS_MODE && !plusUnlocked(saasUser)) return json(res, 402, plusRequiredPayload("Routines"));
      const uid = saasUser?.id ?? "__desktop__";
      const row = await routines.getRoutine(uid, m[2]);
      if (!row || row.botId !== bot.id) return json(res, 404, { error: "no such routine" });
      const started = await startTurn(bot.id, routines.routinePrompt(row), { userId: uid });
      const updated = await routines.markRun(uid, row);
      return json(res, 202, { ok: true, routine: updated, threadId: started.threadId, message: started.message });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/routines\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (SAAS_MODE && !plusUnlocked(saasUser)) return json(res, 402, plusRequiredPayload("Routines"));
      const uid = saasUser?.id ?? "__desktop__";
      const body = await readBody(req);
      const updated = await routines.patchRoutine(uid, m[2], {
        name: body.name != null ? String(body.name) : undefined,
        instruction: body.instruction != null ? String(body.instruction) : undefined,
        kind: body.kind === "daily" || body.kind === "interval" ? body.kind : undefined,
        hour: body.hour != null ? Number(body.hour) : undefined,
        minute: body.minute != null ? Number(body.minute) : undefined,
        timezone: body.timezone != null ? String(body.timezone) : undefined,
        intervalMinutes: body.intervalMinutes != null ? Number(body.intervalMinutes) : undefined,
        enabled: body.enabled != null ? Boolean(body.enabled) : undefined,
      });
      if (!updated || updated.botId !== bot.id) return json(res, 404, { error: "no such routine" });
      return json(res, 200, { routine: updated });
    }
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (SAAS_MODE && !plusUnlocked(saasUser)) return json(res, 402, plusRequiredPayload("Routines"));
      const uid = saasUser?.id ?? "__desktop__";
      const row = await routines.getRoutine(uid, m[2]);
      if (!row || row.botId !== bot.id) return json(res, 404, { error: "no such routine" });
      await routines.removeRoutine(uid, m[2]);
      return json(res, 200, { ok: true });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/messages$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      const started = await startTurn(m[1], text);
      return json(res, 202, { ok: true, threadId: started.threadId, message: started.message });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      const instance = registry.get(bot.modelSelection.instanceId);
      if (!instance) return json(res, 409, { error: "provider unavailable" });
      await instance.adapter.respondToRequest(bot.threadId, String(body.requestId), {
        behavior: body.behavior,
        message: body.message,
      });
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      turnDispatchAborts.get(bot.id)?.abort();
      turnDispatchAborts.delete(bot.id);
      const instance = registry.get(bot.modelSelection.instanceId);
      await instance?.adapter.interruptTurn(bot.threadId);
      // Clear busy even if sendTurn never started (stuck in Box/Composio prep).
      store.patchBot(bot.id, { busy: false });
      turnGate.release(bot.id, saasUser?.id ?? sseUserId);
      broadcastUser({ kind: "bot", bot: store.bot(bot.id) });
      return json(res, 200, { ok: true });
    }

    // ── provider instances (model picker) ──
    if (method === "GET" && path === "/api/instances") {
      const instances = await registry.describe();
      if (!SAAS_MODE) return json(res, 200, { instances });
      return json(res, 200, {
        instances: instances.map((row) =>
          row.snapshot.state === "unavailable"
            ? { ...row, snapshot: { ...row.snapshot, reason: "Temporarily unavailable" } }
            : row,
        ),
      });
    }

    // ── app config (API keys — never echoed back, booleans only) ──
    if (method === "GET" && path === "/api/config") {
      return json(res, 200, configStatus());
    }
    if ((method === "PUT" || method === "PATCH") && path === "/api/config") {
      const body = await readBody(req);
      const patch: Record<string, object> = {};
      // SaaS: platform owns all provider keys. Users may only update profile.
      const allowed = SAAS_MODE
        ? (["profile"] as const)
        : (["xai", "ollama", "composio", "box", "profile"] as const);
      for (const key of allowed) {
        if (body[key] && typeof body[key] === "object") patch[key] = body[key];
      }
      if (patch.composio && typeof patch.composio === "object") {
        const c = patch.composio as { key?: string; apiKey?: string };
        const keyVal = typeof c.key === "string" ? c.key.trim() : "";
        const apiVal = typeof c.apiKey === "string" ? c.apiKey.trim() : "";
        if (keyVal.startsWith("ak_")) {
          return json(res, 400, {
            error:
              "That looks like a project API key (ak_…). Paste it in the Composio API key field — Add apps works with ak_ alone. The Connect field needs ck_… from dashboard → Install (AI Clients).",
          });
        }
        if (keyVal && !keyVal.startsWith("ck_") && keyVal.length > 0) {
          return json(res, 400, {
            error: "Composio Connect key should start with ck_… (from dashboard → Install / AI Clients).",
          });
        }
        if (apiVal.startsWith("ck_")) {
          return json(res, 400, {
            error: "That looks like a Connect key (ck_…). Paste it in the Composio Connect key field, not API key.",
          });
        }
        if (apiVal && !apiVal.startsWith("ak_")) {
          return json(res, 400, {
            error: "Composio API key should start with ak_… (from Platform → project → Settings → API Keys).",
          });
        }
      }
      if (!Object.keys(patch).length) {
        return json(res, 400, {
          error: SAAS_MODE
            ? "nothing to save — only your profile can be updated here"
            : "nothing to save",
        });
      }
      saveConfig(patch);
      Object.assign(cfg, loadConfig());
      // provider keys change the fleet; profile / composio edits must not
      // kill in-flight turns (composio is read from `cfg` on each request)
      if (Object.keys(patch).some((k) => k !== "profile" && k !== "composio")) await reloadProviders();
      const status = configStatus();
      broadcastUser({ kind: "config", ...status });
      return json(res, 200, status);
    }

    // ── connectors (Composio) ──
    if (method === "GET" && path === "/api/connectors/catalog") {
      const { cards, source } = await composio.listToolkits(cfg);
      return json(res, 200, {
        configured: composio.connectorsConfigured(cfg),
        source,
        cards,
      });
    }
    if (method === "GET" && path === "/api/connectors") {
      const services = (url.searchParams.get("services") ?? "").split(",").filter(Boolean);
      if (!composio.connectorsConfigured(cfg)) {
        return json(res, 200, { configured: false, services: {} });
      }
      try {
        const status = await composio.connectionStatus(
          cfg,
          services.length ? services : composio.CURATED_SLUGS,
          saasUser?.id,
        );
        return json(res, 200, { configured: true, services: status, userId: saasUser?.id ?? null });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn("[composio] connectionStatus:", message);
        return json(res, 502, { error: message, configured: true, services: {} });
      }
    }
    m = path.match(/^\/api\/connectors\/([\w-]+)\/authorize$/);
    if (m && method === "POST") {
      if (SAAS_MODE && !plusUnlocked(saasUser)) return json(res, 402, plusRequiredPayload("Plugins"));
      try {
        const out = await composio.authorizeService(cfg, m[1], saasUser?.id);
        composio.clearToolsCache();
        return json(res, 200, out);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn("[composio] authorize:", message);
        return json(res, 502, { error: message });
      }
    }
    m = path.match(/^\/api\/connectors\/([\w-]+)$/);
    if (m && method === "DELETE") {
      try {
        const out = await composio.removeService(cfg, m[1], saasUser?.id);
        composio.clearToolsCache();
        return json(res, 200, out);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn("[composio] remove:", message);
        return json(res, 502, { error: message });
      }
    }

    // ── cloud computer (Box) — SaaS: shared per user; desktop: per bot ──
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer$/);
    if (m && method === "GET") {
      const botId = m[1];
      const bot = store.bot(botId);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const owner = boxOwnerFor(saasUser?.id ?? sseUserId, botId);
      return json(res, 200, await box.boxStatus(cfg, owner));
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/(provision|join|sleep|exec|screenshot)$/);
    if (m && method === "POST") {
      if (SAAS_MODE && !plusUnlocked(saasUser)) return json(res, 402, plusRequiredPayload("Cloud computer"));
      const botId = m[1];
      const bot = store.bot(botId);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const owner = boxOwnerFor(saasUser?.id ?? sseUserId, botId);
      const label = SAAS_MODE ? "Team" : bot.name;
      switch (m[2]) {
        case "provision":
          return json(res, 200, await box.provisionBox(cfg, owner, label));
        case "join":
          return json(res, 200, await box.joinBox(cfg, owner));
        case "sleep":
          return json(res, 200, await box.sleepBox(cfg, owner));
        case "exec": {
          const body = await readBody(req);
          return json(res, 200, await box.execOnBox(cfg, owner, String(body.command ?? "")));
        }
        case "screenshot":
          return json(res, 200, await box.screenshotBox(cfg, owner));
      }
    }

    // packaged app: the server serves the built UI too (window → :8799 for
    // everything, no dev proxy to die). OMB_STATIC_DIR is set by Electron.
    if (method === "GET" && !path.startsWith("/api/") && STATIC_DIR) {
      const safe = path === "/" ? "/index.html" : path.replace(/\.\./g, "");
      const file = join(STATIC_DIR, safe);
      try {
        const data = readFileSync(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        return res.end(data);
      } catch {
        // SPA fallback
        try {
          const data = readFileSync(join(STATIC_DIR, "index.html"));
          res.writeHead(200, { "content-type": "text/html" });
          return res.end(data);
        } catch {
          /* fall through to 404 */
        }
      }
    }

    return json(res, 404, { error: `no route: ${method} ${path}` });
  } catch (e) {
    const status = (e as any)?.status ?? 500;
    return json(res, status, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, SAAS_HOST, () => {
  console.log(`aishe server on http://${SAAS_HOST === "0.0.0.0" ? "127.0.0.1" : SAAS_HOST}:${PORT}${SAAS_MODE ? " (saas)" : ""}`);
});

let routineTickBusy = false;
async function tickRoutines(): Promise<{ due: number; ran: number; skipped: number }> {
  if (routineTickBusy) return { due: 0, ran: 0, skipped: 0 };
  routineTickBusy = true;
  let ran = 0;
  let skipped = 0;
  try {
    const due = await routines.listDue();
    for (const row of due) {
      try {
        if (SAAS_MODE && row.userId !== "__desktop__") {
          const ownerUser = await auth.findUserById(row.userId);
          if (!plusUnlocked(ownerUser)) {
            skipped++;
            console.warn(`[routines] skip ${row.id}: Plus required`);
            continue;
          }
        }
        const store =
          SAAS_MODE && row.userId !== "__desktop__"
            ? await tenants.touch(row.userId)
            : desktopStore;
        const bot = store.bot(row.botId);
        if (!bot) {
          skipped++;
          console.warn(`[routines] skip ${row.id}: no bot ${row.botId}`);
          continue;
        }
        if (bot.busy) {
          skipped++;
          continue;
        }
        await startTurn(bot.id, routines.routinePrompt(row), { userId: row.userId });
        await routines.markRun(row.userId, row);
        ran++;
      } catch (e) {
        skipped++;
        console.warn("[routines] tick:", e instanceof Error ? e.message : e);
      }
    }
    if (due.length) console.log(`[routines] due=${due.length} ran=${ran} skipped=${skipped}`);
    return { due: due.length, ran, skipped };
  } catch (e) {
    console.warn("[routines] listDue:", e instanceof Error ? e.message : e);
    return { due: 0, ran, skipped };
  } finally {
    routineTickBusy = false;
  }
}
setInterval(() => void tickRoutines(), 30_000);
setTimeout(() => void tickRoutines(), 8_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void registry.disposeAll().finally(() => process.exit(0));
  });
}
