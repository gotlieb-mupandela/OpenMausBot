// Box (box.ascii.dev) — cloud computer for bots.
// Desktop: one persistent VM per bot (legacy ogb-* names).
// SaaS: one shared VM per user (omb-u-*), Grok-style shared desktop.
import type { AppConfig } from "./config.ts";

const BOX_API = "https://ascii.dev/api/box/v1";
const READY = new Set(["idle", "ready", "running"]);

/** Who owns the cloud computer — SaaS users share one; desktop keeps per-bot. */
export type BoxOwner = { kind: "user"; userId: string } | { kind: "bot"; botId: string };

export function boxOwnerKey(owner: BoxOwner): string {
  return owner.kind === "user" ? `user:${owner.userId}` : `bot:${owner.botId}`;
}

function boxFetch(cfg: AppConfig, path: string, opts: RequestInit = {}) {
  return fetch(`${BOX_API}${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${cfg.box?.token}`,
      "content-type": "application/json",
      ...(opts.headers ?? {}),
    },
  });
}

async function boxJson(cfg: AppConfig, path: string, opts: RequestInit = {}) {
  const res = await boxFetch(cfg, path, opts);
  const body: any = await res.json().catch(() => null);
  return { ok: res.ok && body?.ok !== false, status: res.status, body };
}

async function boxNameFor(owner: BoxOwner) {
  const seed = owner.kind === "user" ? owner.userId : owner.botId;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  const hash = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (owner.kind === "user") {
    return `omb-u-${hash.slice(0, 16)}`;
  }
  // legacy per-bot names so existing desktop boxes keep resolving
  return `ogb-${owner.botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "")}-${hash.slice(0, 6)}`;
}

export async function runCommand(cfg: AppConfig, boxId: string, command: string, { timeoutMs = 120_000 } = {}) {
  const res = await boxFetch(cfg, `/boxes/${boxId}/commands`, {
    method: "POST",
    body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body: any = await res.json().catch(() => null);
  return {
    ok: res.ok && body?.exitCode === 0,
    exitCode: body?.exitCode ?? null,
    stdout: body?.stdout ?? "",
    stderr: body?.stderr ?? "",
  };
}

async function mintDesktopUrl(cfg: AppConfig, boxId: string, { vncBudgetMs = 60_000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < vncBudgetMs) {
    const { body } = await boxJson(cfg, `/boxes/${boxId}/desktop?vnc=1`, { method: "POST" });
    const url = body?.desktopUrl ?? body?.url;
    if (url) return url;
    if (!body?.provisioning) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const { body } = await boxJson(cfg, `/boxes/${boxId}/desktop`, { method: "POST" });
  return body?.desktopUrl ?? body?.url ?? null;
}

async function waitReady(cfg: AppConfig, boxId: string, budgetMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const { body } = await boxJson(cfg, `/boxes/${boxId}`);
    const state = body?.box?.state;
    if (READY.has(state)) return body.box;
    if (state === "error") return null;
    if (state === "archived") await boxJson(cfg, `/boxes/${boxId}/resume`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
}

export async function findBox(cfg: AppConfig, owner: BoxOwner) {
  const name = await boxNameFor(owner);
  const { body } = await boxJson(cfg, "/boxes");
  const boxes = (body?.boxes ?? []).filter((b: any) => b.name === name && b.state !== "error");
  // Prefer a live box; fall back to archived so we resume instead of creating a second one.
  return (
    boxes.find((b: any) => !["archived", "archiving"].includes(b.state)) ??
    boxes[0] ??
    null
  );
}

/** Trial accounts only allow a few concurrent VMs — sleep extras so create/resume can proceed. */
async function freeConcurrentSlots(cfg: AppConfig, keepBoxId?: string) {
  const { body } = await boxJson(cfg, "/boxes");
  const active = (body?.boxes ?? []).filter(
    (b: any) => b.id !== keepBoxId && !["archived", "archiving", "error"].includes(b.state),
  );
  for (const b of active) {
    await boxJson(cfg, `/boxes/${b.id}/stop`, { method: "POST" }).catch(() => {});
  }
}

export function boxConfigured(cfg: AppConfig) {
  return Boolean(cfg.box?.token);
}

export async function boxStatus(cfg: AppConfig, owner: BoxOwner) {
  if (!boxConfigured(cfg)) return { configured: false, box: null, shared: owner.kind === "user" };
  const box = await findBox(cfg, owner);
  return {
    configured: true,
    shared: owner.kind === "user",
    box: box ? { boxId: box.id, state: box.state, desktopAvailable: box.desktopAvailable ?? null } : null,
  };
}

/**
 * Find-or-create the owner's persistent box, wait for ready, bootstrap, mint desktop URL.
 */
export async function provisionBox(cfg: AppConfig, owner: BoxOwner, displayName: string) {
  if (!boxConfigured(cfg)) {
    throw new Error(
      process.env.OMB_SAAS === "1" || process.env.OMB_SAAS === "true"
        ? "cloud computer not configured — set BOX_TOKEN on the server"
        : 'box provider not enabled — add {"box":{"token":"…"}} to ~/.aishe/config.json',
    );
  }
  const vmName = await boxNameFor(owner);
  let box = await findBox(cfg, owner);
  let created = false;
  if (!box) {
    // Paid accounts allow long TTLs; free-trial Boxes cap auto-stop at 2h.
    const ttls = [8 * 60 * 60, 2 * 60 * 60];
    let createRes: Awaited<ReturnType<typeof boxJson>> | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const ttlSeconds of ttls) {
        createRes = await boxJson(cfg, "/boxes", {
          method: "POST",
          body: JSON.stringify({ ttlSeconds }),
        });
        if (createRes.ok && createRes.body?.box?.id) break;
        const code = createRes.body?.error?.code ?? createRes.body?.code;
        if (code === "trial_auto_stop_required") continue;
        break;
      }
      if (createRes?.ok && createRes.body?.box?.id) break;
      const code = createRes?.body?.error?.code ?? createRes?.body?.code ?? "";
      const msg = String(createRes?.body?.error?.message ?? createRes?.body?.message ?? "");
      const concurrent =
        createRes?.status === 429 ||
        /concurrent|limit_reached|rate_limited|activeBoxes/i.test(`${code} ${msg}`);
      if (attempt === 0 && concurrent) {
        // SaaS: never stop other users' VMs to steal a slot.
        const saas = process.env.OMB_SAAS === "1" || process.env.OMB_SAAS === "true";
        if (saas) break;
        await freeConcurrentSlots(cfg);
        continue;
      }
      break;
    }
    if (!createRes?.ok || !createRes.body?.box?.id) {
      const err = createRes?.body?.error ?? createRes?.body;
      const code = err?.code ?? createRes?.body?.code;
      const msg = err?.message ?? createRes?.body?.message;
      const billingUrl =
        err?.details?.billingUrl ?? createRes?.body?.details?.billingUrl ?? null;
      if (createRes?.status === 402 || code === "billing_required") {
        const hint = msg || "Start a Box plan to create sandboxes.";
        throw new Error(billingUrl ? `${hint} Open ${billingUrl}` : hint);
      }
      throw new Error(msg || `box create failed (${createRes?.status ?? "unknown"})`);
    }
    box = createRes.body.box;
    created = true;
    await boxJson(cfg, `/boxes/${box.id}`, { method: "PATCH", body: JSON.stringify({ name: vmName }) });
  } else if (["archived", "archiving"].includes(box.state)) {
    await freeConcurrentSlots(cfg, box.id);
  }
  const ready = await waitReady(cfg, box.id);
  if (!ready) throw new Error("box did not become ready within 90s — retry in a minute");

  const label = displayName.replace(/["'\\]/g, "");
  const cuaInstall = [
    "sudo apt-get update -qq || true",
    "sudo apt-get install -y -qq gnome-screenshot xclip wmctrl xdotool imagemagick scrot >/dev/null 2>&1 || true",
    'curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 || true',
    'export PATH="$HOME/.local/bin:$PATH"',
    'sudo mkdir -p /opt/ogb && sudo chown "$(whoami)" /opt/ogb',
    "uv venv /opt/ogb/venv --python 3.13 >/dev/null 2>&1 || uv venv /opt/ogb/venv >/dev/null 2>&1 || true",
    "[ -x /opt/ogb/venv/bin/python ] && uv pip install --python /opt/ogb/venv/bin/python cua-computer-server >/dev/null 2>&1 || true",
    "[ -x /opt/ogb/venv/bin/python ] && /opt/ogb/venv/bin/python -c 'import computer_server' 2>/dev/null && touch /opt/ogb/cua-ready || true",
  ].join("; ");
  const bootstrap = [
    "command -v xdotool >/dev/null || sudo apt-get install -y -qq xdotool scrot imagemagick >/dev/null 2>&1 || true",
    `[ -f /opt/ogb/cua-ready ] || [ -f /tmp/ogb-cua-installing ] || { touch /tmp/ogb-cua-installing; nohup bash -c '${cuaInstall.replace(/'/g, "'\\''")}; rm -f /tmp/ogb-cua-installing' > /tmp/ogb-cua-install.log 2>&1 & }`,
    'if [ -f /opt/ogb/cua-ready ] && ! pgrep -f "computer_server" >/dev/null 2>&1; then DISPLAY=${DISPLAY:-:0} nohup /opt/ogb/venv/bin/python -m computer_server --host 127.0.0.1 --port 8000 --width 1280 --height 800 > /tmp/ogb-cua-server.log 2>&1 & fi',
    `tmux has-session -t work 2>/dev/null || tmux new-session -d -s work 'echo; echo "  ▦ ${label}'"'"'s computer — Aishe"; echo; exec bash -i'`,
    "echo bootstrapped",
  ].join("\n");
  let boot;
  for (let attempt = 0; attempt < 5; attempt++) {
    boot = await runCommand(cfg, box.id, bootstrap);
    if (boot.ok || boot.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 3000));
  }

  const joinUrl = await mintDesktopUrl(cfg, box.id);
  return { boxId: box.id, machineName: vmName, reused: !created, state: ready.state, joinUrl, shared: owner.kind === "user" };
}

export async function joinBox(cfg: AppConfig, owner: BoxOwner) {
  const box = await findBox(cfg, owner);
  if (!box) throw new Error("no computer yet — provision it first");
  const ready = await waitReady(cfg, box.id);
  if (!ready) throw new Error("the box did not wake in time — try again");
  return { joinUrl: await mintDesktopUrl(cfg, box.id), state: ready.state ?? null };
}

export async function sleepBox(cfg: AppConfig, owner: BoxOwner) {
  const box = await findBox(cfg, owner);
  if (!box) throw new Error("no computer yet");
  await boxJson(cfg, `/boxes/${box.id}/stop`, { method: "POST" }).catch(() => {});
  return { ok: true };
}

export async function execOnBox(cfg: AppConfig, owner: BoxOwner, command: string) {
  const box = await findBox(cfg, owner);
  if (!box) throw new Error("no computer yet");
  const ready = await waitReady(cfg, box.id, 60_000);
  if (!ready) throw new Error("box did not wake");
  const out = await runCommand(cfg, box.id, String(command ?? "").slice(0, 4000));
  return { exitCode: out.exitCode, stdout: out.stdout.slice(-4000), stderr: out.stderr.slice(-2000) };
}

const SHOT_CMD = [
  "export DISPLAY=${DISPLAY:-:0}",
  "f=/tmp/ogb-panel.png",
  'scrot -o "$f" 2>/dev/null || import -window root "$f" 2>/dev/null || ffmpeg -y -f x11grab -i "$DISPLAY" -frames:v 1 "$f" >/dev/null 2>&1',
  'command -v convert >/dev/null && convert "$f" -resize 1024x "$f" 2>/dev/null || true',
  'test -s "$f" && echo captured',
].join("; ");

export async function screenshotBox(cfg: AppConfig, owner: BoxOwner) {
  const box = await findBox(cfg, owner);
  if (!box) throw new Error("no computer yet");
  if (!READY.has(box.state)) throw new Error(`box is ${box.state}`);
  const out = await runCommand(cfg, box.id, SHOT_CMD, { timeoutMs: 60_000 });
  if (!/captured/.test(out.stdout)) {
    throw new Error(out.stderr.slice(0, 200) || "screen capture failed on the box");
  }
  const { ok, body } = await boxJson(cfg, `/boxes/${box.id}/files?path=/tmp/ogb-panel.png&encoding=base64`);
  const png = body?.content;
  if (!ok || typeof png !== "string" || !png) throw new Error("could not read the frame back from the box");
  return { png, format: "png" as const };
}

/** Ensure the owner's box is awake and return credentials for computer tools. */
export async function ensureComputer(
  cfg: AppConfig,
  owner: BoxOwner,
  displayName: string,
): Promise<{ boxId: string; token: string } | null> {
  if (!boxConfigured(cfg) || !cfg.box?.token) return null;
  let b = await findBox(cfg, owner).catch(() => null);
  if (!b || !READY.has(b.state)) {
    await provisionBox(cfg, owner, displayName);
    b = await findBox(cfg, owner).catch(() => null);
  }
  if (!b) return null;
  return { boxId: b.id, token: cfg.box.token };
}
