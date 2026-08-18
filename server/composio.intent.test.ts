import { describe, expect, it } from "vitest";
import { matchConnectedToolkit, messagePluginIntent } from "./composio.ts";

describe("messagePluginIntent", () => {
  it("maps WhatsApp phrasing to the whatsapp toolkit", () => {
    expect(messagePluginIntent("send a WhatsApp to the team")).toBe("whatsapp");
    expect(messagePluginIntent("check whatsapp messages")).toBe("whatsapp");
    expect(messagePluginIntent("read my Whats App inbox")).toBe("whatsapp");
  });

  it("still maps email and calendar", () => {
    expect(messagePluginIntent("read my last emails")).toBe("gmail");
    expect(messagePluginIntent("what's on my calendar today")).toBe("googlecalendar");
  });
});

describe("matchConnectedToolkit", () => {
  it("keeps an exact connected slug", () => {
    expect(matchConnectedToolkit("whatsapp", ["gmail", "whatsapp"])).toBe("whatsapp");
  });

  it("maps whatsapp onto a connected whatsapp_business slug", () => {
    expect(matchConnectedToolkit("whatsapp", ["gmail", "whatsapp_business"])).toBe("whatsapp_business");
  });

  it("returns the intent when nothing is connected yet", () => {
    expect(matchConnectedToolkit("whatsapp", [])).toBe("whatsapp");
    expect(matchConnectedToolkit(null, ["gmail"])).toBeNull();
  });
});
