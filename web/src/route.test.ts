import { describe, expect, it } from "vitest";
import { parseRoute, settingsHref } from "./route";

describe("parseRoute", () => {
  it("opens the dashboard by default", () => {
    expect(parseRoute("")).toEqual({ page: "dashboard" });
    expect(parseRoute("#")).toEqual({ page: "dashboard" });
  });

  it("opens a settings tab", () => {
    expect(parseRoute("#/settings/phone")).toEqual({ page: "settings", tab: "phone" });
    expect(parseRoute("#/settings/answering/")).toEqual({ page: "settings", tab: "answering" });
  });

  it("falls back to the first tab for a missing or unknown tab", () => {
    expect(parseRoute("#/settings")).toEqual({ page: "settings", tab: "agents" });
    expect(parseRoute("#/settings/nope")).toEqual({ page: "settings", tab: "agents" });
  });

  it("leaves the pairing hash alone", () => {
    expect(parseRoute("#pair=abcdefgh12345678")).toEqual({ page: "dashboard" });
  });

  it("round-trips through settingsHref", () => {
    expect(parseRoute(settingsHref("general"))).toEqual({ page: "settings", tab: "general" });
  });
});
