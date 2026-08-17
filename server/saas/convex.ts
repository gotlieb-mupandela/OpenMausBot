import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import type { BotRecord, Message, StoreMirror } from "../store.ts";
import { MAX_MESSAGES_PER_THREAD, trimThreadMessages } from "./capacity.ts";

export function convexConfigured(): boolean {
  return Boolean(process.env.CONVEX_URL?.trim() && process.env.OMB_HARNESS_SECRET?.trim());
}

function secret(): string {
  const s = process.env.OMB_HARNESS_SECRET;
  if (!s) throw new Error("OMB_HARNESS_SECRET unset");
  return s;
}

export function convexClient(): ConvexHttpClient {
  const url = process.env.CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL unset");
  return new ConvexHttpClient(url);
}

function asUserId(id: string): Id<"users"> {
  return id as Id<"users">;
}

export type ConvexUserRow = {
  _id: Id<"users">;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: number;
  subscriptionStatus: "trialing" | "active" | "past_due" | "canceled" | "none";
  subscriptionEndsAt: number | null;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  polarCustomerId?: string;
  polarSubscriptionId?: string;
  googleId?: string;
  onboardingCompletedAt?: number | null;
};

export async function convexFindUserByEmail(email: string): Promise<ConvexUserRow | null> {
  const client = convexClient();
  return (await client.query(api.users.findByEmail, {
    secret: secret(),
    email,
  })) as ConvexUserRow | null;
}

export async function convexFindUserById(id: string): Promise<ConvexUserRow | null> {
  const client = convexClient();
  try {
    return (await client.query(api.users.findById, {
      secret: secret(),
      userId: asUserId(id),
    })) as ConvexUserRow | null;
  } catch {
    return null;
  }
}

export async function convexCreateUser(input: {
  email: string;
  name: string;
  passwordHash: string;
  createdAt: number;
  subscriptionStatus: ConvexUserRow["subscriptionStatus"];
  subscriptionEndsAt: number | null;
}): Promise<Id<"users">> {
  const client = convexClient();
  return await client.mutation(api.users.create, {
    secret: secret(),
    ...input,
  });
}

export async function convexUpsertGoogle(input: {
  email: string;
  name: string;
  googleId: string;
  passwordHash: string;
  createdAt: number;
  subscriptionStatus: ConvexUserRow["subscriptionStatus"];
  subscriptionEndsAt: number | null;
}): Promise<Id<"users">> {
  const client = convexClient();
  return await client.mutation(api.users.upsertGoogle, {
    secret: secret(),
    ...input,
  });
}

export async function convexCompleteOnboarding(userId: string): Promise<ConvexUserRow | null> {
  const client = convexClient();
  return (await client.mutation(api.users.completeOnboarding, {
    secret: secret(),
    userId: asUserId(userId),
  })) as ConvexUserRow | null;
}

export async function convexPatchSubscription(
  userId: string,
  patch: Partial<{
    subscriptionStatus: ConvexUserRow["subscriptionStatus"];
    subscriptionEndsAt: number | null;
    stripeCustomerId: string;
    stripeSubscriptionId: string;
    polarCustomerId: string;
    polarSubscriptionId: string;
  }>,
): Promise<ConvexUserRow | null> {
  const client = convexClient();
  return (await client.mutation(api.users.patchSubscription, {
    secret: secret(),
    userId: asUserId(userId),
    ...patch,
  })) as ConvexUserRow | null;
}

function toBotRecord(row: {
  botId: string;
  threadId: string;
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: string;
  mascotExpression?: string | null;
  unread: boolean;
  modelSelection: { instanceId: string; model?: string };
  resumeCursors: Record<string, unknown>;
  computer?: BotRecord["computer"];
  pinned?: boolean;
  hidden?: boolean;
  busy?: boolean;
  createdAt: number;
}): BotRecord {
  return {
    id: row.botId,
    threadId: row.threadId,
    name: row.name,
    title: row.title,
    description: row.description,
    notifications: row.notifications,
    color: row.color as BotRecord["color"],
    mascotExpression: row.mascotExpression,
    unread: row.unread,
    modelSelection: {
      instanceId: row.modelSelection.instanceId,
      model: row.modelSelection.model ?? "",
    },
    resumeCursors: (row.resumeCursors ?? {}) as Record<string, unknown>,
    computer: row.computer,
    pinned: row.pinned,
    hidden: row.hidden,
    busy: false,
    createdAt: row.createdAt,
  };
}

function toMessage(row: {
  messageId: string;
  role: Message["role"];
  kind: Message["kind"];
  text?: string;
  card?: Message["card"];
  tool?: Message["tool"];
  png?: string;
  mime?: string;
  at: number;
}): Message {
  return {
    id: row.messageId,
    role: row.role,
    kind: row.kind,
    text: row.text,
    card: row.card,
    tool: row.tool,
    png: row.png,
    mime: row.mime,
    at: row.at,
  };
}

/** Load bots + messages for a user into memory maps. */
export async function hydrateFromConvex(
  userId: string,
): Promise<{ bots: BotRecord[]; messages: Map<string, Message[]> }> {
  const client = convexClient();
  const s = secret();
  const uid = asUserId(userId);
  const rows = await client.query(api.bots.listForUser, { secret: s, userId: uid });
  const bots = rows.map(toBotRecord);
  const messages = new Map<string, Message[]>();
  for (const bot of bots) {
    const msgs = await client.query(api.messages.listForThread, {
      secret: s,
      userId: uid,
      threadId: bot.threadId,
      limit: MAX_MESSAGES_PER_THREAD,
    });
    messages.set(bot.threadId, trimThreadMessages(msgs.map(toMessage)));
  }
  return { bots, messages };
}

export function createConvexMirror(userId: string): StoreMirror {
  const uid = asUserId(userId);
  return {
    async upsertBot(bot) {
      const client = convexClient();
      await client.mutation(api.bots.upsert, {
        secret: secret(),
        userId: uid,
        botId: bot.id,
        threadId: bot.threadId,
        name: bot.name,
        title: bot.title,
        description: bot.description,
        notifications: bot.notifications,
        color: bot.color,
        mascotExpression: bot.mascotExpression ?? null,
        unread: bot.unread,
        modelSelection: bot.modelSelection,
        resumeCursors: bot.resumeCursors,
        computer: bot.computer,
        pinned: bot.pinned,
        hidden: bot.hidden,
        busy: bot.busy,
        createdAt: bot.createdAt,
      });
    },
    async deleteBot(botId) {
      const client = convexClient();
      await client.mutation(api.bots.remove, {
        secret: secret(),
        userId: uid,
        botId,
      });
    },
    async appendMessage(threadId, message) {
      const client = convexClient();
      await client.mutation(api.messages.append, {
        secret: secret(),
        userId: uid,
        threadId,
        messageId: message.id,
        role: message.role,
        kind: message.kind,
        text: message.text,
        card: message.card,
        tool: message.tool,
        png: message.png,
        mime: message.mime,
        at: message.at,
      });
    },
    async patchMessage(threadId, messageId, patch) {
      const client = convexClient();
      await client.mutation(api.messages.patch, {
        secret: secret(),
        userId: uid,
        threadId,
        messageId,
        patch,
      });
    },
  };
}
