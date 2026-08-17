// Per-user bot routines: Convex when configured, else routines.json on disk.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "../config.ts";
import { newId } from "../contracts.ts";
import * as cx from "./convex.ts";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";

export type RoutineKind = "daily" | "interval";

export interface Routine {
  id: string;
  userId: string;
  botId: string;
  name: string;
  instruction: string;
  kind: RoutineKind;
  hour?: number;
  minute?: number;
  timezone?: string;
  intervalMinutes?: number;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt: number | null;
  createdAt: number;
}

export type RoutineInput = {
  name: string;
  instruction: string;
  kind: RoutineKind;
  hour?: number;
  minute?: number;
  timezone?: string;
  intervalMinutes?: number;
  enabled?: boolean;
};

const MIN_INTERVAL = 15;

function tenantRoot(userId: string): string {
  return userId === "__desktop__" ? DATA_DIR : join(DATA_DIR, "tenants", userId);
}

function filePath(userId: string): string {
  return join(tenantRoot(userId), "routines.json");
}

function loadLocal(userId: string): Routine[] {
  const p = filePath(userId);
  if (!existsSync(p)) return [];
  try {
    const rows = JSON.parse(readFileSync(p, "utf8")) as Routine[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function saveLocal(userId: string, rows: Routine[]) {
  mkdirSync(tenantRoot(userId), { recursive: true });
  writeFileSync(filePath(userId), JSON.stringify(rows, null, 2));
}

function tzOffsetMs(timeZone: string, instant: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour) % 24;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - instant.getTime();
}

function zonedToUtc(timeZone: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, 0);
  const guess = new Date(wall);
  const first = wall - tzOffsetMs(timeZone, guess);
  return wall - tzOffsetMs(timeZone, new Date(first));
}

function partsInZone(ms: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day) };
}

export function computeNextRunAt(input: {
  kind: RoutineKind;
  hour?: number;
  minute?: number;
  timezone?: string;
  intervalMinutes?: number;
  from?: number;
}): number {
  const from = input.from ?? Date.now();
  if (input.kind === "interval") {
    const mins = Math.max(MIN_INTERVAL, Math.floor(input.intervalMinutes ?? 60));
    return from + mins * 60_000;
  }
  const hour = Math.min(23, Math.max(0, Math.floor(input.hour ?? 9)));
  const minute = Math.min(59, Math.max(0, Math.floor(input.minute ?? 0)));
  const tz = input.timezone?.trim() || "UTC";
  const { y, mo, d } = partsInZone(from, tz);
  let next = zonedToUtc(tz, y, mo, d, hour, minute);
  if (next <= from) {
    const tomorrow = new Date(Date.UTC(y, mo - 1, d + 1));
    next = zonedToUtc(
      tz,
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth() + 1,
      tomorrow.getUTCDate(),
      hour,
      minute,
    );
  }
  return next;
}

export function normalizeCreate(userId: string, botId: string, input: RoutineInput): Routine {
  const name = input.name.trim();
  const instruction = input.instruction.trim();
  if (!name) throw Object.assign(new Error("name required"), { status: 400 });
  if (!instruction) throw Object.assign(new Error("instruction required"), { status: 400 });
  if (input.kind !== "daily" && input.kind !== "interval") {
    throw Object.assign(new Error("kind must be daily or interval"), { status: 400 });
  }
  const intervalMinutes =
    input.kind === "interval" ? Math.max(MIN_INTERVAL, Math.floor(input.intervalMinutes ?? 60)) : undefined;
  const hour = input.kind === "daily" ? Math.min(23, Math.max(0, Math.floor(input.hour ?? 9))) : undefined;
  const minute = input.kind === "daily" ? Math.min(59, Math.max(0, Math.floor(input.minute ?? 0))) : undefined;
  const timezone = input.kind === "daily" ? input.timezone?.trim() || "UTC" : undefined;
  const createdAt = Date.now();
  return {
    id: newId(),
    userId,
    botId,
    name,
    instruction,
    kind: input.kind,
    hour,
    minute,
    timezone,
    intervalMinutes,
    enabled: input.enabled !== false,
    nextRunAt: computeNextRunAt({
      kind: input.kind,
      hour,
      minute,
      timezone,
      intervalMinutes,
      from: createdAt,
    }),
    lastRunAt: null,
    createdAt,
  };
}

function fromConvex(row: {
  _id: string;
  userId: string;
  botId: string;
  name: string;
  instruction: string;
  kind: RoutineKind;
  hour?: number;
  minute?: number;
  timezone?: string;
  intervalMinutes?: number;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt: number | null;
  createdAt: number;
}): Routine {
  return {
    id: row._id,
    userId: row.userId,
    botId: row.botId,
    name: row.name,
    instruction: row.instruction,
    kind: row.kind,
    hour: row.hour,
    minute: row.minute,
    timezone: row.timezone,
    intervalMinutes: row.intervalMinutes,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    createdAt: row.createdAt,
  };
}

function useConvex(userId: string): boolean {
  return cx.convexConfigured() && userId !== "__desktop__";
}

export async function listForBot(userId: string, botId: string): Promise<Routine[]> {
  if (useConvex(userId)) {
    const rows = await cx.convexClient().query(api.routines.listForBot, {
      secret: process.env.OMB_HARNESS_SECRET!,
      userId: userId as Id<"users">,
      botId,
    });
    return rows.map(fromConvex);
  }
  return loadLocal(userId).filter((r) => r.botId === botId);
}

export async function getRoutine(userId: string, routineId: string): Promise<Routine | null> {
  if (useConvex(userId)) {
    const row = await cx.convexClient().query(api.routines.get, {
      secret: process.env.OMB_HARNESS_SECRET!,
      userId: userId as Id<"users">,
      routineId: routineId as Id<"routines">,
    });
    return row ? fromConvex(row) : null;
  }
  return loadLocal(userId).find((r) => r.id === routineId) ?? null;
}

export async function createRoutine(userId: string, botId: string, input: RoutineInput): Promise<Routine> {
  const draft = normalizeCreate(userId, botId, input);
  if (useConvex(userId)) {
    const id = await cx.convexClient().mutation(api.routines.create, {
      secret: process.env.OMB_HARNESS_SECRET!,
      userId: userId as Id<"users">,
      botId,
      name: draft.name,
      instruction: draft.instruction,
      kind: draft.kind,
      hour: draft.hour,
      minute: draft.minute,
      timezone: draft.timezone,
      intervalMinutes: draft.intervalMinutes,
      enabled: draft.enabled,
      nextRunAt: draft.nextRunAt,
      lastRunAt: draft.lastRunAt,
      createdAt: draft.createdAt,
    });
    return { ...draft, id: String(id) };
  }
  const rows = loadLocal(userId);
  rows.push(draft);
  saveLocal(userId, rows);
  return draft;
}

export async function patchRoutine(
  userId: string,
  routineId: string,
  patch: Partial<RoutineInput> & { enabled?: boolean },
): Promise<Routine | null> {
  const existing = await getRoutine(userId, routineId);
  if (!existing) return null;
  const nextKind = patch.kind ?? existing.kind;
  const merged: Routine = {
    ...existing,
    name: patch.name?.trim() || existing.name,
    instruction: patch.instruction?.trim() || existing.instruction,
    kind: nextKind,
    hour: nextKind === "daily" ? (patch.hour ?? existing.hour) : undefined,
    minute: nextKind === "daily" ? (patch.minute ?? existing.minute) : undefined,
    timezone: nextKind === "daily" ? (patch.timezone ?? existing.timezone) : undefined,
    intervalMinutes:
      nextKind === "interval"
        ? Math.max(MIN_INTERVAL, Math.floor(patch.intervalMinutes ?? existing.intervalMinutes ?? 60))
        : undefined,
    enabled: patch.enabled ?? existing.enabled,
  };
  const scheduleChanged =
    patch.kind !== undefined ||
    patch.hour !== undefined ||
    patch.minute !== undefined ||
    patch.timezone !== undefined ||
    patch.intervalMinutes !== undefined ||
    (patch.enabled === true && !existing.enabled);
  if (scheduleChanged && merged.enabled) {
    merged.nextRunAt = computeNextRunAt({
      kind: merged.kind,
      hour: merged.hour,
      minute: merged.minute,
      timezone: merged.timezone,
      intervalMinutes: merged.intervalMinutes,
    });
  }
  if (useConvex(userId)) {
    const row = await cx.convexClient().mutation(api.routines.patch, {
      secret: process.env.OMB_HARNESS_SECRET!,
      userId: userId as Id<"users">,
      routineId: routineId as Id<"routines">,
      name: merged.name,
      instruction: merged.instruction,
      kind: merged.kind,
      hour: merged.hour,
      minute: merged.minute,
      timezone: merged.timezone,
      intervalMinutes: merged.intervalMinutes,
      enabled: merged.enabled,
      nextRunAt: merged.nextRunAt,
    });
    return row ? fromConvex(row) : null;
  }
  const rows = loadLocal(userId);
  const idx = rows.findIndex((r) => r.id === routineId);
  if (idx === -1) return null;
  rows[idx] = merged;
  saveLocal(userId, rows);
  return merged;
}

export async function removeRoutine(userId: string, routineId: string): Promise<boolean> {
  if (useConvex(userId)) {
    return await cx.convexClient().mutation(api.routines.remove, {
      secret: process.env.OMB_HARNESS_SECRET!,
      userId: userId as Id<"users">,
      routineId: routineId as Id<"routines">,
    });
  }
  const rows = loadLocal(userId);
  const next = rows.filter((r) => r.id !== routineId);
  if (next.length === rows.length) return false;
  saveLocal(userId, next);
  return true;
}

export async function markRun(userId: string, routine: Routine): Promise<Routine | null> {
  const lastRunAt = Date.now();
  const nextRunAt = computeNextRunAt({
    kind: routine.kind,
    hour: routine.hour,
    minute: routine.minute,
    timezone: routine.timezone,
    intervalMinutes: routine.intervalMinutes,
    from: lastRunAt,
  });
  if (useConvex(userId)) {
    const row = await cx.convexClient().mutation(api.routines.markRun, {
      secret: process.env.OMB_HARNESS_SECRET!,
      routineId: routine.id as Id<"routines">,
      lastRunAt,
      nextRunAt,
    });
    return row ? fromConvex(row) : null;
  }
  const rows = loadLocal(userId);
  const idx = rows.findIndex((r) => r.id === routine.id);
  if (idx === -1) return null;
  rows[idx] = { ...rows[idx], lastRunAt, nextRunAt };
  saveLocal(userId, rows);
  return rows[idx];
}

export async function listDue(now = Date.now()): Promise<Routine[]> {
  if (cx.convexConfigured()) {
    const rows = await cx.convexClient().query(api.routines.listDue, {
      secret: process.env.OMB_HARNESS_SECRET!,
      now,
    });
    return rows.map(fromConvex);
  }
  if (!existsSync(DATA_DIR)) return [];
  const { readdirSync } = await import("node:fs");
  const due: Routine[] = [];
  const desktop = loadLocal("__desktop__").filter((r) => r.enabled && r.nextRunAt <= now);
  due.push(...desktop);
  const tenantsDir = join(DATA_DIR, "tenants");
  if (existsSync(tenantsDir)) {
    for (const name of readdirSync(tenantsDir)) {
      due.push(...loadLocal(name).filter((r) => r.enabled && r.nextRunAt <= now));
    }
  }
  return due;
}

export function routinePrompt(routine: Routine): string {
  return `[Routine: ${routine.name}]\n\n${routine.instruction}`;
}
