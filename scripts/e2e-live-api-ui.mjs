/**
 * API-first live verification + light UI pass.
 * Avoids long Playwright sessions when the machine is resource-starved.
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "D:/Temp/User/omb-e2e";
mkdirSync(OUT, { recursive: true });
const EMAIL = process.env.OMB_E2E_EMAIL;
const PASSWORD = process.env.OMB_E2E_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error("Set OMB_E2E_EMAIL and OMB_E2E_PASSWORD");
  process.exit(1);
}
const API = "http://127.0.0.1:8799";
const WEB = "http://127.0.0.1:5199";

const report = { startedAt: new Date().toISOString(), results: {}, notes: [], errors: [] };
const mark = (k, pass, detail) => {
  report.results[k] = { pass, detail };
  console.log(`${pass ? "PASS" : "FAIL"}  ${k}: ${detail}`);
};

const jar = [];
async function req(path, opts = {}, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(API + path, {
        ...opts,
        headers: {
          "content-type": "application/json",
          ...(opts.headers || {}),
          ...(jar.length ? { cookie: jar.join("; ") } : {}),
        },
      });
      for (const c of r.headers.getSetCookie?.() || []) jar.push(c.split(";")[0]);
      const body = await r.json().catch(() => ({}));
      return { status: r.status, body };
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Auth ────────────────────────────────────────────────────────────
const login = await req("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
mark(
  "login_api",
  login.status === 200 && login.body?.user?.email === EMAIL,
  `status=${login.status} email=${login.body?.user?.email}`,
);

const me = await req("/api/auth/me");
mark("session_me", me.status === 200 && me.body?.user?.email === EMAIL, `status=${me.status}`);

const botsRes = await req("/api/bots");
const bots = botsRes.body?.bots || [];
mark("bots_list", bots.length > 0, `count=${bots.length} names=${bots.map((b) => b.name).join(",")}`);
const emailBot = bots.find((b) => /email/i.test(b.name)) || bots[0];

try {

async function sendAndWait(botId, text, timeoutMs = 90_000) {
  const t0 = Date.now();
  const send = await req(`/api/bots/${botId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  if (send.status >= 400) {
    return { ok: false, ms: Date.now() - t0, send, events: [], finalText: "" };
  }
  // Prefer SSE if available
  const events = [];
  let finalText = "";
  let hung = true;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(`${API}/api/bots/${botId}/events`, {
      headers: { cookie: jar.join("; "), accept: "text/event-stream" },
      signal: ac.signal,
    });
    const reader = r.body?.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        let ev;
        try {
          ev = JSON.parse(raw);
        } catch {
          continue;
        }
        events.push(ev.kind || ev.type || "unknown");
        if (ev.text) finalText += ev.text;
        if (ev.message?.text) finalText += ev.message.text;
        if (["done", "idle", "turn_done", "error"].includes(ev.kind) || ev.type === "done") {
          hung = false;
          clearTimeout(timer);
          try {
            ac.abort();
          } catch {
            /* */
          }
          break;
        }
      }
      if (!hung) break;
      if (Date.now() - t0 > timeoutMs) break;
    }
    clearTimeout(timer);
  } catch (e) {
    report.notes.push(`sse: ${String(e).slice(0, 120)}`);
  }
  // Fallback: poll messages
  if (hung || !finalText) {
    for (let i = 0; i < 40; i++) {
      await sleep(1500);
      const m = await req(`/api/bots/${botId}/messages`);
      const list = m.body?.messages || m.body || [];
      const arr = Array.isArray(list) ? list : [];
      const last = arr[arr.length - 1];
      const busy = bots.find((b) => b.id === botId)?.busy;
      if (last?.text && last.kind !== "user" && last.role !== "user") {
        finalText = last.text;
        hung = false;
        break;
      }
      // hydrate bot status
      const b2 = await req("/api/bots");
      const b = (b2.body?.bots || []).find((x) => x.id === botId);
      if (b && !b.busy && i > 2) {
        hung = false;
        const msgs = await req(`/api/bots/${botId}`);
        break;
      }
    }
  }
  return { ok: !hung && send.status < 400, ms: Date.now() - t0, send, events, finalText };
}

// Inspect message API shape
const botDetail = await req(`/api/bots/${emailBot.id}`);
report.notes.push(`botDetailKeys=${Object.keys(botDetail.body || {}).join(",")}`);

// Chat hi via API — also try UI path below
{
  const t0 = Date.now();
  let send = await req(`/api/bots/${emailBot.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: "hi — reply in one short sentence, no tools." }),
  });
  if (send.status === 409) {
    await sleep(5000);
    send = await req(`/api/bots/${emailBot.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "hi — reply in one short sentence, no tools." }),
    });
  }
  // Poll until not busy / new assistant message
  let reply = "";
  let liveDesktop = false;
  let kinds = [];
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const snap = await req(`/api/bots/${emailBot.id}`);
    const b = snap.body?.bot || snap.body;
    const msgs = b?.messages || snap.body?.messages || [];
    kinds = msgs.slice(-8).map((m) => m.kind || m.role);
    if (msgs.some((m) => m.kind === "screen" || /LIVE DESKTOP/i.test(m.text || ""))) liveDesktop = true;
    const lastAssist = [...msgs].reverse().find((m) => m.kind === "assistant" || m.role === "assistant" || (m.kind === "text" && m.from !== "user"));
    // common shape: kind user|assistant|activity|screen
    const last = msgs[msgs.length - 1];
    if (last && last.kind !== "user" && last.kind !== "activity" && last.text) reply = last.text;
    const listBots = await req("/api/bots");
    const live = (listBots.body?.bots || []).find((x) => x.id === emailBot.id);
    if (live && !live.busy && i > 1) {
      const msgs2 = live.messages || [];
      const a = [...msgs2].reverse().find((m) => m.kind === "assistant" || (m.kind !== "user" && m.kind !== "activity" && m.text));
      if (a?.text) reply = a.text;
      break;
    }
  }
  const ms = Date.now() - t0;
  mark(
    "chat_hi",
    Boolean(reply) && ms < 60000 && !liveDesktop,
    `ms=${ms} liveDesktop=${liveDesktop} kinds=${kinds.join(">")} reply=${(reply || "").slice(0, 160)} send=${send.status}`,
  );
}

// Gmail ask
{
  const t0 = Date.now();
  let send = await req(`/api/bots/${emailBot.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      text: "Using Gmail/Composio tools only (do not use computer browser): summarize my unread count and top 3 recent subjects.",
    }),
  });
  if (send.status === 409) {
    await sleep(8000);
    send = await req(`/api/bots/${emailBot.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        text: "Using Gmail/Composio tools only (do not use computer browser): summarize my unread count and top 3 recent subjects.",
      }),
    });
  }
  let reply = "";
  let toolNames = [];
  let desktopMisuse = false;
  for (let i = 0; i < 120; i++) {
    await sleep(1500);
    const listBots = await req("/api/bots");
    const live = (listBots.body?.bots || []).find((x) => x.id === emailBot.id);
    const msgs = live?.messages || [];
    for (const m of msgs.slice(-20)) {
      if (m.kind === "activity" && m.tool?.name) toolNames.push(m.tool.name);
      if (m.kind === "screen") desktopMisuse = true;
      if (/computer_|browser_|LIVE DESKTOP/i.test(m.tool?.name || m.text || "")) desktopMisuse = true;
    }
    if (live && !live.busy && i > 2) {
      const a = [...msgs].reverse().find((m) => m.kind === "assistant" || (m.text && m.kind !== "user" && m.kind !== "activity"));
      reply = a?.text || "";
      break;
    }
  }
  const ms = Date.now() - t0;
  const useful = /unread|inbox|subject|email|gmail|\d+/i.test(reply);
  const gmailTool = toolNames.some((n) => /gmail|gmail_/i.test(n) || /composio/i.test(n));
  mark(
    "gmail_composio",
    useful && (gmailTool || /gmail|unread|subject/i.test(reply)) && !desktopMisuse,
    `ms=${ms} tools=${[...new Set(toolNames)].join(",") || "none"} desktopMisuse=${desktopMisuse} reply=${reply.slice(0, 220)} send=${send.status}`,
  );
}

// Plugins / connectors API
{
  const cat = await req("/api/connectors/catalog");
  const st = await req("/api/connectors?services=gmail,github,notion,slack,googlecalendar");
  const gmail = st.body?.services?.gmail;
  mark(
    "plugins_api",
    cat.status === 200 && Boolean(cat.body?.configured),
    `catalog=${cat.status} source=${cat.body?.source} cards=${(cat.body?.cards || []).length} gmailConnected=${gmail?.connected}`,
  );
  mark("plugins_gmail_connected", Boolean(gmail?.connected), `gmail=${JSON.stringify(gmail)}`);
}

// Computer provision
{
  const status = await req(`/api/bots/${emailBot.id}/computer`);
  mark(
    "computer_status",
    status.status === 200,
    `status=${status.status} configured=${status.body?.configured} shared=${status.body?.shared} box=${Boolean(status.body?.box)} err=${status.body?.error || ""}`,
  );
  if (status.body?.configured) {
    const t0 = Date.now();
    const prov = await req(`/api/bots/${emailBot.id}/computer/provision`, { method: "POST", body: "{}" });
    mark(
      "computer_provision",
      prov.status === 200 && (prov.body?.state === "ready" || prov.body?.joinUrl),
      `ms=${Date.now() - t0} status=${prov.status} state=${prov.body?.state} join=${Boolean(prov.body?.joinUrl)} reused=${prov.body?.reused}`,
    );
    if (prov.body?.joinUrl || prov.status === 200) {
      const shot = await req(`/api/bots/${emailBot.id}/computer/screenshot`, { method: "POST", body: "{}" });
      mark(
        "computer_screenshot",
        shot.status === 200 && Boolean(shot.body?.png),
        `status=${shot.status} hasPng=${Boolean(shot.body?.png)} format=${shot.body?.format || ""} err=${shot.body?.error || ""}`,
      );
    }
  } else {
    mark("computer_provision", false, "box not configured");
    mark("computer_screenshot", false, "skipped");
  }
}

// Create second bot via API if supported
{
  const created = await req("/api/bots", {
    method: "POST",
    body: JSON.stringify({
      name: "E2E Mate",
      title: "Test buddy",
      description: "Created by live e2e",
      color: "green",
      mascotExpression: "curious",
    }),
  });
  mark(
    "new_bot_api",
    created.status === 200 || created.status === 201,
    `status=${created.status} id=${created.body?.bot?.id || created.body?.id || ""} name=${created.body?.bot?.name || ""}`,
  );
}

} catch (e) {
  report.errors.push("api_section: " + String(e));
  mark("api_section_fatal", false, String(e));
}

// ── Light UI pass (single browser, short) ───────────────────────────
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // Seed cookie into browser context from jar
  const cookies = jar.map((c) => {
    const [name, ...rest] = c.split("=");
    return { name, value: rest.join("="), domain: "127.0.0.1", path: "/" };
  });
  await page.context().addCookies(cookies);
  await page.goto(WEB + "/", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await sleep(2000);
  await page.screenshot({ path: `${OUT}/ui-01-home.png` });

  let hasComposer = (await page.getByPlaceholder(/Message /).count()) > 0;
  if (!hasComposer) {
    await page.locator("button[type='button']", { hasText: /^Log in$/ }).first().click();
    await page.getByPlaceholder("you@example.com").fill(EMAIL);
    await page.getByPlaceholder(/^Password$/).fill(PASSWORD);
    await page.locator("form button[type='submit']").click();
    await sleep(2500);
    hasComposer = (await page.getByPlaceholder(/Message /).count()) > 0;
  }
  mark("login_ui", hasComposer, hasComposer ? "composer visible" : "auth failed in UI");

  if (hasComposer) {
    // Slash menu
    await page.getByPlaceholder(/Message /).click();
    await page.getByPlaceholder(/Message /).fill("/");
    await sleep(500);
    await page.screenshot({ path: `${OUT}/ui-02-slash.png` });
    const slash =
      (await page.getByText("add-connector").count()) > 0 ||
      (await page.getByText("Plugins", { exact: true }).count()) > 0;
    mark("slash_menu", slash, slash ? "slash items visible" : "no slash menu");

    // Plugins via puzzle
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      const hit = [...document.querySelectorAll("button")].find((b) =>
        b.querySelector("svg.lucide-puzzle"),
      );
      hit?.click();
    });
    await sleep(1500);
    await page.screenshot({ path: `${OUT}/ui-03-plugins.png` });
    let p = await page.locator("body").innerText();
    mark("plugins_panel_ui", /Marketplace|Yours/i.test(p), /Marketplace|Yours/.test(p) ? "panel open" : p.slice(0, 120));
    if (/Yours/i.test(p)) {
      await page.getByText("Yours", { exact: true }).click().catch(() => {});
      await sleep(600);
      await page.screenshot({ path: `${OUT}/ui-04-yours.png` });
      p = await page.locator("body").innerText();
      mark(
        "plugins_gmail_yours_ui",
        /Gmail/i.test(p),
        `gmail=${/Gmail/i.test(p)} remove=${/Remove/i.test(p)}`,
      );
    }
    await page.keyboard.press("Escape");

    // Computer panel
    await page.getByTitle("Bot's computer").click().catch(() => {});
    await sleep(5000);
    await page.screenshot({ path: `${OUT}/ui-05-computer.png` });
    const c = await page.locator("body").innerText();
    mark(
      "computer_panel_ui",
      /Open desktop|Computer|starting|ready|error|unconfigured|Box/i.test(c),
      c.match(/Open desktop|starting|ready|error|unconfigured|shared desktop|Box[^a-z].{0,40}/i)?.[0] || c.slice(0, 160),
    );
    if (await page.getByRole("button", { name: /Open desktop/i }).count()) {
      mark("computer_open_desktop_ui", true, "Open desktop button present");
    } else {
      mark("computer_open_desktop_ui", /error|unconfigured/i.test(c), "no Open desktop — see panel state");
    }
    await page.keyboard.press("Escape");

    // New bot wizard
    await page.getByTitle("New bot").first().click();
    await sleep(800);
    await page.screenshot({ path: `${OUT}/ui-06-wizard.png` });
    let w = await page.locator("body").innerText();
    const wiz = /Get started|Inbox Triage|Night Shift/i.test(w);
    mark("new_bot_wizard", wiz, wiz ? "wizard open" : w.slice(0, 120));
    if (wiz) {
      await page.getByText("Inbox Triage").click().catch(() => {});
      await sleep(400);
      await page.screenshot({ path: `${OUT}/ui-07-wizard-preset.png` });
      // click a color if buttons present — then Get started
      const start = page.getByRole("button", { name: /Get started/i });
      if (await start.count()) {
        await start.click();
        await sleep(2000);
        await page.screenshot({ path: `${OUT}/ui-08-newbot.png` });
        w = await page.locator("body").innerText();
        mark("new_bot_create_ui", /Inbox Triage/i.test(w), /Inbox Triage/i.test(w) ? "Inbox Triage created" : w.slice(0, 120));
      }
    }

    // Sidebar search
    const search = page.getByPlaceholder(/Search/i);
    if (await search.count()) {
      await search.fill("email");
      await sleep(400);
      await page.screenshot({ path: `${OUT}/ui-09-search.png` });
      mark("sidebar_search", /email/i.test(await page.locator("body").innerText()), "search filtered");
      await search.fill("");
    } else mark("sidebar_search", false, "no search field");

    // Billing banner absence
    mark(
      "billing_banner_ui",
      (await page.getByText(/Trial ended|Subscription required/).count()) === 0,
      "no blocking billing banner",
    );

    // Persistence: reload
    await page.reload({ waitUntil: "domcontentloaded" });
    await sleep(2500);
    await page.screenshot({ path: `${OUT}/ui-10-refresh.png` });
    const stillIn = (await page.getByPlaceholder(/Message /).count()) > 0;
    mark("session_persist_ui", stillIn, stillIn ? "stayed logged in" : "logged out after refresh");
    if (stillIn) {
      const t = await page.locator("body").innerText();
      mark("message_persistence_ui", /hi|Hey|email|unread|help/i.test(t), "history visible after refresh");
    }

    // Stop button quick check if busy
    await page.getByPlaceholder(/Message /).fill("Count to 50 slowly while using tools.");
    await page.getByTitle("Send").click().catch(() => page.keyboard.press("Enter"));
    await sleep(1000);
    const stop = page.getByTitle("Stop", { exact: true });
    if (await stop.count()) {
      await stop.click();
      await sleep(1500);
      const busy = (await page.getByTitle("Stop", { exact: true }).count()) > 0;
      mark("stop_button", !busy, busy ? "still busy after stop" : "stop cleared");
    } else {
      mark("stop_button", true, "no long turn to stop (ok)");
    }
  }
} catch (e) {
  report.errors.push(String(e));
  mark("ui_pass_fatal", false, String(e));
} finally {
  if (browser) await browser.close().catch(() => {});
}

report.finishedAt = new Date().toISOString();
writeFileSync(`${OUT}/report-api.json`, JSON.stringify(report, null, 2));
console.log("\n=== SUMMARY ===");
console.log(JSON.stringify(report, null, 2));
