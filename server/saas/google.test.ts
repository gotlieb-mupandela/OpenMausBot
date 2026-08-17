import { describe, expect, it } from "vitest";
import { safeNextPath } from "./google.ts";

describe("safeNextPath", () => {
  it("allows same-origin billing return paths", () => {
    expect(safeNextPath("/billing/success?checkout_id=ch_1")).toBe(
      "/billing/success?checkout_id=ch_1",
    );
  });

  it("rejects open redirects", () => {
    expect(safeNextPath("https://evil.example/")).toBe("/");
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
  });
});
