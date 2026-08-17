// Per-user Store registry for SaaS. Desktop mode keeps a single store.
// With Convex configured, SaaS tenants hydrate from Convex and write-through.
// Idle workspaces are evicted so ~100 concurrent accounts fit in one process.
import { join } from "node:path";
import { mkdirSync } from "node:fs";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { Store } from "../store.ts";
import * as cx from "./convex.ts";
import { MAX_CACHED_TENANTS, TENANT_IDLE_MS } from "./capacity.ts";

export type TenantStoreHooks = {
  isPinned?: (userId: string) => boolean;
  onEvict?: (userId: string, store: Store) => void;
};

export class TenantStores {
  private stores = new Map<string, Store>();
  private loading = new Map<string, Promise<Store>>();
  private lastAccess = new Map<string, number>();
  private defaultSelection: () => ModelSelection;
  private hooks: TenantStoreHooks;

  constructor(defaultSelection: () => ModelSelection, hooks: TenantStoreHooks = {}) {
    this.defaultSelection = defaultSelection;
    this.hooks = hooks;
  }

  setHooks(hooks: TenantStoreHooks) {
    this.hooks = { ...this.hooks, ...hooks };
  }

  cachedCount() {
    return this.stores.size;
  }

  /** Desktop / single-tenant root. */
  desktop(): Store {
    return this.forUserSync("__desktop__");
  }

  /** Sync path for desktop only. */
  private forUserSync(userId: string): Store {
    let store = this.stores.get(userId);
    if (store) {
      this.touchAccess(userId);
      return store;
    }
    const root = userId === "__desktop__" ? DATA_DIR : join(DATA_DIR, "tenants", userId);
    mkdirSync(root, { recursive: true });
    store = new Store(this.defaultSelection, root);
    store.seedIfEmpty();
    this.stores.set(userId, store);
    this.touchAccess(userId);
    this.prune();
    return store;
  }

  async forUser(userId: string): Promise<Store> {
    if (userId === "__desktop__" || !cx.convexConfigured()) {
      return this.forUserSync(userId);
    }

    const cached = this.stores.get(userId);
    if (cached) {
      this.touchAccess(userId);
      return cached;
    }

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
        this.touchAccess(userId);
        this.prune();
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

  private touchAccess(userId: string) {
    this.lastAccess.set(userId, Date.now());
  }

  private pinned(userId: string) {
    if (userId === "__desktop__") return true;
    const store = this.stores.get(userId);
    if (store?.bots.some((b) => b.busy)) return true;
    return this.hooks.isPinned?.(userId) === true;
  }

  private prune() {
    const now = Date.now();
    const victims = [...this.stores.keys()]
      .filter((id) => !this.pinned(id))
      .sort((a, b) => (this.lastAccess.get(a) ?? 0) - (this.lastAccess.get(b) ?? 0));

    for (const id of victims) {
      const idle = now - (this.lastAccess.get(id) ?? 0) >= TENANT_IDLE_MS;
      const over = this.stores.size > MAX_CACHED_TENANTS;
      if (!idle && !over) break;
      const store = this.stores.get(id);
      if (!store) continue;
      this.stores.delete(id);
      this.lastAccess.delete(id);
      this.hooks.onEvict?.(id, store);
    }
  }
}
