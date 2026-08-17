import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // mobile
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto("http://127.0.0.1:5199/", { waitUntil: "networkidle", timeout: 60_000 });
await page.waitForTimeout(1000);

const email = `parity+${Date.now()}@example.com`;
const nameField = page.getByPlaceholder("Your name");
if (await nameField.count()) {
  await nameField.fill("Parity");
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByPlaceholder("Password (8+ characters)").fill("password123");
  await page.getByRole("button", { name: "Start free trial" }).click();
  await page.waitForTimeout(4000);
}

// open computer panel if a monitor/computer control exists
const computerBtn = page.getByTitle(/computer/i).or(page.locator('button[title*="Computer"]'));
let computerOpened = false;
if (await computerBtn.count()) {
  await computerBtn.first().click();
  await page.waitForTimeout(2000);
  computerOpened = true;
}

const body = await page.locator("body").innerText();
const cookies = await page.context().cookies();
const session = cookies.find((c) => c.name === "omb_session");

let computerApi = null;
if (session) {
  const bots = await page.evaluate(async () => {
    const r = await fetch("/api/bots", { credentials: "include" });
    return r.json();
  });
  const botId = bots.bots?.[0]?.id;
  if (botId) {
    computerApi = await page.evaluate(async (id) => {
      const r = await fetch(`/api/bots/${id}/computer`, { credentials: "include" });
      return r.json();
    }, botId);
  }
}

console.log(
  JSON.stringify(
    {
      email,
      computerOpened,
      hasTeamCopy: /team computer|shared by all bots|cloud computer/i.test(body),
      computerApi,
      errors: errors.slice(0, 8),
      snippet: body.slice(0, 280).replace(/\s+/g, " "),
    },
    null,
    2,
  ),
);

await browser.close();
