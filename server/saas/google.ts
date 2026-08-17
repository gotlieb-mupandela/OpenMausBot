// Google OAuth for SaaS login. Local first: set GOOGLE_CLIENT_ID,
// GOOGLE_CLIENT_SECRET, and OMB_PUBLIC_URL=http://127.0.0.1:5199
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { sessionSecret } from "./mode.ts";

const STATE_COOKIE = "omb_oauth";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim());
}

export function publicOrigin(): string {
  const fromEnv = process.env.OMB_PUBLIC_URL?.trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  const port = process.env.OMB_PORT || process.env.OGB_PORT || "8799";
  return `http://127.0.0.1:${port}`;
}

function redirectUri(): string {
  return `${publicOrigin()}/api/auth/google/callback`;
}

function signState(nonce: string): string {
  const sig = createHmac("sha256", sessionSecret()).update(nonce).digest("base64url");
  return `${nonce}.${sig}`;
}

function verifyState(token: string): boolean {
  const [nonce, sig] = token.split(".");
  if (!nonce || !sig) return false;
  const expect = createHmac("sha256", sessionSecret()).update(nonce).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie ?? "";
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function appendCookie(res: ServerResponse, value: string) {
  const prev = res.getHeader("set-cookie");
  if (!prev) {
    res.setHeader("set-cookie", value);
    return;
  }
  const list = Array.isArray(prev) ? prev.map(String) : [String(prev)];
  res.setHeader("set-cookie", [...list, value]);
}

export function startGoogleLogin(res: ServerResponse) {
  if (!googleConfigured()) {
    throw Object.assign(new Error("Google login is not configured"), { status: 501 });
  }
  const nonce = randomBytes(16).toString("hex");
  const state = signState(nonce);
  appendCookie(
    res,
    `${STATE_COOKIE}=${encodeURIComponent(state)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
  );
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID!.trim());
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  res.writeHead(302, { location: url.toString() });
  res.end();
}

export function clearOauthCookie(res: ServerResponse) {
  appendCookie(res, `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export async function googleProfileFromCallback(
  req: IncomingMessage,
): Promise<{ googleId: string; email: string; name: string }> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const err = url.searchParams.get("error");
  if (err) throw Object.assign(new Error(err === "access_denied" ? "Google sign-in was cancelled" : err), { status: 400 });
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = parseCookies(req)[STATE_COOKIE];
  if (!code || !state || !cookieState || state !== cookieState || !verifyState(state)) {
    throw Object.assign(new Error("Google sign-in expired. Try again."), { status: 400 });
  }

  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID!.trim(),
    client_secret: process.env.GOOGLE_CLIENT_SECRET!.trim(),
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });
  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw Object.assign(new Error(tokenJson.error || "Google token exchange failed"), { status: 401 });
  }

  const infoRes = await fetch(USERINFO_URL, {
    headers: { authorization: `Bearer ${tokenJson.access_token}` },
  });
  const info = (await infoRes.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };
  if (!infoRes.ok || !info.sub || !info.email) {
    throw Object.assign(new Error("Google did not return an email"), { status: 401 });
  }
  if (info.email_verified === false) {
    throw Object.assign(new Error("Google email is not verified"), { status: 401 });
  }
  return {
    googleId: info.sub,
    email: info.email.trim().toLowerCase(),
    name: (info.name ?? "").trim() || info.email.split("@")[0]!,
  };
}
