// Per-user Store registry for SaaS. Desktop mode keeps a single store.
// With Convex configured, SaaS tenants hydrate from Convex and write-through.
import { join } from "node:path";
import { mkdirSync } from "node:fs";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { Store } from "../store.ts";
import * as cx from "./convex.ts";

export class TenantStores {
  private stores = new Map<string, Store>();
  private loading = new Map<string, Promise<Store>>();
  private defaultSelection: () => ModelSelection;

  constructor(defaultSelection: () => ModelSelection) {
    this.defaultSelection = defaultSelection;
  }

  /** Desktop / single-tenant root. */
  desktop(): Store {
    return this.forUserSync("__desktop__");
  }

  /** Sync path for desktop only. */
  private forUserSync(userId: string): Store {
    let store = this.stores.get(userId);
    if (store) return store;
    const root = userId === "__desktop__" ? DATA_DIR : join(DATA_DIR, "tenants", userId);
    mkdirSync(root, { recursive: true });
    store = new Store(this.defaultSelection, root);
    store.seedIfEmpty();
    this.stores.set(userId, store);
    return store;
  }

  async forUser(userId: string): Promise<Store> {
    if (userId === "__desktop__" || !cx.convexConfigured()) {
      return this.forUserSync(userId);
    }

    const cached = this.stores.get(userId);
    if (cached) return cached;

    const inflight = this.loading.get(userId);
    if (inflight) return inflight;

    const load = (async () => {
      try {
        const store = new Store(this.defaultSelection, join(DATA_DIR, "tenants", userId), {
          memoryOnly: true,
        });
        const { bots, messages } = await cx.hydrateFromConvex(userId);
        store.replaceState(bots, messages);
        store.setMirror(cx.createConvexMirror(userId));
        if (!store.bots.length) store.seedIfEmpty();
        await store.flush();
        this.stores.set(userId, store);
        return store;
      } finally {
        // Always clear so a failed hydrate can retry on the next request.
        this.loading.delete(userId);
      }
    })();

    this.loading.set(userId, load);
    return load;
  }

  findByThread(threadId: string): { userId: string; store: Store } | null {
    for (const [userId, store] of this.stores) {
      if (store.botByThread(threadId)) return { userId, store };
    }
    return null;
  }

  findByBotId(botId: string): { userId: string; store: Store } | null {
    for (const [userId, store] of this.stores) {
      if (store.bot(botId)) return { userId, store };
    }
    return null;
  }

  /** Ensure a user's store is loaded (call after auth). */
  async touch(userId: string): Promise<Store> {
    return this.forUser(userId);
  }
}
