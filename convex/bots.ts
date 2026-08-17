import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

function assertHarness(secret: string) {
  const expected = process.env.OMB_HARNESS_SECRET;
  if (!expected || secret !== expected) {
    throw new Error("Unauthorized harness call");
  }
}

const modelSelection = v.object({
  instanceId: v.string(),
  model: v.optional(v.string()),
});

export const listForUser = query({
  args: { secret: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const rows = await ctx.db
      .query("bots")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const getByBotId = query({
  args: { secret: v.string(), botId: v.string() },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    return await ctx.db
      .query("bots")
      .withIndex("by_botId", (q) => q.eq("botId", args.botId))
      .unique();
  },
});

export const getByThreadId = query({
  args: { secret: v.string(), threadId: v.string() },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    return await ctx.db
      .query("bots")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .unique();
  },
});

export const upsert = mutation({
  args: {
    secret: v.string(),
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
  },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const existing = await ctx.db
      .query("bots")
      .withIndex("by_user_botId", (q) =>
        q.eq("userId", args.userId).eq("botId", args.botId),
      )
      .unique();
    const { secret: _, ...doc } = args;
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return existing._id;
    }
    return await ctx.db.insert("bots", doc);
  },
});

export const remove = mutation({
  args: {
    secret: v.string(),
    userId: v.id("users"),
    botId: v.string(),
  },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const bot = await ctx.db
      .query("bots")
      .withIndex("by_user_botId", (q) =>
        q.eq("userId", args.userId).eq("botId", args.botId),
      )
      .unique();
    if (!bot) return false;
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_user_thread", (q) =>
        q.eq("userId", args.userId).eq("threadId", bot.threadId),
      )
      .collect();
    for (const m of messages) await ctx.db.delete(m._id);
    await ctx.db.delete(bot._id);
    return true;
  },
});

export const patch = mutation({
  args: {
    secret: v.string(),
    userId: v.id("users"),
    botId: v.string(),
    patch: v.any(),
  },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const bot = await ctx.db
      .query("bots")
      .withIndex("by_user_botId", (q) =>
        q.eq("userId", args.userId).eq("botId", args.botId),
      )
      .unique();
    if (!bot) return null;
    const allowed = [
      "name",
      "title",
      "description",
      "notifications",
      "color",
      "mascotExpression",
      "unread",
      "modelSelection",
      "resumeCursors",
      "computer",
      "pinned",
      "hidden",
      "busy",
    ] as const;
    const next: Record<string, unknown> = {};
    for (const key of allowed) {
      if (args.patch[key] !== undefined) next[key] = args.patch[key];
    }
    await ctx.db.patch(bot._id, next);
    return await ctx.db.get(bot._id);
  },
});

export const clearBusyForUser = mutation({
  args: { secret: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const bots = await ctx.db
      .query("bots")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const bot of bots) {
      if (bot.busy) await ctx.db.patch(bot._id, { busy: false });
    }
  },
});
