/** Delete all Convex users, bots, and messages (harness-secret gated). */
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

if (!process.env.CONVEX_URL || !process.env.OMB_HARNESS_SECRET) {
  console.error("Set CONVEX_URL and OMB_HARNESS_SECRET");
  process.exit(1);
}

const client = new ConvexHttpClient(process.env.CONVEX_URL);
const result = await client.mutation(api.users.purgeAll, {
  secret: process.env.OMB_HARNESS_SECRET,
});
console.log("Purged:", result);
