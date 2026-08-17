import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = "D:/Temp/User/omb-e2e";
mkdirSync(OUT, { recursive: true });
const EMAIL = process.env.OMB_E2E_EMAIL;
const PASSWORD = process.env.OMB_E2E_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error("Set OMB_E2E_EMAIL and OMB_E2E_PASSWORD");
  process.exit(1);
}

const mark = (k, p, d) => console.log(`${p ? "PASS" : "FAIL"}  ${k}: ${d}`);

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

try {
  await page.goto("http://127.0.0.1:5199/", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(1500);

  const emailBox = page.getByPlaceholder(/example\.com|email/i);
  if (await emailBox.count()) {
    const loginTab = page.locator("button[type='button']", { hasText: /^Log in$/ });
    if (await loginTab.count()) await loginTab.first().click();
    await emailBox.first().fill(EMAIL);
    const pass = page.locator("input[type='password']");
    await pass.first().fill(PASSWORD);
    await page.locator("form button[type='submit']").click();
    await page.waitForTimeout(3500);
  }

  const composer = page.getByPlaceholder(/Message /);
  await page.waitForTimeout(1000);
  mark("login_ui", (await composer.count()) > 0, `composer=${await composer.count()}`);
  await page.screenshot({ path: `${OUT}/ui-continue-home.png` });
  if (!(await composer.count())) throw new Error("no composer after auth");

  await composer.click({ force: true });
  await composer.fill("/");
  await page.waitForTimeout(500);
  const slash =
    (await page.getByText("Plugins").count()) + (await page.getByText("Computer").count()) > 0;
  mark("slash_menu", slash, `visible=${slash}`);
  await page.screenshot({ path: `${OUT}/ui-continue-slash.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")];
    btns.find((b) => b.querySelector("svg.lucide-puzzle, svg.lucide-Puzzle"))?.click();
  });
  await page.waitForTimeout(1500);
  const market = await page.getByText("Marketplace").count();
  const yours = await page.getByText("Yours").count();
  mark("plugins_ui", market > 0, `marketplace=${market} yours=${yours}`);
  if (yours) {
    await page.getByText("Yours").first().click();
    await page.waitForTimeout(1200);
  }
  const panelText = await page.locator("body").innerText();
  mark("plugins_gmail_ui", /gmail/i.test(panelText), /gmail/i.test(panelText) ? "gmail in panel" : "no gmail text");
  await page.screenshot({ path: `${OUT}/ui-continue-plugins.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    document.querySelectorAll("div.absolute.inset-0.z-50").forEach((el) => el.remove());
  });

  await composer.click({ force: true });
  await composer.fill("/");
  await page.waitForTimeout(400);
  if (await page.getByText("Computer", { exact: true }).count()) {
    await page.getByText("Computer", { exact: true }).first().click();
    await page.waitForTimeout(1000);
  }
  const computerBits = await page.getByText(/Open desktop|Desktop|Routines|Cloud computer|VM/i).count();
  mark("computer_ui", computerBits > 0, `bits=${computerBits}`);
  await page.screenshot({ path: `${OUT}/ui-continue-computer.png` });
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    document.querySelectorAll("div.absolute.inset-0.z-50").forEach((el) => el.remove());
  });

  await composer.click({ force: true });
  await composer.fill("@");
  await page.waitForTimeout(500);
  const mention =
    (await page.getByText("Buddy").count()) + (await page.getByText("New Bot").count()) > 0;
  mark("mention_picker", mention, `visible=${mention}`);
  await page.screenshot({ path: `${OUT}/ui-continue-mention.png` });

  const billing = await page.getByText(/Trial ended|Subscribe ·/i).count();
  mark("billing_hidden", billing === 0, `nags=${billing}`);
} catch (e) {
  mark("ui_error", false, String(e));
} finally {
  await browser.close();
  console.log("UI DONE");
}
