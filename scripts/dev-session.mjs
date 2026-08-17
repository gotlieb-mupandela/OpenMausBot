/** Mint a dev session cookie + optionally reset onboarding for browser testing. */
import { createHmac } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import * as auth from "../server/saas/auth.ts";

const args = process.argv.slice(2);
const reset = args.includes("--reset-onboarding");
const uid = args.find((a) => !a.startsWith("--")) || "jd7efn0376nw1aft9kbt40cfq18cj37p";

if (!process.env.CONVEX_URL || !process.env.OMB_HARNESS_SECRET) {
  console.error("Set CONVEX_URL and OMB_HARNESS_SECRET");
  process.exit(1);
}

if (reset) {
  const client = new ConvexHttpClient(process.env.CONVEX_URL);
  await client.mutation(api.users.resetOnboarding, {
    secret: process.env.OMB_HARNESS_SECRET,
    userId: uid,
  });
  console.log("Reset onboarding for", uid);
}

const secret = process.env.OMB_SESSION_SECRET || "local-dev-secret-aishe";
const payload = { uid, exp: Date.now() + 86400000 };
const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
const sig = createHmac("sha256", secret).update(body).digest("base64url");
const token = `${body}.${sig}`;

const user = await auth.findUserById(uid);
console.log("user:", auth.toPublic(user));
console.log("cookie: omb_session=" + encodeURIComponent(token));
