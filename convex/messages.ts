import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

function assertHarness(secret: string) {
  const expected = process.env.OMB_HARNESS_SECRET;
  if (!expected || secret !== expected) {
    throw new Error("Unauthorized harness call");
  }
}

const optionCard = v.object({
  title: v.string(),
  subtitle: v.string(),
  options: v.array(v.string()),
  answered: v.optional(v.string()),
  dismissed: v.optional(v.boolean()),
  requestId: v.optional(v.string()),
});

export const listForThread = query({
  args: {
    secret: v.string(),
    userId: v.id("users"),
    threadId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_user_thread", (q) =>
        q.eq("userId", args.userId).eq("threadId", args.threadId),
      )
      .collect();
    const sorted = rows.sort((a, b) => a.at - b.at);
    const cap = args.limit && args.limit > 0 ? Math.floor(args.limit) : sorted.length;
    return sorted.slice(-cap);
  },
});

export const append = mutation({
  args: {
    secret: v.string(),
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
    png: v.optional(v.string()),
    mime: v.optional(v.string()),
    at: v.number(),
  },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const { secret: _, ...doc } = args;
    return await ctx.db.insert("messages", doc);
  },
});

export const patch = mutation({
  args: {
    secret: v.string(),
    userId: v.id("users"),
    threadId: v.string(),
    messageId: v.string(),
    patch: v.any(),
  },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_user_thread", (q) =>
        q.eq("userId", args.userId).eq("threadId", args.threadId),
      )
      .collect();
    const row = rows.find((m) => m.messageId === args.messageId);
    if (!row) return null;
    const allowed = ["text", "card", "tool", "png", "mime", "kind", "role"] as const;
    const next: Record<string, unknown> = {};
    for (const key of allowed) {
      if (args.patch[key] !== undefined) next[key] = args.patch[key];
    }
    await ctx.db.patch(row._id, next);
    return await ctx.db.get(row._id);
  },
});
