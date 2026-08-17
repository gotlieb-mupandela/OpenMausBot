// Config + data dirs. One file, ~/.openmausbot/config.json, env fallbacks:
//   { "xai": {"key":"xai-…"}, "ollama": {"key":"…"}, "composio": {"key":"ck_…"}, "box": {"token":"…"},
//     "instances": { "<instanceId>": {"driver":"grok", …} } }
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { InstanceConfigMap } from "./contracts.ts";

export interface AppConfig {
  xai?: { key?: string; url?: string };
  /** Ollama Cloud API key (ollama.com/settings/keys). */
  ollama?: { key?: string; url?: string };
  /** key = ck_… Connect consumer key (Connect MCP agent tools);
   * apiKey = ak_… project API key — catalog logos + OAuth Add/disconnect
   * via Platform connected_accounts (works without ck_). */
  composio?: { key?: string; apiKey?: string; url?: string };
  box?: { token?: string };
  /** The person using the app (collected in onboarding, shown in the
   * sidebar). Not a secret — echoed back by GET /api/config. */
  profile?: { name?: string; email?: string };
  instances?: InstanceConfigMap;
}

export const DATA_DIR = join(homedir(), ".openmausbot");
const LEGACY_DATA_DIR = join(homedir(), ".opengrokbot");
export const EVENTS_DIR = join(DATA_DIR, "events");
export const NATIVE_DIR = join(DATA_DIR, "native");

export function ensureDirs() {
  // one-time migration from the pre-rename data dir — bots, transcripts,
  // config and keys all carry over
  if (!existsSync(DATA_DIR) && existsSync(LEGACY_DATA_DIR)) {
    try {
      renameSync(LEGACY_DATA_DIR, DATA_DIR);
    } catch {
      /* cross-device or busy — fall through to a fresh dir */
    }
  }
  for (const dir of [DATA_DIR, EVENTS_DIR, NATIVE_DIR]) mkdirSync(dir, { recursive: true });
}

export function loadConfig(): AppConfig {
  let cfg: AppConfig = {};
  try {
    let raw = readFileSync(join(DATA_DIR, "config.json"), "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    cfg = JSON.parse(raw);
  } catch {
    /* first run — env fallbacks below */
  }
  cfg.xai = { key: process.env.XAI_API_KEY, ...cfg.xai };
  cfg.ollama = { key: process.env.OLLAMA_API_KEY, ...cfg.ollama };
  cfg.composio = {
    ...cfg.composio,
    key: cfg.composio?.key ?? process.env.COMPOSIO_KEY,
    apiKey: cfg.composio?.apiKey ?? process.env.COMPOSIO_API_KEY,
  };
  // Prefer non-empty env when disk saved blank placeholders.
  if (!cfg.composio.apiKey?.trim() && process.env.COMPOSIO_API_KEY?.trim()) {
    cfg.composio.apiKey = process.env.COMPOSIO_API_KEY.trim();
  }
  if (!cfg.composio.key?.trim() && process.env.COMPOSIO_KEY?.trim()) {
    cfg.composio.key = process.env.COMPOSIO_KEY.trim();
  }
  // Recover mis-paste: ak_ saved in Connect key field → treat as project API key.
  const ck = cfg.composio.key?.trim();
  if (ck?.startsWith("ak_") && !cfg.composio.apiKey) {
    cfg.composio.apiKey = ck;
    cfg.composio.key = undefined;
    try {
      saveConfig({ composio: { apiKey: ck, key: "" } });
    } catch {
      /* in-memory only if disk write fails */
    }
  }
  cfg.box = { token: process.env.BOX_TOKEN, ...cfg.box };
  return cfg;
}

/** Merge a partial config into ~/.openmausbot/config.json (secrets never
 * echoed back — callers report configured-or-not booleans only). */
export function saveConfig(patch: Partial<AppConfig>): void {
  const p = join(DATA_DIR, "config.json");
  let disk: Record<string, unknown> = {};
  try {
    disk = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    /* first write */
  }
  for (const key of ["xai", "ollama", "composio", "box", "profile"] as const) {
    if (patch[key] && typeof patch[key] === "object") {
      disk[key] = { ...(disk[key] as object), ...patch[key] };
    }
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(p, JSON.stringify(disk, null, 2));
}

// Default fleet: one instance per built-in driver (upstream
// defaultInstanceIdForDriver — instanceId defaults to the driver kind).
// Config-file keys are injected as per-instance environment so drivers
// see them without needing real process env vars.
export function instanceConfigs(cfg: AppConfig): InstanceConfigMap {
  // The default `grok` instance rides the `grokAgent` driver, not the API-key
  // one: like claude and codex it needs no credential from us, just the CLI
  // installed and logged in (it shows up unavailable otherwise). The API-key
  // `grok` driver stays registered but out of the default fleet — that key is
  // a credential Milind doesn't want to manage; an `instances` entry brings
  // it back anytime.
  const map: InstanceConfigMap =
    cfg.instances && Object.keys(cfg.instances).length
      ? cfg.instances
      : process.env.OMB_SAAS === "1" || process.env.OMB_SAAS === "true"
        ? {
            // SaaS: platform-hosted cloud models only (no local CLIs).
            ollama: { driver: "ollama" },
          }
        : {
            ollama: { driver: "ollama" },
            grok: { driver: "grokAgent" },
            gemini: { driver: "geminiAgent" },
            claude: { driver: "claudeAgent" },
            codex: { driver: "codex" },
            computer: { driver: "boxAgent" },
          };
  for (const entry of Object.values(map)) {
    entry.environment = {
      ...(cfg.xai?.key ? { XAI_API_KEY: cfg.xai.key } : {}),
      ...(cfg.ollama?.key ? { OLLAMA_API_KEY: cfg.ollama.key } : {}),
      ...(cfg.box?.token ? { BOX_TOKEN: cfg.box.token } : {}),
      ...entry.environment,
    };
  }
  return map;
}
