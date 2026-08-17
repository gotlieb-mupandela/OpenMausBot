// Email/password users + signed cookie sessions for SaaS mode.
// When CONVEX_URL + OMB_HARNESS_SECRET are set, users live in Convex.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { DATA_DIR } from "../config.ts";
import { newId } from "../contracts.ts";
import { SAAS_PLAN, sessionSecret } from "./mode.ts";
import * as cx from "./convex.ts";

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "none";

export interface SaasUser {
  id: string;
  email: string;
  name: string;
  passwordHash: string; // scrypt salt:hash
  createdAt: number;
  subscriptionStatus: SubscriptionStatus;
  /** trial / paid period end (ms). null = no expiry (dev unlock). */
  subscriptionEndsAt: number | null;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  subscriptionStatus: SubscriptionStatus;
  subscriptionEndsAt: number | null;
  plan: typeof SAAS_PLAN;
  canChat: boolean;
}

const USERS_DIR = join(DATA_DIR, "saas");
const USERS_FILE = join(USERS_DIR, "users.json");
const COOKIE = "omb_session";
const SESSION_DAYS = 30;
const TRIAL_DAYS = 14;

type SessionPayload = { uid: string; exp: number };

function ensure() {
  mkdirSync(USERS_DIR, { recursive: true });
  if (!existsSync(USERS_FILE)) writeFileSync(USERS_FILE, "[]");
}

function loadUsers(): SaasUser[] {
  ensure();
  try {
    return JSON.parse(readFileSync(USERS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveUsers(users: SaasUser[]) {
  ensure();
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function hashPassword(password: string, salt?: Buffer): string {
  const s = salt ?? randomBytes(16);
  const hash = scryptSync(password, s, 64);
  return `${s.toString("hex")}:${hash.toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sign(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verify(token: string): SessionPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expect = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (!payload.uid || !payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
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

function fromConvexRow(row: cx.ConvexUserRow): SaasUser {
  return {
    id: row._id,
    email: row.email,
    name: row.name,
    passwordHash: row.passwordHash,
    createdAt: row.createdAt,
    subscriptionStatus: row.subscriptionStatus,
    subscriptionEndsAt: row.subscriptionEndsAt,
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
  };
}

export function canChat(user: SaasUser): boolean {
  if (user.subscriptionStatus === "active" || user.subscriptionStatus === "trialing") {
    if (user.subscriptionEndsAt != null && Date.now() > user.subscriptionEndsAt) return false;
    return true;
  }
  return false;
}

export function toPublic(user: SaasUser): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    subscriptionStatus: user.subscriptionStatus,
    subscriptionEndsAt: user.subscriptionEndsAt,
    plan: SAAS_PLAN,
    canChat: canChat(user),
  };
}

export async function findUserByEmail(email: string): Promise<SaasUser | null> {
  const e = email.trim().toLowerCase();
  if (cx.convexConfigured()) {
    const row = await cx.convexFindUserByEmail(e);
    return row ? fromConvexRow(row) : null;
  }
  return loadUsers().find((u) => u.email === e) ?? null;
}

export async function findUserById(id: string): Promise<SaasUser | null> {
  if (cx.convexConfigured()) {
    const row = await cx.convexFindUserById(id);
    return row ? fromConvexRow(row) : null;
  }
  return loadUsers().find((u) => u.id === id) ?? null;
}

export async function createUser(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<SaasUser> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw Object.assign(new Error("invalid email"), { status: 400 });
  }
  if (input.password.length < 8) {
    throw Object.assign(new Error("password must be at least 8 characters"), { status: 400 });
  }
  if (await findUserByEmail(email)) {
    throw Object.assign(new Error("email already registered"), { status: 409 });
  }

  const passwordHash = hashPassword(input.password);
  const name = (input.name ?? "").trim() || email.split("@")[0]!;
  const createdAt = Date.now();
  const subscriptionStatus = "trialing" as const;
  const subscriptionEndsAt = Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000;

  if (cx.convexConfigured()) {
    try {
      const id = await cx.convexCreateUser({
        email,
        name,
        passwordHash,
        createdAt,
        subscriptionStatus,
        subscriptionEndsAt,
      });
      return {
        id,
        email,
        name,
        passwordHash,
        createdAt,
        subscriptionStatus,
        subscriptionEndsAt,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("email already registered")) {
        throw Object.assign(new Error("email already registered"), { status: 409 });
      }
      throw e;
    }
  }

  const user: SaasUser = {
    id: newId(),
    email,
    name,
    passwordHash,
    createdAt,
    subscriptionStatus,
    subscriptionEndsAt,
  };
  const users = loadUsers();
  users.push(user);
  saveUsers(users);
  return user;
}

export async function authenticate(email: string, password: string): Promise<SaasUser> {
  const user = await findUserByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw Object.assign(new Error("invalid email or password"), { status: 401 });
  }
  return user;
}

export async function setSubscription(
  userId: string,
  patch: Partial<
    Pick<SaasUser, "subscriptionStatus" | "subscriptionEndsAt" | "stripeCustomerId" | "stripeSubscriptionId">
  >,
): Promise<SaasUser | null> {
  if (cx.convexConfigured()) {
    const row = await cx.convexPatchSubscription(userId, patch);
    return row ? fromConvexRow(row) : null;
  }
  const users = loadUsers();
  const idx = users.findIndex((u) => u.id === userId);
  if (idx === -1) return null;
  users[idx] = { ...users[idx], ...patch };
  saveUsers(users);
  return users[idx];
}

/** Dev/local activate — marks the account paid without Stripe. */
export async function activateLocalSubscription(userId: string): Promise<SaasUser | null> {
  return setSubscription(userId, {
    subscriptionStatus: "active",
    subscriptionEndsAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
}

export function issueSession(res: ServerResponse, userId: string) {
  const token = sign({ uid: userId, exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000 });
  const secure = process.env.OMB_COOKIE_SECURE === "1" ? "; Secure" : "";
  res.setHeader(
    "set-cookie",
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`,
  );
}

export function clearSession(res: ServerResponse) {
  res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export async function userFromRequest(req: IncomingMessage): Promise<SaasUser | null> {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const payload = verify(token);
  if (!payload) return null;
  return findUserById(payload.uid);
}
