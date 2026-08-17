/** In-process limits so one Node host can serve ~100 SaaS accounts. */

export const MAX_CACHED_TENANTS = 100;
export const TENANT_IDLE_MS = 10 * 60_000;
export const MAX_MESSAGES_PER_THREAD = 80;
export const MAX_GLOBAL_TURNS = 20;
export const MAX_TURNS_PER_USER = 2;

export type MessageLike = {
  kind?: string;
  png?: string;
};

/** Keep a short tail in RAM and drop screenshot payloads except the latest. */
export function trimThreadMessages<T extends MessageLike>(messages: T[], max = MAX_MESSAGES_PER_THREAD): T[] {
  const slice = messages.length > max ? messages.slice(-max) : messages.slice();
  let lastScreen = -1;
  for (let i = slice.length - 1; i >= 0; i--) {
    if (slice[i].kind === "screen" && slice[i].png) {
      lastScreen = i;
      break;
    }
  }
  return slice.map((m, i) => {
    if (m.kind === "screen" && m.png && i !== lastScreen) {
      const { png: _png, ...rest } = m;
      return rest as T;
    }
    return m;
  });
}

export class TurnGate {
  private held = new Set<string>();
  private perUser = new Map<string, number>();

  get globalCount() {
    return this.held.size;
  }

  tryAcquire(userId: string, botId: string): { ok: true } | { ok: false; status: 429; error: string } {
    if (this.held.has(botId)) return { ok: true };
    if (this.held.size >= MAX_GLOBAL_TURNS) {
      return { ok: false, status: 429, error: "the service is busy — try again in a moment" };
    }
    const n = this.perUser.get(userId) ?? 0;
    if (n >= MAX_TURNS_PER_USER) {
      return {
        ok: false,
        status: 429,
        error: "this account already has bots working — wait for them to finish",
      };
    }
    this.held.add(botId);
    this.perUser.set(userId, n + 1);
    return { ok: true };
  }

  release(botId: string, userId: string) {
    if (!this.held.delete(botId)) return;
    const n = (this.perUser.get(userId) ?? 1) - 1;
    if (n <= 0) this.perUser.delete(userId);
    else this.perUser.set(userId, n);
  }
}

export const turnGate = new TurnGate();
