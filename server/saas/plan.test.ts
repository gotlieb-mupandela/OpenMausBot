import { describe, expect, it } from "vitest";
import { isPlus } from "./auth.ts";
import { FREE_BOT_LIMIT, plusRequiredPayload } from "./plan.ts";

describe("isPlus", () => {
  it("is complimentary for every signed-in user", () => {
    expect(isPlus(null)).toBe(false);
    expect(isPlus(undefined)).toBe(false);
    expect(isPlus({ subscriptionStatus: "none" })).toBe(true);
    expect(isPlus({ subscriptionStatus: "canceled" })).toBe(true);
    expect(isPlus({ subscriptionStatus: "active", polarSubscriptionId: "sub_1" })).toBe(true);
  });
});

describe("plan", () => {
  it("keeps Free at one bot", () => {
    expect(FREE_BOT_LIMIT).toBe(1);
    expect(plusRequiredPayload("Plugins").error).toBe("plus_required");
  });
});
