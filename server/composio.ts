// Composio — two clients in one file:
//  1) the Connect meta-MCP (connect.composio.dev) for connection state +
//     auth links, ported from agentcal src/composio.js — needs ck_…
//  2) the v3 Platform API (backend.composio.dev) for the plugin marketplace
//     catalog AND (when no ck_ is set) OAuth authorize / status / remove
//     using the project API key ak_… — Composio docs: connected_accounts/link
//     + auth_configs with x-api-key. Connect MCP rejects ak_ with 401.

const CONNECT_URL = "https://connect.composio.dev/mcp";
const BACKEND_URL = "https://backend.composio.dev/api/v3";

function parseMcpResponse(text: string) {
  // Streamable-HTTP servers answer JSON or SSE (`data: {...}` lines).
  const line = text.startsWith("{")
    ? text
    : text.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
  if (!line) throw new Error("empty MCP response");
  const msg = JSON.parse(line);
  if (msg.error) throw new Error(msg.error.message || "MCP error");
  const content = msg.result?.content?.find((c: any) => c.type === "text")?.text;
  if (!content) return msg.result ?? null;
  try {
    return JSON.parse(content);
  } catch {
    return { text: content };
  }
}

type ComposioCfg = { composio?: { key?: string; apiKey?: string; url?: string } };

/** ck_… Connect consumer key — Connect MCP only. Ignores ak_ pasted by mistake. */
export function resolveConnectKey(cfg: ComposioCfg): string | undefined {
  const k = cfg.composio?.key?.trim();
  if (!k || k.startsWith("ak_")) return undefined;
  return k;
}

/** ak_… project API key — catalog + Platform authorize fallback.
 * Also recovers when the user pasted ak_ into the Connect key field. */
export function resolveApiKey(cfg: ComposioCfg): string | undefined {
  const fromField = cfg.composio?.apiKey?.trim();
  if (fromField) return fromField;
  const k = cfg.composio?.key?.trim();
  if (k?.startsWith("ak_")) return k;
  return undefined;
}

/** True when Add / disconnect can run (Connect MCP or Platform API). */
export function connectorsConfigured(cfg: ComposioCfg): boolean {
  return Boolean(resolveConnectKey(cfg) || resolveApiKey(cfg));
}

function composioHeaders(cfg: ComposioCfg, userId?: string): Record<string, string> {
  const key = resolveConnectKey(cfg);
  if (!key) {
    throw new Error('no Composio Connect key configured — add {"composio":{"key":"ck_…"}} or a project API key {"composio":{"apiKey":"ak_…"}}');
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-consumer-api-key": key,
  };
  // Isolate OAuth connections per SaaS tenant when the Connect gateway supports it.
  if (userId) {
    headers["x-entity-id"] = userId;
    headers["x-user-id"] = userId;
  }
  return headers;
}

function entityUserId(userId?: string): string {
  return userId?.trim() || "default";
}

function accountUserId(account: any): string {
  return String(
    account?.user_id ?? account?.userId ?? account?.entity_id ?? account?.entityId ?? "",
  ).trim();
}

/** SaaS tenants only see their own OAuth accounts. Desktop may use unscoped/"default". */
function accountBelongsTo(account: any, entity: string, scoped: boolean): boolean {
  const uid = accountUserId(account);
  if (scoped) return uid === entity;
  return !uid || uid === "default" || uid === entity;
}

async function backendJson(
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method,
    headers: {
      "x-api-key": apiKey,
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const msg = json?.error?.message ?? json?.message ?? text.slice(0, 200) ?? `HTTP ${res.status}`;
    throw new Error(`Composio API: ${msg}`);
  }
  return json;
}

/** Resolve or create a Composio-managed auth config for the toolkit slug. */
async function ensureAuthConfigId(apiKey: string, slug: string): Promise<string> {
  const listed = await backendJson(
    apiKey,
    "GET",
    `/auth_configs?toolkit_slug=${encodeURIComponent(slug)}&limit=10`,
  );
  const items: any[] = listed?.items ?? listed?.data ?? [];
  const existing = items.find((c) => c?.id && !c?.is_disabled);
  if (existing?.id) return String(existing.id);

  const created = await backendJson(apiKey, "POST", "/auth_configs", {
    toolkit: { slug },
    auth_config: { type: "use_composio_managed_auth" },
  });
  const id = created?.auth_config?.id ?? created?.id ?? created?.data?.id;
  if (!id) throw new Error(`Composio returned no auth config for ${slug}`);
  return String(id);
}

async function listConnectedAccounts(
  apiKey: string,
  slugs: string[],
  userId?: string,
): Promise<any[]> {
  const scoped = Boolean(userId?.trim());
  const entity = entityUserId(userId);
  const params = new URLSearchParams();
  params.set("limit", "100");
  params.set("user_ids", entity);
  params.set("user_id", entity);
  for (const slug of slugs) params.append("toolkit_slugs", slug);
  const json = await backendJson(apiKey, "GET", `/connected_accounts?${params}`);
  let items: any[] = (json?.items ?? json?.data ?? []).filter((a: any) =>
    accountBelongsTo(a, entity, scoped),
  );
  // Composio may ignore user_ids on some plans — list then keep only this tenant.
  // Never fall back to other users' ACTIVE accounts.
  if (!items.length) {
    const loose = new URLSearchParams();
    loose.set("limit", "100");
    for (const slug of slugs) loose.append("toolkit_slugs", slug);
    const all = await backendJson(apiKey, "GET", `/connected_accounts?${loose}`);
    const pool: any[] = all?.items ?? all?.data ?? [];
    items = pool.filter((a) => accountBelongsTo(a, entity, scoped));
  }
  return items;
}

export async function composioTool(cfg: ComposioCfg, name: string, args: unknown, userId?: string) {
  const res = await fetch(cfg.composio?.url || CONNECT_URL, {
    method: "POST",
    headers: composioHeaders(cfg, userId),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Composio MCP: HTTP ${res.status}`);
  return parseMcpResponse(await res.text());
}

/** Labels for ACTIVE connected toolkits (for system-prompt awareness). */
export async function listConnectedToolkitLabels(
  cfg: ComposioCfg,
  userId?: string,
): Promise<string[]> {
  const apiKey = resolveApiKey(cfg);
  if (!apiKey) return [];
  const items = await listConnectedAccounts(apiKey, [], userId);
  const labels = new Map<string, string>();
  for (const a of items) {
    if (!/^active$/i.test(a?.status ?? "") || a?.is_disabled) continue;
    const slug = String(a?.toolkit?.slug ?? "").toLowerCase();
    if (!slug) continue;
    const curated = CURATED.find((c) => c.slug === slug);
    labels.set(slug, curated?.label ?? (a?.toolkit?.name ?? slug));
  }
  return [...labels.values()].sort((a, b) => a.localeCompare(b));
}

type OpenAITool = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

function enrichToolDescription(name: string, description: string): string {
  const n = name.toUpperCase();
  if (/GMAIL_(FETCH_EMAILS|LIST_MESSAGES)/.test(n)) {
    return (
      `${description} ` +
      "Set maxResults high (50–100) for list requests. If nextPageToken is returned, call again with pageToken until you have every row the user asked for. " +
      "Never invent subjects/senders or fill missing rows with placeholders like '(same)'."
    ).slice(0, 480);
  }
  if (/GMAIL_FETCH_MESSAGE/.test(n)) {
    return (
      `${description} ` +
      "Use this for each message id when the list lacks subject/from/snippet. Do not invent message fields."
    ).slice(0, 480);
  }
  return description.slice(0, 280);
}

function toOpenAITool(t: any): OpenAITool {
  const name = String(t.slug ?? t.name ?? "composio_tool");
  return {
    type: "function",
    function: {
      name,
      description: enrichToolDescription(
        name,
        String(t.description ?? t.name ?? t.slug ?? "Composio tool"),
      ),
      parameters: (t.input_parameters ?? t.inputSchema ?? t.parameters ?? {
        type: "object",
        properties: {},
      }) as Record<string, unknown>,
    },
  };
}

/** Gmail list defaults are tiny (often 10). Bump so inbox asks are not artificially capped. */
export function normalizeComposioToolArgs(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const n = name.toUpperCase();
  if (!/GMAIL_(FETCH_EMAILS|LIST_MESSAGES)/.test(n)) return args;
  const out = { ...args };
  const raw = out.maxResults ?? out.max_results;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  const next = !Number.isFinite(parsed) || parsed <= 0 ? 50 : Math.min(100, Math.max(parsed, 50));
  out.maxResults = next;
  delete out.max_results;
  return out;
}

/** Keep list payloads usable after truncation — prefer real fields over model guesswork. */
export function formatComposioToolResult(name: string, out: unknown, maxChars = 24_000): string {
  const n = name.toUpperCase();
  // Always compact Gmail lists so 50+ real rows fit — raw bodies previously
  // truncated mid-list and the model filled gaps with "(same)" / placeholders.
  if (/GMAIL_(FETCH_EMAILS|LIST_MESSAGES)/.test(n)) {
    try {
      const parsed = typeof out === "string" ? JSON.parse(out) : out;
      const compact = compactGmailListPayload(parsed);
      const text = JSON.stringify(compact);
      if (text.length <= maxChars) {
        const token = (compact as { nextPageToken?: string | null }).nextPageToken;
        return token
          ? `${text}\n[note: more pages available via nextPageToken — keep calling until complete; never invent rows]`
          : text;
      }
      return `${text.slice(0, maxChars - 180)}\n…[truncated — continue with pageToken / FETCH_MESSAGE; never invent rows]`;
    } catch {
      /* fall through */
    }
  }
  const full = typeof out === "string" ? out : JSON.stringify(out);
  if (full.length <= maxChars) return full;
  if (/GMAIL_FETCH_MESSAGE/.test(n)) {
    return `${full.slice(0, maxChars - 120)}\n…[truncated message body — keep subject/from/date you already have; never invent]`;
  }
  return `${full.slice(0, maxChars - 120)}\n…[truncated — fetch another page or fewer fields; never invent missing data]`;
}

function compactGmailListPayload(parsed: unknown): unknown {
  const root = parsed as any;
  const data = root?.data ?? root?.response ?? root;
  const messages =
    data?.messages ??
    data?.emails ??
    data?.items ??
    root?.messages ??
    root?.emails ??
    (Array.isArray(data) ? data : null);
  const nextPageToken = data?.nextPageToken ?? data?.next_page_token ?? root?.nextPageToken ?? null;
  if (!Array.isArray(messages)) {
    return {
      nextPageToken,
      preview: JSON.stringify(parsed).slice(0, 4000),
    };
  }
  return {
    nextPageToken,
    count: messages.length,
    messages: messages.map((m: any) => ({
      id: m?.id ?? m?.messageId ?? m?.message_id ?? null,
      threadId: m?.threadId ?? m?.thread_id ?? null,
      subject: m?.subject ?? m?.payload?.headers?.find?.((h: any) => /subject/i.test(h?.name))?.value ?? null,
      from: m?.from ?? m?.sender ?? m?.payload?.headers?.find?.((h: any) => /^from$/i.test(h?.name))?.value ?? null,
      date: m?.date ?? m?.internalDate ?? m?.payload?.headers?.find?.((h: any) => /^date$/i.test(h?.name))?.value ?? null,
      snippet: m?.snippet ?? m?.preview ?? null,
      labelIds: m?.labelIds ?? m?.label_ids ?? null,
    })),
  };
}

/** Cap plugin tools hard — large schemas stall GPT-OSS tool rounds. */
const MAX_COMPOSIO_TOOLS = 18;
const MAX_TOOLS_PER_TOOLKIT = 8;
const LIST_TOOLS_TIMEOUT_MS = 6_500;

/** Prefer inbox/calendar actions; demote ACL/admin noise that used to fill the budget. */
function scoreToolName(name: string): number {
  const n = name.toUpperCase();
  if (/_ACL_|PERMISSION|SETTING|_WATCH|_COLORS_|FREEBUSY_QUERY/.test(n) && !/EVENT|EMAIL|MESSAGE/.test(n)) {
    return -80;
  }
  let score = 0;
  if (/FETCH_EMAILS|LIST_MESSAGES|FETCH_MESSAGE|SEND_EMAIL|CREATE_EMAIL|REPLY_TO_THREAD/.test(n)) score += 80;
  if (/FETCH|LIST|SEARCH|FIND|GET_|READ|SEND|CREATE|INSERT|UPDATE|WRITE|REPLY|FORWARD|ARCHIVE|EVENTS|MESSAGES|EMAILS|THREADS/.test(n)) {
    score += 40;
  }
  if (/EMAIL|MESSAGE|INBOX|THREAD|EVENT|CALENDAR|FILE|DOC|SHEET|ISSUE|CHANNEL|CHAT|DRIVE/.test(n)) score += 12;
  if (/_DELETE$|_REMOVE$/.test(n) && !/EVENT|MESSAGE|EMAIL|FILE|TASK|ISSUE|DRAFT/.test(n)) score -= 25;
  return score;
}

function rankAndCapTools(
  tools: OpenAITool[],
  max = MAX_COMPOSIO_TOOLS,
  preferToolkit?: string | null,
): OpenAITool[] {
  const pref = preferToolkit?.toUpperCase().replace(/-/g, "") ?? "";
  return [...tools]
    .sort((a, b) => {
      const an = a.function.name.toUpperCase().replace(/-/g, "_");
      const bn = b.function.name.toUpperCase().replace(/-/g, "_");
      const ap = pref && an.startsWith(pref) ? 1000 : 0;
      const bp = pref && bn.startsWith(pref) ? 1000 : 0;
      return bp + scoreToolName(b.function.name) - (ap + scoreToolName(a.function.name));
    })
    .filter((t) => scoreToolName(t.function.name) > -40)
    .slice(0, max);
}

/** Short greetings must not pay for Composio listing / tool-mode inference. */
export function isLightChatTurn(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.length > 120) return false;
  // Follow-ups like "check again" must NOT be light — they often mean "retry the plugin".
  if (
    /\b(check|again|retry|reconnect|connected|plugin|youtube|email|gmail|calendar|inbox|list|fetch|read|show|try)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  if (
    /\b(email|e-?mail|gmail|inbox|calendar|slack|github|notion|drive|google docs?|sheets?|browser|screenshot|desktop|vm|computer|terminal|shell|fetch|send|check my|read my|list my|search my|schedule|meeting|invite)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  // "hi — reply in one short sentence, no tools." and similar must stay light.
  if (
    /^(hi|hello|hey|yo|sup|hola|howdy|what'?s up)\b/i.test(t) &&
    !/\b(tool|plugin|app|connector|composio|open |click |type |run |exec)\b/i.test(t.replace(/\bno tools?\b/gi, ""))
  ) {
    return true;
  }
  return /^(hi|hello|hey|yo|sup|thanks|thank you|thx|ok|okay|yes|no|ping|test|hola|howdy|good (morning|afternoon|evening)|what'?s up)[\s!.?,]*$/i.test(
    t,
  );
}

/** Resolve plugin intent from this message, or recent chat if the user said "check again". */
export function resolvePluginIntent(text: string, recentUserTexts: string[] = []): string | null {
  const direct = messagePluginIntent(text);
  if (direct) return direct;
  const followUp = /^(check again|try again|again|now\??|did it work\??|connected\??|and now\??|please check)[\s!.?]*$/i.test(
    text.trim(),
  );
  if (!followUp && text.trim().length > 40) return null;
  for (const prev of recentUserTexts) {
    const intent = messagePluginIntent(prev);
    if (intent) return intent;
  }
  return null;
}

export function messageNeedsComputer(text: string): boolean {
  return /\b(screenshot|desktop|browser|vm|computer|terminal|shell|open (https?:\/\/|www\.)|click |type into|vnc)\b/i.test(
    text,
  );
}

/** Map a user message to a connected-toolkit slug when plugins should handle it. */
export function messagePluginIntent(text: string): string | null {
  const t = text.toLowerCase();
  if (/\b(email|e-?mail|gmail|inbox|mail\b|last (email|mail)|unread)\b/.test(t)) return "gmail";
  // Include common misspellings — "calander" / "calender" used to miss intent and open LIVE DESKTOP.
  if (
    /\b(cal+end?ars?|calanders?|calenders?|schedule|meeting|invite|agenda|events?)\b/.test(t) ||
    /\b(what('?s| is| are).{0,40}\b(today|tomorrow|this week)\b)/.test(t)
  ) {
    return "googlecalendar";
  }
  if (/\b(youtube|yt)\b/.test(t)) return "youtube";
  if (/\b(slack)\b/.test(t)) return "slack";
  if (/\b(github|pull request|\bpr\b|issue)\b/.test(t)) return "github";
  if (/\b(notion)\b/.test(t)) return "notion";
  if (/\b(sheets?|spreadsheet)\b/.test(t)) return "googlesheets";
  if (/\b(google docs?|document)\b/.test(t)) return "googledocs";
  if (/\b(drive|google drive)\b/.test(t)) return "googledrive";
  return null;
}

/** ACTIVE connected toolkit slugs for this user (Platform ak_ path).
 * Includes marketplace connects (e.g. YouTube), not only the curated sidebar list. */
export async function listConnectedToolkitSlugs(
  cfg: ComposioCfg,
  userId?: string,
): Promise<string[]> {
  const apiKey = resolveApiKey(cfg);
  if (!apiKey) return [];
  // Empty slug list ⇒ all accounts for this user (marketplace + curated).
  const items = await listConnectedAccounts(apiKey, [], userId);
  const slugs = new Set<string>();
  for (const a of items) {
    if (!/^active$/i.test(a?.status ?? "") || a?.is_disabled) continue;
    const slug = String(a?.toolkit?.slug ?? "").toLowerCase();
    if (slug) slugs.add(slug);
  }
  // Also scan curated slugs in case the unfiltered list is capped / delayed.
  if (slugs.size === 0) {
    for (const a of await listConnectedAccounts(apiKey, CURATED_SLUGS, userId)) {
      if (!/^active$/i.test(a?.status ?? "") || a?.is_disabled) continue;
      const slug = String(a?.toolkit?.slug ?? "").toLowerCase();
      if (slug) slugs.add(slug);
    }
  }
  return [...slugs];
}

type ToolsCacheEntry = { at: number; tools: OpenAITool[] };
const toolsCache = new Map<string, ToolsCacheEntry>();

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Important Platform tools for the user's ACTIVE toolkits (ak_ path). */
async function listPlatformToolsOpenAI(
  cfg: ComposioCfg,
  userId?: string,
  preferToolkit?: string | null,
): Promise<OpenAITool[]> {
  const apiKey = resolveApiKey(cfg);
  if (!apiKey) return [];
  // Prefer all ACTIVE accounts (incl. marketplace YouTube), not only curated.
  let items = await listConnectedAccounts(apiKey, [], userId);
  if (!items.length) items = await listConnectedAccounts(apiKey, CURATED_SLUGS, userId);
  let slugs = [
    ...new Set(
      items
        .filter((a) => /^active$/i.test(a?.status ?? "") && !a?.is_disabled)
        .map((a) => String(a?.toolkit?.slug ?? "").toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (preferToolkit && !slugs.includes(preferToolkit)) {
    slugs = [preferToolkit, ...slugs];
  }
  if (!slugs.length) return [];

  // Load the intent toolkit first so Gmail isn't crowded out by Calendar ACL noise.
  if (preferToolkit && slugs.includes(preferToolkit)) {
    slugs = [preferToolkit, ...slugs.filter((s) => s !== preferToolkit)];
  }

  const ranked: OpenAITool[] = [];
  const seen = new Set<string>();
  for (const slug of slugs.slice(0, 6)) {
    try {
      const params = new URLSearchParams({
        toolkit_slug: slug,
        important: "true",
        toolkit_versions: "latest",
        limit: "20",
      });
      const json = await backendJson(apiKey, "GET", `/tools?${params}`);
      const tools: any[] = json?.items ?? json?.data ?? [];
      const forSlug = tools
        .map((t) => toOpenAITool(t))
        .filter((t) => {
          const name = t.function.name;
          if (!name || seen.has(name)) return false;
          seen.add(name);
          return true;
        })
        .sort((a, b) => scoreToolName(b.function.name) - scoreToolName(a.function.name))
        .slice(0, MAX_TOOLS_PER_TOOLKIT);
      ranked.push(...forSlug);
      if (ranked.length >= MAX_COMPOSIO_TOOLS) break;
    } catch (e) {
      console.warn(`[composio] list tools for ${slug}:`, e instanceof Error ? e.message : e);
    }
  }
  return rankAndCapTools(ranked, MAX_COMPOSIO_TOOLS, preferToolkit);
}

/** Execute a tool via Platform API (works with ak_ only). */
async function executePlatformTool(
  cfg: ComposioCfg,
  name: string,
  args: unknown,
  userId?: string,
) {
  const apiKey = resolveApiKey(cfg);
  if (!apiKey) throw new Error("no Composio API key for tool execute");
  const entity = entityUserId(userId);
  const body: Record<string, unknown> = {
    arguments: args && typeof args === "object" ? args : {},
    user_id: entity,
    version: "latest",
    dangerously_skip_version_check: true,
  };
  // Bind to ACTIVE account: GMAIL_* → gmail, YOUTUBE_* → youtube, …
  let all = await listConnectedAccounts(apiKey, [], userId).catch(() => []);
  if (!all.length) all = await listConnectedAccounts(apiKey, CURATED_SLUGS, userId).catch(() => []);
  const upper = name.toUpperCase().replace(/-/g, "_");
  const match = all.find((a) => {
    if (!/^active$/i.test(a?.status ?? "") || a?.is_disabled) return false;
    const slug = String(a?.toolkit?.slug ?? "").toUpperCase().replace(/-/g, "");
    return slug && upper.startsWith(slug);
  });
  if (match?.id) body.connected_account_id = String(match.id);
  return backendJson(apiKey, "POST", `/tools/execute/${encodeURIComponent(name)}`, body);
}

/** Drop cached tool schemas after connect/disconnect so new apps show up immediately. */
export function clearToolsCache() {
  toolsCache.clear();
}

/** Alias for the Ollama in-process tool loop. Prefer Connect MCP when ck_ is set. */
export async function callTool(cfg: ComposioCfg, name: string, args: unknown, userId?: string) {
  if (resolveConnectKey(cfg)) {
    return composioTool(cfg, name, args, userId);
  }
  if (resolveApiKey(cfg)) {
    return executePlatformTool(cfg, name, args, userId);
  }
  throw new Error("no Composio key configured");
}

/** List tools as OpenAI function schemas (Connect MCP or Platform ak_ path). */
export async function listToolsOpenAI(
  cfg: ComposioCfg,
  userId?: string,
  opts?: { signal?: AbortSignal; preferToolkit?: string | null },
): Promise<OpenAITool[]> {
  const prefer = opts?.preferToolkit ?? null;
  const cacheKey = `${entityUserId(userId)}:${resolveApiKey(cfg)?.slice(0, 8) ?? ""}:${resolveConnectKey(cfg)?.slice(0, 8) ?? ""}:${prefer ?? ""}`;
  const cached = toolsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 60_000) return cached.tools;

  const load = async (): Promise<OpenAITool[]> => {
    if (opts?.signal?.aborted) throw new Error("composio listTools aborted");
    if (resolveConnectKey(cfg)) {
      try {
        const res = await fetch(cfg.composio?.url || CONNECT_URL, {
          method: "POST",
          headers: composioHeaders(cfg, userId),
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
          signal: opts?.signal ?? AbortSignal.timeout(LIST_TOOLS_TIMEOUT_MS),
        });
        if (res.ok) {
          const parsed = await parseMcpResponse(await res.text());
          const tools = parsed?.tools ?? parsed?.result?.tools ?? [];
          if (Array.isArray(tools) && tools.length) {
            return rankAndCapTools(
              tools.map((t: any) =>
                toOpenAITool({
                  slug: t.name,
                  description: t.description,
                  input_parameters: t.inputSchema ?? t.parameters,
                }),
              ),
              MAX_COMPOSIO_TOOLS,
              prefer,
            );
          }
        }
      } catch (e) {
        if (opts?.signal?.aborted) throw e;
        console.warn("[composio] Connect tools/list failed:", e instanceof Error ? e.message : e);
      }
    }
    // ak_-only (or Connect empty): load important tools for connected apps.
    return listPlatformToolsOpenAI(cfg, userId, prefer);
  };

  try {
    const tools = await withTimeout(load(), LIST_TOOLS_TIMEOUT_MS, "composio listTools");
    toolsCache.set(cacheKey, { at: Date.now(), tools });
    return tools;
  } catch (e) {
    console.warn("[composio] listTools:", e instanceof Error ? e.message : e);
    return cached?.tools ?? [];
  }
}

function statusFromPlatformItems(
  items: any[],
  slugs: string[],
): Record<string, { connected: boolean; status: string }> {
  const status: Record<string, { connected: boolean; status: string }> = {};
  for (const slug of slugs) {
    const matches = items.filter((a) => (a?.toolkit?.slug ?? "").toLowerCase() === slug.toLowerCase());
    const active = matches.find((a) => /^active$/i.test(a?.status ?? "") && !a?.is_disabled);
    status[slug] = {
      connected: Boolean(active),
      status: active?.status ?? matches[0]?.status ?? "unknown",
    };
  }
  return status;
}

/** Connection status per service slug: { slack: { connected, status } }. */
export async function connectionStatus(cfg: ComposioCfg, slugs: string[], userId?: string) {
  // Prefer Platform API whenever ak_ is present — OAuth Add uses that path,
  // so status must read the same store (Connect MCP won't see those accounts).
  const apiKey = resolveApiKey(cfg);
  if (apiKey) {
    const items = await listConnectedAccounts(apiKey, slugs, userId);
    return statusFromPlatformItems(items, slugs);
  }

  if (resolveConnectKey(cfg)) {
    const out = await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", {
      toolkits: slugs.map((name) => ({ name, action: "list" })),
    }, userId);
    const results = out?.data?.results ?? {};
    const status: Record<string, { connected: boolean; status: string }> = {};
    for (const slug of slugs) {
      const r = results[slug];
      const active =
        (r?.accounts ?? []).some((a: any) => /active/i.test(a.status ?? "")) || /^active$/i.test(r?.status ?? "");
      status[slug] = { connected: active, status: r?.status ?? "unknown" };
    }
    return status;
  }

  throw new Error("no Composio key configured — paste ak_… (API key) or ck_… (Connect) in App Settings");
}

/** Disconnect a service: remove every connected account for the slug. */
export async function removeService(cfg: ComposioCfg, slug: string, userId?: string) {
  if (resolveConnectKey(cfg)) {
    const out = await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", {
      toolkits: [{ name: slug, action: "list" }],
    }, userId);
    const accounts = out?.data?.results?.[slug]?.accounts ?? [];
    const ids = accounts.map((a: any) => a.id ?? a.account_id ?? a.nanoid).filter(Boolean);
    for (const id of ids) {
      await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", {
        toolkits: [{ name: slug, action: "remove", account_id: id }],
      }, userId);
    }
    return { removed: ids.length };
  }

  const apiKey = resolveApiKey(cfg);
  if (!apiKey) {
    throw new Error("no Composio key configured — paste ak_… (API key) or ck_… (Connect) in App Settings");
  }
  const items = await listConnectedAccounts(apiKey, [slug], userId);
  const ids = items
    .filter((a) => (a?.toolkit?.slug ?? "").toLowerCase() === slug.toLowerCase())
    .map((a) => a?.id)
    .filter(Boolean);
  for (const id of ids) {
    await backendJson(apiKey, "DELETE", `/connected_accounts/${encodeURIComponent(String(id))}`);
  }
  return { removed: ids.length };
}

/** Mint a browser auth link for one service. Returns { url } or throws. */
export async function authorizeService(cfg: ComposioCfg, slug: string, userId?: string) {
  const callbackUrl = pluginCallbackUrl();
  if (resolveConnectKey(cfg)) {
    const out = await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", {
      toolkits: [{ name: slug, action: "add" }],
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    }, userId);
    // be liberal: any https URL mentioning composio/auth wins, else the first
    const raw = JSON.stringify(out);
    const urls = raw.match(/https:\/\/[^"\\\s]+/g) ?? [];
    const url = urls.find((u) => /composio|connect|auth/i.test(u)) ?? urls[0];
    if (!url) throw new Error(`Composio returned no auth link for ${slug}`);
    return { url };
  }

  const apiKey = resolveApiKey(cfg);
  if (!apiKey) {
    throw new Error("no Composio key configured — paste ak_… (API key) or ck_… (Connect) in App Settings");
  }
  const authConfigId = await ensureAuthConfigId(apiKey, slug);
  const linked = await backendJson(apiKey, "POST", "/connected_accounts/link", {
    auth_config_id: authConfigId,
    user_id: entityUserId(userId),
    ...(callbackUrl ? { callback_url: callbackUrl } : {}),
  });
  const url = linked?.redirect_url ?? linked?.redirectUrl ?? linked?.url;
  if (!url) throw new Error(`Composio returned no auth link for ${slug}`);
  return { url: String(url) };
}

function pluginCallbackUrl(): string | undefined {
  const origin = process.env.OMB_PUBLIC_URL?.trim().replace(/\/$/, "");
  if (!origin) return undefined;
  return `${origin}/?plugins=1`;
}

// ── marketplace catalog ────────────────────────────────────────────────
export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  /** used for the client-side favicon fallback when logo is null/broken */
  domain: string | null;
}

// Curated fallback — the services agentcal's connectors page ships plus the
// long marketplace tail. Logos resolve client-side:
// logo → favicon(domain) → monogram.
const CURATED: ToolkitCard[] = [
  { slug: "slack", label: "Slack", blurb: "Post updates and read channels", domain: "slack.com", logo: null },
  { slug: "github", label: "GitHub", blurb: "Issues, pull requests, and code", domain: "github.com", logo: null },
  { slug: "gmail", label: "Gmail", blurb: "Read and send email", domain: "gmail.com", logo: null },
  { slug: "googlecalendar", label: "Google Calendar", blurb: "Read and create events", domain: "calendar.google.com", logo: null },
  { slug: "youtube", label: "YouTube", blurb: "Channels, videos, and playlists", domain: "youtube.com", logo: null },
  { slug: "googlesheets", label: "Google Sheets", blurb: "Read and update spreadsheets", domain: "sheets.google.com", logo: null },
  { slug: "googledocs", label: "Google Docs", blurb: "Read and write documents", domain: "docs.google.com", logo: null },
  { slug: "googledrive", label: "Google Drive", blurb: "Browse and manage files", domain: "drive.google.com", logo: null },
  { slug: "notion", label: "Notion", blurb: "Pages and databases", domain: "notion.so", logo: null },
  { slug: "linear", label: "Linear", blurb: "Issues and project tracking", domain: "linear.app", logo: null },
  { slug: "sentry", label: "Sentry", blurb: "Errors and alerts", domain: "sentry.io", logo: null },
  { slug: "posthog", label: "PostHog", blurb: "Analytics, feature flags, experiments", domain: "posthog.com", logo: null },
  { slug: "discord", label: "Discord", blurb: "Messages and channels", domain: "discord.com", logo: null },
  { slug: "x", label: "X (Twitter)", blurb: "Post and read on X", domain: "x.com", logo: null },
  { slug: "reddit", label: "Reddit", blurb: "Browse and post", domain: "reddit.com", logo: null },
  { slug: "zapier", label: "Zapier", blurb: "Connect 9,000+ apps", domain: "zapier.com", logo: null },
  { slug: "hubspot", label: "HubSpot", blurb: "CRM search & updates", domain: "hubspot.com", logo: null },
  { slug: "salesforce", label: "Salesforce", blurb: "CRM records and reports", domain: "salesforce.com", logo: null },
  { slug: "jira", label: "Jira", blurb: "Issues and sprints", domain: "atlassian.com", logo: null },
  { slug: "asana", label: "Asana", blurb: "Tasks and projects", domain: "asana.com", logo: null },
  { slug: "trello", label: "Trello", blurb: "Boards and cards", domain: "trello.com", logo: null },
  { slug: "dropbox", label: "Dropbox", blurb: "Files and folders", domain: "dropbox.com", logo: null },
  { slug: "airtable", label: "Airtable", blurb: "Bases and records", domain: "airtable.com", logo: null },
  { slug: "figma", label: "Figma", blurb: "Files and comments", domain: "figma.com", logo: null },
  { slug: "stripe", label: "Stripe", blurb: "Payments and customers", domain: "stripe.com", logo: null },
];

let toolkitCache: { at: number; cards: ToolkitCard[] } | null = null;

/**
 * Marketplace catalog. Tries the v3 toolkits API (official names,
 * descriptions, logos — cached 10 min); falls back to the curated list.
 */
export async function listToolkits(cfg: ComposioCfg): Promise<{ cards: ToolkitCard[]; source: "api" | "curated" }> {
  if (toolkitCache && Date.now() - toolkitCache.at < 10 * 60_000) {
    return { cards: toolkitCache.cards, source: "api" };
  }
  const backendKey = resolveApiKey(cfg) ?? resolveConnectKey(cfg);
  if (backendKey) {
    try {
      const res = await fetch(`${BACKEND_URL}/toolkits?limit=500&sort_by=usage`, {
        headers: { "x-api-key": backendKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const json: any = await res.json();
        const items = json.items ?? json.data ?? [];
        if (Array.isArray(items) && items.length) {
          const cards: ToolkitCard[] = items.map((t: any) => ({
            slug: (t.slug ?? t.key ?? t.name ?? "").toLowerCase(),
            label: t.name ?? t.slug ?? "",
            blurb: (t.meta?.description ?? t.description ?? "").slice(0, 90),
            logo: t.meta?.logo ?? t.logo ?? null,
            domain: null,
          }));
          toolkitCache = { at: Date.now(), cards };
          return { cards, source: "api" };
        }
      }
    } catch {
      /* fall through to curated */
    }
  }
  return { cards: CURATED, source: "curated" };
}

export const CURATED_SLUGS = CURATED.map((c) => c.slug);
