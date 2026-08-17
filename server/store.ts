// Bot + thread persistence. bots.json holds bot records (including the
// thread→instance binding and per-instance resume cursors — upstream's
// ProviderSessionDirectory, recipe step 6: persist the binding from day
// one). messages-<threadId>.json holds the folded transcript.
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId, type ModelSelection, type ThreadId } from "./contracts.ts";
import { MAX_MESSAGES_PER_THREAD } from "./saas/capacity.ts";

export type MausColor =
  | "green"
  | "blue"
  | "red"
  | "orange"
  | "purple"
  | "cyan"
  | "pink"
  | "yellow"
  | "teal"
  | "coral";

/**
 * The face a bot rests on, as one of the engine's state names. Kept as a plain
 * string rather than a union: bots saved under the app's earlier ten-face
 * vocabulary still carry those names, and the client resolves both on read.
 */
export type MausExpression = string;

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
}

export interface Message {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen";
  text?: string;
  card?: OptionCardData;
  /** activity messages: tool name + outcome */
  tool?: { name: string; ok?: boolean };
  /** screen messages: a frame of the bot's computer (base64 image) */
  png?: string;
  mime?: string;
  at: number;
}

export interface BotRecord {
  id: string;
  threadId: ThreadId;
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: MausColor;
  mascotExpression?: MausExpression | null;
  unread: boolean;
  modelSelection: ModelSelection;
  /** provider-native continuation per instance (e.g. claude session id) */
  resumeCursors: Record<string, unknown>;
  /** which computer the bot acts on: its cloud box, this Mac (local CUA),
   * or none. Unset = auto (box when it exists, else local when available). */
  computer?: "cloud" | "local" | "off";
  pinned?: boolean;
  hidden?: boolean;
  busy?: boolean;
  createdAt: number;
}

const COLORS: MausColor[] = [
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
];

/** Resolve @mentions in a message against a bot roster: `@` must start a
 * word, names match case-insensitively, longest name wins (so "@New Bot 2"
 * never half-matches "New Bot"), hidden bots skipped, results deduped.
 * Callers pre-filter the sender out of `peers`. */
export function mentionedBots<T extends { name: string; hidden?: boolean }>(text: string, peers: T[]): T[] {
  const candidates = peers
    .filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  const found: T[] = [];
  let at = -1;
  while ((at = lower.indexOf("@", at + 1)) !== -1) {
    if (at > 0 && !/\s/.test(text[at - 1])) continue; // user@host, not a tag
    const rest = lower.slice(at + 1);
    const hit = candidates.find((p) => rest.startsWith(p.name.toLowerCase()));
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}

const onboardingCard = (): OptionCardData => ({
  title: "What should I be most useful for first?",
  subtitle: "We can add more later. This just points me at the right kind of help.",
  options: ["Work & projects", "Writing & research", "Life admin", "A bit of everything"],
});

/** Optional Convex (or other) write-through for SaaS cloud persistence. */
export interface StoreMirror {
  upsertBot(bot: BotRecord): Promise<void>;
  deleteBot(botId: string): Promise<void>;
  appendMessage(threadId: string, message: Message): Promise<void>;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Promise<void>;
}

export class Store {
  bots: BotRecord[] = [];
  private messages = new Map<string, Message[]>();
  private defaultSelection: () => ModelSelection;
  private rootDir: string;
  private botsFile: string;
  private memoryOnly: boolean;
  private mirror: StoreMirror | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    defaultSelection: () => ModelSelection,
    rootDir: string = DATA_DIR,
    opts?: { memoryOnly?: boolean },
  ) {
    this.defaultSelection = defaultSelection;
    this.rootDir = rootDir;
    this.botsFile = join(rootDir, "bots.json");
    this.memoryOnly = opts?.memoryOnly === true;
    if (!this.memoryOnly) {
      mkdirSync(rootDir, { recursive: true });
      try {
        this.bots = JSON.parse(readFileSync(this.botsFile, "utf8"));
      } catch {
        this.bots = [];
      }
    }
    // busy never survives a restart — no turn does either
    for (const b of this.bots) b.busy = false;
  }

  setMirror(mirror: StoreMirror | null) {
    this.mirror = mirror;
  }

  /** Replace in-memory state after a Convex hydrate (SaaS). */
  replaceState(bots: BotRecord[], messages: Map<string, Message[]>) {
    this.bots = bots.map((b) => ({ ...b, busy: false }));
    this.messages = messages;
  }

  /** Await queued mirror writes (call from HTTP handlers). */
  async flush(): Promise<void> {
    await this.pending;
  }

  private enqueue(op: () => Promise<void>) {
    this.pending = this.pending.then(op).catch((err) => {
      console.error("[store mirror]", err);
    });
  }

  private messagesFile(threadId: string) {
    return join(this.rootDir, `messages-${threadId}.json`);
  }

  private saveBots() {
    if (!this.memoryOnly) {
      writeFileSync(this.botsFile, JSON.stringify(this.bots, null, 2));
    }
  }

  messagesFor(threadId: string): Message[] {
    let list = this.messages.get(threadId);
    if (!list) {
      if (this.memoryOnly) {
        list = [];
      } else {
        try {
          list = JSON.parse(readFileSync(this.messagesFile(threadId), "utf8"));
        } catch {
          list = [];
        }
      }
      this.messages.set(threadId, list!);
    }
    return list!;
  }

  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }): Message {
    const full: Message = { id: newId(), at: Date.now(), ...message };
    const list = this.messagesFor(threadId);
    list.push(full);
    if (this.memoryOnly && list.length > MAX_MESSAGES_PER_THREAD) {
      list.splice(0, list.length - MAX_MESSAGES_PER_THREAD);
    }
    if (!this.memoryOnly) {
      writeFileSync(this.messagesFile(threadId), JSON.stringify(list, null, 2));
    }
    if (this.mirror) this.enqueue(() => this.mirror!.appendMessage(threadId, full));
    return full;
  }

  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null {
    const list = this.messagesFor(threadId);
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...patch, card: patch.card ?? list[idx].card };
    if (!this.memoryOnly) {
      writeFileSync(this.messagesFile(threadId), JSON.stringify(list, null, 2));
    }
    if (this.mirror) this.enqueue(() => this.mirror!.patchMessage(threadId, messageId, patch));
    return list[idx];
  }

  bot(id: string) {
    return this.bots.find((b) => b.id === id) ?? null;
  }

  botByThread(threadId: string) {
    return this.bots.find((b) => b.threadId === threadId) ?? null;
  }

  createBot(): BotRecord {
    const bot: BotRecord = {
      id: newId(),
      threadId: newId(),
      name: "New Bot",
      title: "",
      description: "",
      notifications: true,
      color: COLORS[this.bots.length % COLORS.length],
      unread: false,
      modelSelection: this.defaultSelection(),
      resumeCursors: {},
      computer:
        process.env.OMB_SAAS === "1" || process.env.OMB_SAAS === "true" ? "cloud" : undefined,
      createdAt: Date.now(),
    };
    this.bots.unshift(bot);
    this.saveBots();
    if (this.mirror) this.enqueue(() => this.mirror!.upsertBot(bot));
    this.appendMessage(bot.threadId, {
      role: "bot",
      kind: "text",
      text: "Hey — I'm your new bot. Ready when you are.",
    });
    this.appendMessage(bot.threadId, { role: "bot", kind: "options", card: onboardingCard() });
    return bot;
  }

  deleteBot(id: string): boolean {
    const bot = this.bot(id);
    if (!bot) return false;
    this.bots = this.bots.filter((b) => b.id !== id);
    this.messages.delete(bot.threadId);
    this.saveBots();
    if (!this.memoryOnly) {
      try {
        unlinkSync(this.messagesFile(bot.threadId));
      } catch {}
    }
    if (this.mirror) this.enqueue(() => this.mirror!.deleteBot(id));
    return true;
  }

  patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null {
    const bot = this.bot(id);
    if (!bot) return null;
    Object.assign(bot, patch);
    this.saveBots();
    if (this.mirror) this.enqueue(() => this.mirror!.upsertBot(bot));
    return bot;
  }

  setResumeCursor(botId: string, instanceId: string, cursor: unknown) {
    const bot = this.bot(botId);
    if (!bot) return;
    bot.resumeCursors[instanceId] = cursor;
    this.saveBots();
    if (this.mirror) this.enqueue(() => this.mirror!.upsertBot(bot));
  }

  /** First-run seed for desktop: one bot so the app never opens empty.
   *  SaaS tenants stay empty until the user creates their first bot. */
  seedIfEmpty() {
    if (this.bots.length) return;
    const bot = this.createBot();
    this.patchBot(bot.id, { name: "Milind", color: "blue" });
  }
}
