import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

mkdirSync("D:/Temp/User", { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

await page.goto("http://127.0.0.1:5199/", { waitUntil: "networkidle", timeout: 60_000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: "D:/Temp/User/omb-auth.png", fullPage: true });

await page.getByPlaceholder("Your name").fill("Test User");
await page.getByPlaceholder("you@example.com").fill("bad@gmail");
await page.getByPlaceholder("Password (8+ characters)").fill("password123");
const disabledForBadEmail = await page.getByRole("button", { name: "Start free trial" }).isDisabled();

const email = `e2e+${Date.now()}@example.com`;
await page.getByPlaceholder("you@example.com").fill(email);
const enabledForGoodEmail = await page.getByRole("button", { name: "Start free trial" }).isEnabled();
await page.getByRole("button", { name: "Start free trial" }).click();
await page.waitForTimeout(5000);
await page.screenshot({ path: "D:/Temp/User/omb-after-signup.png", fullPage: true });

const hasComposer = await page.getByPlaceholder(/Message|Subscribe|Reconnecting/).count();
const trialBanner = await page.getByText(/trial/i).count();
const bodyText = await page.locator("body").innerText();

let sendStatus = "skipped";
const composer = page.getByPlaceholder(/Message /);
if (await composer.count()) {
  await composer.fill("Reply with exactly: PONG");
  const sendBtn = page.getByTitle("Send");
  if (await sendBtn.count()) await sendBtn.click();
  else await page.keyboard.press("Enter");
  await page.waitForTimeout(12_000);
  await page.screenshot({ path: "D:/Temp/User/omb-after-send.png", fullPage: true });
  const after = await page.locator("body").innerText();
  sendStatus = after.includes("PONG") ? "got-pong" : "attempted-no-pong";
}

console.log(
  JSON.stringify(
    {
      disabledForBadEmail,
      enabledForGoodEmail,
      email,
      hasComposer,
      trialBanner,
      sendStatus,
      bodySnippet: bodyText.slice(0, 500).replace(/\s+/g, " "),
      errors: errors.slice(0, 12),
    },
    null,
    2,
  ),
);

await browser.close();
