// Polar checkout + webhooks for Aishe Plus (N$350 / month).
// Checkout uses the Polar-hosted buy link. Entitlement is applied from
// signed webhooks (Standard Webhooks) — never from the success redirect alone.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import * as auth from "./auth.ts";
import type { SubscriptionStatus } from "./auth.ts";

export const AISHE_PLUS_CHECKOUT =
  "https://buy.polar.sh/polar_cl_2jpkDME4cRB5agW7DAxlzYIDhJwCEUELCB19n340DAk";

export type PolarEvent = { type: string; data: Record<string, unknown> };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function header(headers: IncomingHttpHeaders, name: string): string {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

export function checkoutUrl(opts: { email?: string; name?: string; referenceId?: string }): string {
  const base = process.env.POLAR_CHECKOUT_URL?.trim() || AISHE_PLUS_CHECKOUT;
  const u = new URL(base);
  if (opts.email) u.searchParams.set("customer_email", opts.email);
  if (opts.name) u.searchParams.set("customer_name", opts.name);
  if (opts.referenceId) u.searchParams.set("reference_id", opts.referenceId);
  return u.toString();
}

/** Polar SDK base64-encodes the dashboard secret, then Standard Webhooks decodes it — HMAC key is UTF-8 secret bytes. */
export function verifyWebhook(
  rawBody: string,
  headers: IncomingHttpHeaders,
  secret: string,
): PolarEvent {
  const id = header(headers, "webhook-id");
  const timestamp = header(headers, "webhook-timestamp");
  const signatureHeader = header(headers, "webhook-signature");
  if (!id || !timestamp || !signatureHeader) {
    throw Object.assign(new Error("missing webhook headers"), { status: 403 });
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 5 * 60) {
    throw Object.assign(new Error("webhook timestamp too old"), { status: 403 });
  }
  const signed = `${id}.${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", Buffer.from(secret, "utf8")).update(signed).digest("base64");
  const expectedBuf = Buffer.from(expected);
  const ok = signatureHeader.split(" ").some((part) => {
    const sig = part.startsWith("v1,") ? part.slice(3) : part;
    try {
      const got = Buffer.from(sig);
      return got.length === expectedBuf.length && timingSafeEqual(got, expectedBuf);
    } catch {
      return false;
    }
  });
  if (!ok) throw Object.assign(new Error("invalid webhook signature"), { status: 403 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw Object.assign(new Error("invalid webhook json"), { status: 400 });
  }
  const rec = asRecord(parsed);
  const type = str(rec?.type);
  const data = asRecord(rec?.data);
  if (!type || !data) throw Object.assign(new Error("invalid webhook payload"), { status: 400 });
  return { type, data };
}

function mapPolarStatus(st: string | undefined): SubscriptionStatus {
  switch (st) {
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "canceled":
    case "revoked":
    case "incomplete_expired":
      return "canceled";
    default:
      return "active";
  }
}

export function entitlementFromEvent(event: PolarEvent): {
  userId?: string;
  email?: string;
  fields: {
    subscriptionStatus: SubscriptionStatus;
    subscriptionEndsAt?: number | null;
    polarCustomerId?: string;
    polarSubscriptionId?: string;
  };
} | null {
  const { type, data } = event;
  const customer = asRecord(data.customer);
  const metadata = asRecord(data.metadata) ?? {};
  const subscription = asRecord(data.subscription);
  const userId =
    str(metadata.reference_id) ?? str(data.external_customer_id) ?? str(customer?.external_id);
  const email = (str(customer?.email) ?? str(data.customer_email))?.toLowerCase();
  const polarCustomerId = str(data.customer_id) ?? str(customer?.id);
  const polarSubscriptionId = type.startsWith("subscription.")
    ? str(data.id)
    : (str(data.subscription_id) ?? str(subscription?.id));

  let subscriptionStatus: SubscriptionStatus | undefined;
  if (type === "subscription.canceled" || type === "subscription.revoked") {
    subscriptionStatus = "canceled";
  } else if (type === "subscription.past_due") {
    subscriptionStatus = "past_due";
  } else if (
    type === "subscription.active" ||
    type === "subscription.created" ||
    type === "subscription.updated" ||
    type === "subscription.uncanceled"
  ) {
    const st = str(data.status);
    if (st === "incomplete" || st === "incomplete_expired") return null;
    subscriptionStatus = mapPolarStatus(st);
  } else if (type === "order.paid" || (type === "checkout.updated" && str(data.status) === "succeeded")) {
    subscriptionStatus = "active";
  } else {
    return null;
  }

  const periodEnd = str(data.current_period_end) ?? str(data.ends_at);
  const parsedEnd = periodEnd ? Date.parse(periodEnd) : NaN;
  return {
    userId,
    email,
    fields: {
      subscriptionStatus,
      ...(Number.isFinite(parsedEnd) ? { subscriptionEndsAt: parsedEnd } : {}),
      ...(polarCustomerId ? { polarCustomerId } : {}),
      ...(polarSubscriptionId ? { polarSubscriptionId } : {}),
    },
  };
}

export async function handleWebhook(headers: IncomingHttpHeaders, rawBody: string): Promise<void> {
  const secret = process.env.POLAR_WEBHOOK_SECRET?.trim();
  if (!secret) throw Object.assign(new Error("POLAR_WEBHOOK_SECRET unset"), { status: 503 });
  const event = verifyWebhook(rawBody, headers, secret);
  const patch = entitlementFromEvent(event);
  if (!patch) return;
  let user = patch.userId ? await auth.findUserById(patch.userId) : null;
  if (!user && patch.email) user = await auth.findUserByEmail(patch.email);
  if (!user) return;
  await auth.patchSubscription(user.id, patch.fields);
}
