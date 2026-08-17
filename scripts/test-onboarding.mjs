/** Browser test for SaaS onboarding tour. */
import { chromium } from "playwright";
import { createHmac } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const uid = "jd7efn0376nw1aft9kbt40cfq18cj37p";
const WEB = "http://127.0.0.1:5199";

if (!process.env.CONVEX_URL || !process.env.OMB_HARNESS_SECRET) {
  console.error("Missing CONVEX_URL / OMB_HARNESS_SECRET");
  process.exit(1);
}

const client = new ConvexHttpClient(process.env.CONVEX_URL);
await client.mutation(api.users.resetOnboarding, {
  secret: process.env.OMB_HARNESS_SECRET,
  userId: uid,
});

const secret = process.env.OMB_SESSION_SECRET || "openmausbot-local-dev-secret-change-me";
const payload = { uid, exp: Date.now() + 86400000 };
const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
const sig = createHmac("sha256", secret).update(body).digest("base64url");
const token = `${body}.${sig}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.addCookies([
  {
    name: "omb_session",
    value: token,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  },
]);

const page = await context.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error") console.log("BROWSER ERR:", msg.text());
});
page.on("pageerror", (err) => console.log("PAGE ERR:", err.message));
const results = [];

const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

await page.goto(WEB, { waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelector("#root")?.innerHTML?.length > 100, { timeout: 20000 });
await page.waitForSelector("text=Start tour", { timeout: 15000 });
check("welcome", true, "welcome screen visible");

await page.click("text=Start tour");
await page.waitForSelector("text=Your bot team", { timeout: 5000 });
check("step_bots", true, "bot team step");

for (let i = 0; i < 7; i++) {
  await page.click("text=Next");
  await page.waitForTimeout(500);
}

await page.waitForSelector("text=You're all set", { timeout: 5000 });
check("step_done", true, "final step");

const completeReq = page.waitForResponse(
  (r) => r.url().includes("/api/auth/onboarding-complete") && r.status() === 200,
  { timeout: 10000 },
);
await page.click("text=Get started");
await completeReq;
await page.waitForTimeout(500);
const tourGone = (await page.getByText("Start tour").count()) === 0;
check("tour_dismissed", tourGone, tourGone ? "overlay closed" : "still visible");

const me = await page.evaluate(async () => {
  const r = await fetch("/api/auth/me", { credentials: "include" });
  return r.json();
});
check(
  "onboarding_complete_api",
  me?.user?.needsOnboarding === false,
  `needsOnboarding=${me?.user?.needsOnboarding}`,
);

await browser.close();
const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.error("\nFailed:", failed);
  process.exit(1);
}
console.log("\nAll onboarding checks passed.");
