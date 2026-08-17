// SaaS feature flags — platform-hosted models, multi-user auth, public bind.
export const SAAS_MODE = process.env.OMB_SAAS === "1" || process.env.OMB_SAAS === "true";

export const SAAS_HOST = process.env.OMB_HOST || (SAAS_MODE ? "0.0.0.0" : "127.0.0.1");

export const SAAS_PLAN = {
  id: "pro",
  name: "Pro",
  priceLabel: "$29/mo",
  /** cents — used when Stripe is wired */
  priceCents: 2900,
};

/** Session / password signing secret. Required in SaaS (generate one for prod). */
export function sessionSecret(): string {
  const s = process.env.OMB_SESSION_SECRET || process.env.SESSION_SECRET;
  if (s) return s;
  if (SAAS_MODE) {
    // Local-dev fallback so `pnpm dev:saas` works out of the box.
    // Production MUST set OMB_SESSION_SECRET.
    console.warn("[saas] OMB_SESSION_SECRET unset — using insecure local default");
    return "openmausbot-local-dev-secret-change-me";
  }
  return "desktop";
}
