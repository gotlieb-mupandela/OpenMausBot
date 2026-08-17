import { describe, expect, it } from "vitest";
import { computeNextRunAt, routinePrompt } from "./routines.ts";

describe("computeNextRunAt", () => {
  it("schedules interval jobs from the given instant", () => {
    const from = Date.parse("2026-08-17T13:40:34.000Z");
    expect(computeNextRunAt({ kind: "interval", intervalMinutes: 15, from })).toBe(
      from + 15 * 60_000,
    );
  });

  it("does not skip overdue work — next run is still from `from`, not wall-clock catch-up loops", () => {
    const overdue = Date.now() - 60 * 60_000;
    const next = computeNextRunAt({ kind: "interval", intervalMinutes: 15, from: overdue });
    expect(next).toBe(overdue + 15 * 60_000);
  });
});

describe("routinePrompt", () => {
  it("prefixes the instruction so chat matches a scheduled run", () => {
    expect(
      routinePrompt({
        id: "1",
        userId: "u",
        botId: "b",
        name: "Check unread",
        instruction: "score emails",
        kind: "interval",
        enabled: true,
        nextRunAt: 0,
        lastRunAt: null,
        createdAt: 0,
      }),
    ).toBe("[Routine: Check unread]\n\nscore emails");
  });
});
