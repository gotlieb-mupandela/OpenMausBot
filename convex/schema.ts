import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const subscriptionStatus = v.union(
  v.literal("trialing"),
  v.literal("active"),
  v.literal("past_due"),
  v.literal("canceled"),
  v.literal("none"),
);

const modelSelection = v.object({
  instanceId: v.string(),
  model: v.optional(v.string()),
});

const optionCard = v.object({
  title: v.string(),
  subtitle: v.string(),
  options: v.array(v.string()),
  answered: v.optional(v.string()),
  dismissed: v.optional(v.boolean()),
  requestId: v.optional(v.string()),
});

/**
 * SaaS cloud data for OpenMausBot.
 * Desktop mode keeps local JSON; the Node harness owns providers + SSE.
 */
export default defineSchema({
  users: defineTable({
    email: v.string(),
    name: v.string(),
    passwordHash: v.string(),
    createdAt: v.number(),
    subscriptionStatus,
    subscriptionEndsAt: v.union(v.number(), v.null()),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    googleId: v.optional(v.string()),
  }).index("by_email", ["email"]).index("by_googleId", ["googleId"]),

  bots: defineTable({
    userId: v.id("users"),
    botId: v.string(),
    threadId: v.string(),
    name: v.string(),
    title: v.string(),
    description: v.string(),
    notifications: v.boolean(),
    color: v.string(),
    mascotExpression: v.optional(v.union(v.string(), v.null())),
    unread: v.boolean(),
    modelSelection,
    resumeCursors: v.any(),
    computer: v.optional(
      v.union(v.literal("cloud"), v.literal("local"), v.literal("off")),
    ),
    pinned: v.optional(v.boolean()),
    hidden: v.optional(v.boolean()),
    busy: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_botId", ["botId"])
    .index("by_threadId", ["threadId"])
    .index("by_user_botId", ["userId", "botId"]),

  messages: defineTable({
    userId: v.id("users"),
    threadId: v.string(),
    messageId: v.string(),
    role: v.union(v.literal("bot"), v.literal("user")),
    kind: v.union(
      v.literal("text"),
      v.literal("options"),
      v.literal("activity"),
      v.literal("screen"),
    ),
    text: v.optional(v.string()),
    card: v.optional(optionCard),
    tool: v.optional(
      v.object({
        name: v.string(),
        ok: v.optional(v.boolean()),
      }),
    ),
    /** Prefer Convex file storage later; base64 kept for parity with local store. */
    png: v.optional(v.string()),
    mime: v.optional(v.string()),
    at: v.number(),
  })
    .index("by_thread", ["threadId"])
    .index("by_user_thread", ["userId", "threadId"])
    .index("by_messageId", ["messageId"]),
});
