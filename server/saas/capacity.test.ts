import { describe, expect, it } from "vitest";
import {
  MAX_GLOBAL_TURNS,
  MAX_TURNS_PER_USER,
  TurnGate,
  trimThreadMessages,
} from "./capacity.ts";

describe("trimThreadMessages", () => {
  it("keeps the last N messages and only the latest screenshot", () => {
    const rows = [
      { kind: "text" as const, png: undefined },
      { kind: "screen" as const, png: "aaa" },
      { kind: "text" as const, png: undefined },
      { kind: "screen" as const, png: "bbb" },
    ];
    const out = trimThreadMessages(rows, 3);
    expect(out).toHaveLength(3);
    expect(out[0].png).toBeUndefined();
    expect(out[2].png).toBe("bbb");
  });
});

describe("TurnGate", () => {
  it("caps global and per-user concurrent turns", () => {
    const gate = new TurnGate();
    expect(gate.tryAcquire("u1", "b1").ok).toBe(true);
    expect(gate.tryAcquire("u1", "b2").ok).toBe(true);
    const third = gate.tryAcquire("u1", "b3");
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.status).toBe(429);

    gate.release("b1", "u1");
    expect(gate.tryAcquire("u1", "b3").ok).toBe(true);
    gate.release("b3", "u1");
    gate.release("b2", "u1");
  });

  it("is idempotent on double release and double acquire", () => {
    const gate = new TurnGate();
    expect(gate.tryAcquire("u", "bot").ok).toBe(true);
    expect(gate.tryAcquire("u", "bot").ok).toBe(true);
    expect(gate.globalCount).toBe(1);
    gate.release("bot", "u");
    gate.release("bot", "u");
    expect(gate.globalCount).toBe(0);
  });

  it("rejects when the global cap is full", () => {
    const gate = new TurnGate();
    for (let i = 0; i < MAX_GLOBAL_TURNS; i++) {
      expect(gate.tryAcquire(`u${i}`, `b${i}`).ok).toBe(true);
    }
    const extra = gate.tryAcquire("overflow", "bx");
    expect(extra.ok).toBe(false);
    expect(MAX_TURNS_PER_USER).toBe(2);
  });
});
