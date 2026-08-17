import { describe, expect, it } from "vitest";
import { isPlus } from "./auth.ts";
import { FREE_BOT_LIMIT, plusRequiredPayload } from "./plan.ts";

describe("isPlus", () => {
  it("requires an active Polar subscription id", () => {
    expect(isPlus({ subscriptionStatus: "active" })).toBe(false);
    expect(isPlus({ subscriptionStatus: "active", polarSubscriptionId: "sub_1" })).toBe(true);
    expect(isPlus({ subscriptionStatus: "trialing", polarSubscriptionId: "sub_1" })).toBe(true);
    expect(isPlus({ subscriptionStatus: "canceled", polarSubscriptionId: "sub_1" })).toBe(false);
  });
});

describe("plan", () => {
  it("keeps Free at one bot", () => {
    expect(FREE_BOT_LIMIT).toBe(1);
    expect(plusRequiredPayload("Plugins").error).toBe("plus_required");
  });
});
