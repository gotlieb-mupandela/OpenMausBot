import { internalAction } from "./_generated/server.js";

const DEFAULT_PUBLIC_URL = "https://grokbot-killer.onrender.com";
const COLD_START_MS = 90_000;

function publicOrigin(): string | null {
  const raw = (process.env.OMB_PUBLIC_URL ?? DEFAULT_PUBLIC_URL).trim().replace(/\/$/, "");
  if (!raw) return null;
  if (/localhost|127\.0\.0\.1/i.test(raw)) return null;
  return raw;
}

/** Ping Render so a Free instance does not spin down after 15 minutes idle. */
export const pingRender = internalAction({
  handler: async () => {
    const origin = publicOrigin();
    if (!origin) return { skipped: true as const };
    const secret = process.env.OMB_HARNESS_SECRET?.trim();
    const headers: Record<string, string> = {};
    if (secret) headers.authorization = `Bearer ${secret}`;
    const res = await fetch(`${origin}/api/cron/routines`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(COLD_START_MS),
    });
    if (res.ok) return { ok: true as const, status: res.status, via: "cron" as const };
    const health = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(COLD_START_MS),
    });
    return { ok: health.ok, status: health.status, via: "health" as const, cronStatus: res.status };
  },
});
