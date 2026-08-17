import { describe, expect, it, afterEach } from "vitest";
import { TenantStores } from "./tenants.ts";
import { MAX_CACHED_TENANTS } from "./capacity.ts";
import { DATA_DIR } from "../config.ts";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const selection = () => ({ instanceId: "ghost", model: "x" });

function cleanupTestTenants() {
  const root = join(DATA_DIR, "tenants");
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    if (/^(user-|other-|busy-user)/.test(name)) {
      rmSync(join(root, name), { recursive: true, force: true });
    }
  }
}

afterEach(() => cleanupTestTenants());

describe("TenantStores cache", () => {
  it("evicts idle tenants so at most MAX_CACHED_TENANTS stay in memory", async () => {
    cleanupTestTenants();
    const tenants = new TenantStores(selection);
    for (let i = 0; i < MAX_CACHED_TENANTS + 8; i++) {
      await tenants.forUser(`user-${i}`);
    }
    expect(tenants.cachedCount()).toBeLessThanOrEqual(MAX_CACHED_TENANTS);
    expect(tenants.cachedCount()).toBeGreaterThan(0);
  });

  it("does not evict a tenant with a busy bot", async () => {
    cleanupTestTenants();
    const tenants = new TenantStores(selection);
    const pinned = await tenants.forUser("busy-user");
    const bot = pinned.bots[0];
    expect(bot).toBeTruthy();
    pinned.patchBot(bot.id, { busy: true });
    for (let i = 0; i < MAX_CACHED_TENANTS + 4; i++) {
      await tenants.forUser(`other-${i}`);
    }
    expect(tenants.findByBotId(bot.id)?.userId).toBe("busy-user");
  });
});
