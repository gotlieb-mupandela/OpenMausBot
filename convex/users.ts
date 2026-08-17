import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

/** Shared secret between the Node harness and Convex mutations/queries. */
function assertHarness(secret: string) {
  const expected = process.env.OMB_HARNESS_SECRET;
  if (!expected || secret !== expected) {
    throw new Error("Unauthorized harness call");
  }
}

export const findByEmail = query({
  args: { secret: v.string(), email: v.string() },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    return await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email.trim().toLowerCase()))
      .unique();
  },
});

export const findById = query({
  args: { secret: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    return await ctx.db.get(args.userId);
  },
});

export const create = mutation({
  args: {
    secret: v.string(),
    email: v.string(),
    name: v.string(),
    passwordHash: v.string(),
    createdAt: v.number(),
    subscriptionStatus: v.union(
      v.literal("trialing"),
      v.literal("active"),
      v.literal("past_due"),
      v.literal("canceled"),
      v.literal("none"),
    ),
    subscriptionEndsAt: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const email = args.email.trim().toLowerCase();
    const existing = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (existing) throw new Error("email already registered");
    return await ctx.db.insert("users", {
      email,
      name: args.name,
      passwordHash: args.passwordHash,
      createdAt: args.createdAt,
      subscriptionStatus: args.subscriptionStatus,
      subscriptionEndsAt: args.subscriptionEndsAt,
      onboardingCompletedAt: null,
    });
  },
});

export const completeOnboarding = mutation({
  args: { secret: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const user = await ctx.db.get(args.userId);
    if (!user) return null;
    const at = Date.now();
    await ctx.db.patch(args.userId, { onboardingCompletedAt: at });
    return await ctx.db.get(args.userId);
  },
});

export const resetOnboarding = mutation({
  args: { secret: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const user = await ctx.db.get(args.userId);
    if (!user) return null;
    await ctx.db.patch(args.userId, { onboardingCompletedAt: null });
    return await ctx.db.get(args.userId);
  },
});

export const upsertGoogle = mutation({
  args: {
    secret: v.string(),
    email: v.string(),
    name: v.string(),
    googleId: v.string(),
    passwordHash: v.string(),
    createdAt: v.number(),
    subscriptionStatus: v.union(
      v.literal("trialing"),
      v.literal("active"),
      v.literal("past_due"),
      v.literal("canceled"),
      v.literal("none"),
    ),
    subscriptionEndsAt: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const email = args.email.trim().toLowerCase();
    const byGoogle = await ctx.db
      .query("users")
      .withIndex("by_googleId", (q) => q.eq("googleId", args.googleId))
      .unique();
    if (byGoogle) {
      const patch: { name?: string; email?: string } = {};
      if (args.name && args.name !== byGoogle.name) patch.name = args.name;
      if (email !== byGoogle.email) patch.email = email;
      if (Object.keys(patch).length) await ctx.db.patch(byGoogle._id, patch);
      return byGoogle._id;
    }
    const byEmail = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (byEmail) {
      await ctx.db.patch(byEmail._id, {
        googleId: args.googleId,
        ...(args.name ? { name: args.name } : {}),
      });
      return byEmail._id;
    }
    return await ctx.db.insert("users", {
      email,
      name: args.name,
      passwordHash: args.passwordHash,
      createdAt: args.createdAt,
      subscriptionStatus: args.subscriptionStatus,
      subscriptionEndsAt: args.subscriptionEndsAt,
      googleId: args.googleId,
      onboardingCompletedAt: null,
    });
  },
});

export const purgeAll = mutation({
  args: { secret: v.string() },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const messages = await ctx.db.query("messages").collect();
    for (const m of messages) await ctx.db.delete(m._id);
    const bots = await ctx.db.query("bots").collect();
    for (const b of bots) await ctx.db.delete(b._id);
    const users = await ctx.db.query("users").collect();
    for (const u of users) await ctx.db.delete(u._id);
    return { messages: messages.length, bots: bots.length, users: users.length };
  },
});

export const patchSubscription = mutation({
  args: {
    secret: v.string(),
    userId: v.id("users"),
    subscriptionStatus: v.optional(
      v.union(
        v.literal("trialing"),
        v.literal("active"),
        v.literal("past_due"),
        v.literal("canceled"),
        v.literal("none"),
      ),
    ),
    subscriptionEndsAt: v.optional(v.union(v.number(), v.null())),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertHarness(args.secret);
    const user = await ctx.db.get(args.userId);
    if (!user) return null;
    const { secret: _, userId: __, ...patch } = args;
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([, val]) => val !== undefined),
    );
    await ctx.db.patch(args.userId, clean);
    return await ctx.db.get(args.userId);
  },
});
