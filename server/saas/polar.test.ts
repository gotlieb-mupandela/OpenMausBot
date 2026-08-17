import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { AISHE_PLUS_CHECKOUT, checkoutUrl, entitlementFromEvent, verifyWebhook } from "./polar.ts";

const SECRET = "test-polar-webhook-secret";

function sign(body: string, id = "msg_1", timestamp = String(Math.floor(Date.now() / 1000))) {
  const signed = `${id}.${timestamp}.${body}`;
  const sig = createHmac("sha256", Buffer.from(SECRET, "utf8")).update(signed).digest("base64");
  return {
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${sig}`,
    },
    body,
  };
}

afterEach(() => {
  delete process.env.POLAR_CHECKOUT_URL;
});

describe("checkoutUrl", () => {
  it("uses the Aishe Plus buy link and prefills Polar query params", () => {
    const url = checkoutUrl({
      email: "plus@example.com",
      name: "Ada",
      referenceId: "user_1",
    });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(AISHE_PLUS_CHECKOUT);
    expect(u.searchParams.get("customer_email")).toBe("plus@example.com");
    expect(u.searchParams.get("customer_name")).toBe("Ada");
    expect(u.searchParams.get("reference_id")).toBe("user_1");
  });

  it("honors POLAR_CHECKOUT_URL when set", () => {
    process.env.POLAR_CHECKOUT_URL = "https://buy.polar.sh/polar_cl_other";
    expect(checkoutUrl({}).startsWith("https://buy.polar.sh/polar_cl_other")).toBe(true);
  });
});

describe("verifyWebhook", () => {
  it("accepts a valid Standard Webhooks signature", () => {
    const payload = JSON.stringify({ type: "order.paid", data: { status: "paid" } });
    const { headers, body } = sign(payload);
    const event = verifyWebhook(body, headers, SECRET);
    expect(event.type).toBe("order.paid");
  });

  it("rejects a bad signature", () => {
    const payload = JSON.stringify({ type: "order.paid", data: { status: "paid" } });
    const { headers, body } = sign(payload);
    expect(() =>
      verifyWebhook(body, { ...headers, "webhook-signature": "v1,aaaa" }, SECRET),
    ).toThrow(/invalid webhook signature/);
  });
});

describe("entitlementFromEvent", () => {
  it("activates Plus from subscription.active with reference_id", () => {
    const got = entitlementFromEvent({
      type: "subscription.active",
      data: {
        id: "sub_1",
        status: "active",
        customer_id: "cus_1",
        current_period_end: "2026-09-17T00:00:00.000Z",
        metadata: { reference_id: "user_1" },
        customer: { id: "cus_1", email: "plus@example.com" },
      },
    });
    expect(got?.userId).toBe("user_1");
    expect(got?.email).toBe("plus@example.com");
    expect(got?.fields).toMatchObject({
      subscriptionStatus: "active",
      polarCustomerId: "cus_1",
      polarSubscriptionId: "sub_1",
    });
    expect(got?.fields.subscriptionEndsAt).toBe(Date.parse("2026-09-17T00:00:00.000Z"));
  });

  it("marks canceled from subscription.canceled", () => {
    const got = entitlementFromEvent({
      type: "subscription.canceled",
      data: { id: "sub_1", status: "canceled", customer: { email: "a@b.co" } },
    });
    expect(got?.fields.subscriptionStatus).toBe("canceled");
  });

  it("ignores incomplete subscription.created", () => {
    expect(
      entitlementFromEvent({
        type: "subscription.created",
        data: { id: "sub_1", status: "incomplete" },
      }),
    ).toBeNull();
  });
});
