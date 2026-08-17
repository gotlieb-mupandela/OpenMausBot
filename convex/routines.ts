import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

function assertHarness(secret: string) {
  const expected = process.env.OMB_HARNESS_SECRET;
  if (!expected || secret !== expected) {
    throw new Error("Unauthorized harness call");
  }
}

const kind = v.union(v.literal("daily"), v.literal("interval"));

export const listForBot = query({
  args: { secret: v.string(), userId: v.id("users"), botId: v.string() },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const rows = await ctx.db
      .query("routines")
      .withIndex("by_user_bot", (q) => q.eq("userId", args.userId).eq("botId", args.botId))
      .collect();
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  },
});

export const get = query({
  args: { secret: v.string(), userId: v.id("users"), routineId: v.id("routines") },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const row = await ctx.db.get(args.routineId);
    if (!row || row.userId !== args.userId) return null;
    return row;
  },
});

export const listDue = query({
  args: { secret: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    // Filter in-memory so overdue rows are never missed if the compound
    // index range is empty/stale after a schema change.
    const rows = await ctx.db.query("routines").collect();
    return rows
      .filter((r) => r.enabled && r.nextRunAt <= args.now)
      .sort((a, b) => a.nextRunAt - b.nextRunAt)
      .slice(0, 40);
  },
});

export const create = mutation({
  args: {
    secret: v.string(),
    userId: v.id("users"),
    botId: v.string(),
    name: v.string(),
    instruction: v.string(),
    kind,
    hour: v.optional(v.number()),
    minute: v.optional(v.number()),
    timezone: v.optional(v.string()),
    intervalMinutes: v.optional(v.number()),
    enabled: v.boolean(),
    nextRunAt: v.number(),
    lastRunAt: v.union(v.number(), v.null()),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const { secret: _, ...doc } = args;
    return await ctx.db.insert("routines", doc);
  },
});

export const patch = mutation({
  args: {
    secret: v.string(),
    userId: v.id("users"),
    routineId: v.id("routines"),
    name: v.optional(v.string()),
    instruction: v.optional(v.string()),
    kind: v.optional(kind),
    hour: v.optional(v.number()),
    minute: v.optional(v.number()),
    timezone: v.optional(v.string()),
    intervalMinutes: v.optional(v.number()),
    enabled: v.optional(v.boolean()),
    nextRunAt: v.optional(v.number()),
    lastRunAt: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const row = await ctx.db.get(args.routineId);
    if (!row || row.userId !== args.userId) return null;
    const {
      secret: _s,
      userId: _u,
      routineId: _r,
      ...patch
    } = args;
    const clean = Object.fromEntries(Object.entries(patch).filter(([, val]) => val !== undefined));
    await ctx.db.patch(args.routineId, clean);
    return await ctx.db.get(args.routineId);
  },
});

export const remove = mutation({
  args: { secret: v.string(), userId: v.id("users"), routineId: v.id("routines") },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const row = await ctx.db.get(args.routineId);
    if (!row || row.userId !== args.userId) return false;
    await ctx.db.delete(args.routineId);
    return true;
  },
});

export const markRun = mutation({
  args: {
    secret: v.string(),
    routineId: v.id("routines"),
    lastRunAt: v.number(),
    nextRunAt: v.number(),
  },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const row = await ctx.db.get(args.routineId);
    if (!row) return null;
    await ctx.db.patch(args.routineId, {
      lastRunAt: args.lastRunAt,
      nextRunAt: args.nextRunAt,
    });
    return await ctx.db.get(args.routineId);
  },
});
