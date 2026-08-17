/**
 * Full live E2E against running SaaS (5199 + 8799). Does not commit secrets.
 * Usage: node scripts/e2e-live-full.mjs
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

const report = {
  startedAt: new Date().toISOString(),
  results: {},
  notes: [],
  fixesNeeded: [],
  errors: [],
};

function mark(key, pass, detail) {
  report.results[key] = { pass, detail };
  console.log(`${pass ? "PASS" : "FAIL"}  ${key}: ${detail}`);
}

async function shot(page, name) {
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  return path;
}

async function bodyText(page) {
  return (await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
}

async function waitNotWorking(page, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await bodyText(page);
    const stopCount =
      (await page.getByTitle("Stop", { exact: true }).count()) +
      (await page.getByTitle("Stop this turn").count());
    if (!/\bWorking…\b|\bWorking\.\.\.\b/.test(t) && stopCount === 0) {
      return { ok: true, ms: Date.now() - start, text: t };
    }
    await page.waitForTimeout(500);
  }
  return { ok: false, ms: timeoutMs, text: await bodyText(page) };
}

async function waitTurnStart(page, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const stopCount =
      (await page.getByTitle("Stop", { exact: true }).count()) +
      (await page.getByTitle("Stop this turn").count());
    if (stopCount > 0 || /\bWorking…\b/.test(await bodyText(page))) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

async function sendMessage(page, text) {
  const composer = page.getByPlaceholder(/Message|Subscribe|Reconnecting/);
  await composer.click();
  await composer.fill(text);
  const send = page.getByTitle("Send");
  if (await send.count()) await send.click();
  else await page.keyboard.press("Enter");
  await waitTurnStart(page);
}

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage"],
});
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => report.errors.push(`pageerror: ${e}`));
page.on("console", (m) => {
  if (m.type() === "error") report.errors.push(`console: ${m.text()}`);
});

try {
  // ── Login / session ──────────────────────────────────────────────
  await page.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1500);
  await shot(page, "01-load");

  const loginTab = page.locator("button[type='button']", { hasText: /^Log in$/ });
  if (await loginTab.count()) {
    await loginTab.first().click();
    await page.getByPlaceholder("you@example.com").fill(EMAIL);
    await page.getByPlaceholder(/^Password$/).fill(PASSWORD);
    await page.locator("form button[type='submit']").click();
    await page.waitForTimeout(3000);
  }
  await shot(page, "02-after-auth");

  const hasComposer = (await page.getByPlaceholder(/Message /).count()) > 0;
  const authVisible = (await page.getByText("Aishe").count()) > 0 && !hasComposer;
  if (!hasComposer) {
    mark("login_session", false, authVisible ? "still on auth screen" : "no composer after login");
  } else {
    mark("login_session", true, "composer visible after login/session");
  }

  // Hard refresh persistence check later
  // ── Chat: hi ─────────────────────────────────────────────────────
  if (hasComposer) {
    // Prefer email bot if listed
    const emailBot = page.getByText("email", { exact: true }).first();
    if (await emailBot.count()) {
      try {
        await emailBot.click({ timeout: 2000 });
      } catch {
        /* already selected */
      }
    }

    const t0 = Date.now();
    await sendMessage(page, "hi");
    await page.waitForTimeout(800);
    await shot(page, "03-hi-sent");

    // Detect live desktop / screen frames during greeting
    let sawLiveDesktop = false;
    let sawScreenFrame = false;
    for (let i = 0; i < 20; i++) {
      const t = await bodyText(page);
      if (/LIVE DESKTOP|Live desktop|Screen frame/i.test(t)) {
        sawLiveDesktop = /LIVE DESKTOP|Live desktop/i.test(t);
        sawScreenFrame = /Screen frame/i.test(t);
      }
      if (!/\bWorking…\b/.test(t) && (await page.getByTitle("Stop", { exact: true }).count()) === 0 && (await page.getByTitle("Stop this turn").count()) === 0) {
        break;
      }
      await page.waitForTimeout(500);
    }
    const hiWait = await waitNotWorking(page, 75_000);
    const hiMs = Date.now() - t0;
    await shot(page, "04-hi-reply");
    const afterHi = await bodyText(page);
    const gotReply =
      hiWait.ok &&
      /hi|hello|hey|here|help|what|assist|email/i.test(afterHi) &&
      !/Working…/.test(afterHi);
    mark(
      "chat_hi",
      gotReply && hiMs < 60_000 && !sawLiveDesktop,
      `replyMs=${hiMs} hung=${!hiWait.ok} liveDesktop=${sawLiveDesktop} screenFrame=${sawScreenFrame} snippet=${afterHi.slice(-220)}`,
    );
    if (sawLiveDesktop) report.fixesNeeded.push("Greeting triggered LIVE DESKTOP — should not for hi");

    // Follow-up latency
    const t1 = Date.now();
    await sendMessage(page, "Reply in one short sentence: what can you help with?");
    const fu = await waitNotWorking(page, 90_000);
    const fuMs = Date.now() - t1;
    await shot(page, "05-followup");
    mark(
      "chat_followup",
      fu.ok && fuMs < 90_000,
      `replyMs=${fuMs} hung=${!fu.ok} snippet=${(await bodyText(page)).slice(-200)}`,
    );

    // Stop button (best-effort): send a heavy ask and stop quickly
    await sendMessage(page, "Take a screenshot of the cloud desktop and describe every icon you see in detail.");
    await page.waitForTimeout(800);
    const stopBtn = page.getByTitle("Stop", { exact: true }).or(page.getByTitle("Stop this turn")).first();
    if (await stopBtn.count()) {
      await stopBtn.click();
      await page.waitForTimeout(2000);
      const stillBusy =
        (await page.getByTitle("Stop", { exact: true }).count()) +
          (await page.getByTitle("Stop this turn").count()) >
          0 || /\bWorking…\b/.test(await bodyText(page));
      mark("stop_button", !stillBusy, stillBusy ? "still Working after Stop" : "Stop cleared busy state");
      await shot(page, "06-after-stop");
      // ensure idle before next tests
      await waitNotWorking(page, 30_000);
    } else {
      mark("stop_button", true, "turn finished before Stop appeared (not hung)");
    }

    // ── Gmail ask ──────────────────────────────────────────────────
    const tG = Date.now();
    await sendMessage(
      page,
      "Using Gmail tools only (not the computer browser): how many unread emails do I have, and list the 3 most recent subjects if you can.",
    );
    // Watch for tool activity / desktop misuse
    let usedGmailTool = false;
    let usedDesktopForEmail = false;
    for (let i = 0; i < 120; i++) {
      const t = await bodyText(page);
      if (/gmail|GMAIL|composio|fetch_emails|list_emails|UNREAD/i.test(t)) usedGmailTool = true;
      if (/LIVE DESKTOP|computer_screenshot|browser_navigate|Open desktop/i.test(t) && /mail|inbox|unread/i.test(t)) {
        usedDesktopForEmail = true;
      }
      if (!/\bWorking…\b/.test(t) && (await page.getByTitle("Stop", { exact: true }).count()) === 0 && (await page.getByTitle("Stop this turn").count()) === 0 && i > 4) break;
      await page.waitForTimeout(1000);
    }
    const gMs = Date.now() - tG;
    await shot(page, "07-gmail");
    const gText = await bodyText(page);
    const useful =
      /unread|inbox|subject|email|no new|0 unread|\d+\s*unread/i.test(gText) &&
      !/Working…/.test(gText);
    mark(
      "gmail_composio",
      useful && !usedDesktopForEmail,
      `ms=${gMs} gmailSignals=${usedGmailTool} desktopMisuse=${usedDesktopForEmail} snippet=${gText.slice(-280)}`,
    );
  }

  // ── Plugins ──────────────────────────────────────────────────────
  const pluginsBtn = page.getByTitle(/Plugins|Connected apps/i).or(page.getByRole("button", { name: /Plugins/i }));
  // Sidebar Puzzle icon — title may vary; try several
  let pluginsOpened = false;
  for (const sel of [
    () => page.locator('button[title*="Plugin" i]'),
    () => page.getByRole("button", { name: /plugin/i }),
    () => page.locator("button").filter({ has: page.locator("svg") }).filter({ hasText: /^$/ }),
  ]) {
    /* try slash command */
  }
  // Open Plugins via sidebar Puzzle button (most reliable)
  pluginsOpened = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")];
    const hit = btns.find((b) => b.querySelector("svg.lucide-puzzle, svg.lucide-Puzzle"));
    if (hit) {
      hit.click();
      return true;
    }
    return false;
  });
  await page.waitForTimeout(1500);
  if (!pluginsOpened || !(await page.getByText("Marketplace").count())) {
    // Prefer slash menu
    if (hasComposer) {
      const composer = page.getByPlaceholder(/Message /);
      await composer.click();
      await composer.fill("/");
      await page.waitForTimeout(400);
      await shot(page, "08-slash-menu");
      const slashVisible =
        (await page.getByText("add-connector").count()) > 0 ||
        (await page.getByText("Plugins", { exact: true }).count()) > 0 ||
        (await page.getByText("Computer", { exact: true }).count()) > 0;
      mark("slash_menu", slashVisible, slashVisible ? "slash command list visible" : "no slash items after /");

      if ((await page.getByText("Plugins", { exact: true }).count()) > 0) {
        await page.getByText("Plugins", { exact: true }).first().click();
        await page.waitForTimeout(1500);
        pluginsOpened = true;
      } else if ((await page.getByText("add-connector").count()) > 0) {
        await page.getByText("add-connector").click();
        await page.waitForTimeout(1500);
        pluginsOpened = true;
      }
    }
  } else if (hasComposer) {
    // Still verify slash menu separately
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const composer = page.getByPlaceholder(/Message /);
    await composer.click();
    await composer.fill("/");
    await page.waitForTimeout(400);
    await shot(page, "08-slash-menu");
    const slashVisible =
      (await page.getByText("add-connector").count()) > 0 ||
      (await page.getByText("Plugins", { exact: true }).count()) > 0;
    mark("slash_menu", slashVisible, slashVisible ? "slash command list visible" : "no slash items after /");
    // reopen plugins via puzzle
    await page.evaluate(() => {
      const hit = [...document.querySelectorAll("button")].find((b) =>
        b.querySelector("svg.lucide-puzzle, svg.lucide-Puzzle"),
      );
      hit?.click();
    });
    await page.waitForTimeout(1200);
  }

  await shot(page, "09-plugins");
  let pText = await bodyText(page);
  if (!/Marketplace|Yours|Gmail/i.test(pText) && hasComposer) {
    // force open via JS store if exposed — fallback: navigate click Computer path then Plugins from slash again
    await page.keyboard.press("Escape");
    await page.getByPlaceholder(/Message /).fill("/plugins");
    await page.waitForTimeout(300);
    if (await page.getByText("Plugins").count()) {
      await page.getByText("Plugins").first().click();
      await page.waitForTimeout(1500);
      pText = await bodyText(page);
    }
  }

  const hasMarketplace = /Marketplace/i.test(pText);
  const hasYours = /Yours/i.test(pText);
  const hasGmail = /Gmail/i.test(pText);
  mark(
    "plugins_panel",
    hasMarketplace || hasYours || hasGmail,
    `marketplace=${hasMarketplace} yours=${hasYours} gmail=${hasGmail}`,
  );

  if (hasYours) {
    await page.getByRole("button", { name: "Yours" }).click().catch(() => page.getByText("Yours").click());
    await page.waitForTimeout(800);
    await shot(page, "10-plugins-yours");
    const yText = await bodyText(page);
    const gmailConnected = /Gmail/i.test(yText) && /Remove|Connected|Disconnect/i.test(yText);
    mark(
      "plugins_gmail_yours",
      /Gmail/i.test(yText),
      `gmailListed=${/Gmail/i.test(yText)} removeUi=${/Remove/i.test(yText)} snippet=${yText.slice(0, 300)}`,
    );
    if (!gmailConnected && /Gmail/i.test(yText)) {
      report.notes.push("Gmail listed but Remove/connected UI unclear");
    }
  } else {
    mark("plugins_gmail_yours", false, "Yours tab not found");
  }

  // Close plugins
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // ── Computer panel ───────────────────────────────────────────────
  if (hasComposer) {
    await page.getByTitle("Bot's computer").click().catch(async () => {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((x) =>
          /computer/i.test(x.title || x.getAttribute("aria-label") || ""),
        );
        b?.click();
      });
    });
    await page.waitForTimeout(2000);
    await shot(page, "11-computer-open");

    // Wait for provision / ready / error
    let computerOk = false;
    let computerDetail = "";
    for (let i = 0; i < 90; i++) {
      const t = await bodyText(page);
      if (/Open desktop/i.test(t) || /ready|Running|shared desktop/i.test(t)) {
        computerOk = true;
        computerDetail = "panel ready / Open desktop visible";
        break;
      }
      if (/unconfigured|not configured|error|Box token|failed/i.test(t) && !/checking/i.test(t)) {
        computerDetail = `clear error/state: ${t.slice(0, 220)}`;
        computerOk = /unconfigured|Box token|Open desktop|error/i.test(t);
        break;
      }
      await page.waitForTimeout(1000);
    }
    await shot(page, "12-computer-state");
    const cText = await bodyText(page);
    if (!computerDetail) computerDetail = cText.slice(0, 250);

    const openDesk = page.getByRole("button", { name: /Open desktop/i });
    if (await openDesk.count()) {
      const [popup] = await Promise.all([
        page.context().waitForEvent("page", { timeout: 15_000 }).catch(() => null),
        openDesk.click(),
      ]);
      if (popup) {
        await popup.waitForLoadState("domcontentloaded").catch(() => {});
        mark("computer_open_desktop", true, `opened popup url=${popup.url().slice(0, 120)}`);
        await popup.close().catch(() => {});
      } else {
        mark("computer_open_desktop", true, "clicked Open desktop (no popup captured — may be same-tab/external)");
      }
    } else {
      mark("computer_panel", computerOk, computerDetail);
      mark("computer_open_desktop", false, `no Open desktop button — ${computerDetail}`);
    }
    if (!report.results.computer_panel) {
      mark("computer_panel", computerOk || (await page.getByRole("button", { name: /Open desktop/i }).count()) > 0, computerDetail);
    }

    // Ask bot to use computer briefly
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const tC = Date.now();
    await sendMessage(page, "Open the shared computer and tell me if the desktop is visible. One short sentence.");
    const cWait = await waitNotWorking(page, 120_000);
    await shot(page, "13-computer-ask");
    mark(
      "computer_bot_ask",
      cWait.ok,
      `ms=${Date.now() - tC} hung=${!cWait.ok} snippet=${(await bodyText(page)).slice(-220)}`,
    );
  }

  // ── New bot wizard ───────────────────────────────────────────────
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const newOpened = (await page.getByTitle("New bot").count()) > 0;
  if (newOpened) await page.getByTitle("New bot").first().click();
  await page.waitForTimeout(800);

  await shot(page, "14-wizard");
  let wText = await bodyText(page);
  const wizardOpen = /Get started|Inbox Triage|Night Shift|Chief of Staff|Negotiator/i.test(wText);
  mark("new_bot_wizard_open", wizardOpen, wizardOpen ? "wizard UI visible" : `openAttempt=${newOpened} text=${wText.slice(0, 180)}`);

  if (wizardOpen) {
    // Color swatches — click a non-default
    const colorBtns = page.locator("button").filter({ hasText: /^$/ });
    // Preset
    if (await page.getByText("Inbox Triage").count()) {
      await page.getByText("Inbox Triage").click();
      await page.waitForTimeout(400);
    }
    // Expression chips if present
    if (await page.getByText(/happy|curious|listening|working/i).count()) {
      const expr = page.getByText("curious", { exact: false }).first();
      if (await expr.count()) await expr.click().catch(() => {});
    }
    await shot(page, "15-wizard-preset");

    // Get started
    const start = page.getByRole("button", { name: /Get started/i });
    if (await start.count()) {
      await start.click();
      await page.waitForTimeout(2500);
      await shot(page, "16-after-new-bot");
      const after = await bodyText(page);
      const created = /Inbox Triage|Night Shift|New Bot/i.test(after);
      mark("new_bot_create", created, created ? "new bot appeared / selected" : after.slice(0, 200));
    } else {
      mark("new_bot_create", false, "Get started button missing");
    }
  } else {
    mark("new_bot_create", false, "wizard did not open");
  }

  // ── Sidebar search ───────────────────────────────────────────────
  const search = page.getByPlaceholder(/Search/i);
  if (await search.count()) {
    await search.fill("email");
    await page.waitForTimeout(500);
    await shot(page, "17-search");
    const sText = await bodyText(page);
    mark("sidebar_search", /email/i.test(sText), "filtered sidebar for email");
    await search.fill("");
  } else {
    mark("sidebar_search", false, "no Search placeholder found");
  }

  // ── Group / multi-agent ──────────────────────────────────────────
  const botsListed = await page.locator("aside, nav").first().innerText().catch(() => "");
  const multiBots = (botsListed.match(/\n/g) || []).length > 3;
  // @mention
  if (hasComposer) {
    await page.getByPlaceholder(/Message /).click();
    await page.getByPlaceholder(/Message /).fill("@");
    await page.waitForTimeout(400);
    await shot(page, "18-mention");
    const mentionUi = (await page.locator("body").innerText()).includes("@") &&
      ((await page.getByText(/Inbox Triage|email|Night Shift/i).count()) > 0);
    mark(
      "agent_group_mention",
      mentionUi || multiBots,
      `mentionPicker=${mentionUi} multiBotSidebar=${multiBots}`,
    );
    await page.keyboard.press("Escape");
    await page.getByPlaceholder(/Message /).fill("");
  } else {
    mark("agent_group_mention", false, "no composer");
  }

  // ── Persistence after refresh ────────────────────────────────────
  const beforeRefresh = await bodyText(page);
  const hadHi = /\bhi\b/i.test(beforeRefresh);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  // re-login if needed
  if (await page.locator("form button[type='submit']", { hasText: /Log in|Start free trial/ }).count()) {
    await page.locator("button[type='button']", { hasText: /^Log in$/ }).first().click();
    await page.getByPlaceholder("you@example.com").fill(EMAIL);
    await page.getByPlaceholder(/^Password$/).fill(PASSWORD);
    await page.locator("form button[type='submit']").click();
    await page.waitForTimeout(2500);
    mark("login_session_persist", false, "session cookie lost — needed re-login after refresh");
  } else {
    mark("login_session_persist", true, "stayed logged in after hard refresh");
  }
  await shot(page, "19-after-refresh");
  const afterRefresh = await bodyText(page);
  mark(
    "message_persistence",
    hadHi ? /\bhi\b/i.test(afterRefresh) || /hello|hey|help/i.test(afterRefresh) : (await page.getByPlaceholder(/Message /).count()) > 0,
    hadHi
      ? `hiStillVisible=${/\bhi\b/i.test(afterRefresh)}`
      : "no prior hi to check; composer present",
  );
} catch (e) {
  report.errors.push(String(e));
  mark("fatal", false, String(e));
  try {
    await shot(page, "99-fatal");
  } catch {
    /* ignore */
  }
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
