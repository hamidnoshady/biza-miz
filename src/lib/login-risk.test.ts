import { describe, expect, it } from "vitest";
import {
  EMPTY_DEVICE_CONTEXT,
  classifyRenewalRisk,
  deviceContextFromUserAgent,
  type DeviceContext,
} from "./login-risk";

const WINDOWS_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const WINDOWS_EDGE = `${WINDOWS_CHROME} Edg/126.0.0.0`;
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const LINUX_FIREFOX =
  "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0";
const ANDROID_SAMSUNG =
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

function context(overrides: Partial<DeviceContext> = {}): DeviceContext {
  return { ...EMPTY_DEVICE_CONTEXT, ...overrides };
}

describe("deviceContextFromUserAgent", () => {
  it("recognises the Chromium browsers before the Chrome token they all carry", () => {
    expect(deviceContextFromUserAgent(WINDOWS_CHROME)).toMatchObject({
      browserFamily: "chrome",
      osFamily: "windows",
    });
    expect(deviceContextFromUserAgent(WINDOWS_EDGE)).toMatchObject({
      browserFamily: "edge",
      osFamily: "windows",
    });
    expect(deviceContextFromUserAgent(ANDROID_SAMSUNG)).toMatchObject({
      browserFamily: "samsung",
      osFamily: "android",
    });
  });

  it("recognises Safari, Firefox and iOS", () => {
    expect(deviceContextFromUserAgent(MAC_SAFARI)).toMatchObject({
      browserFamily: "safari",
      osFamily: "macos",
    });
    expect(deviceContextFromUserAgent(LINUX_FIREFOX)).toMatchObject({
      browserFamily: "firefox",
      osFamily: "linux",
    });
    expect(deviceContextFromUserAgent(IPHONE_SAFARI)).toMatchObject({
      browserFamily: "safari",
      osFamily: "ios",
    });
  });

  it("never guesses from a missing or malformed user-agent", () => {
    expect(deviceContextFromUserAgent(null)).toEqual(EMPTY_DEVICE_CONTEXT);
    expect(deviceContextFromUserAgent("")).toEqual(EMPTY_DEVICE_CONTEXT);
    expect(deviceContextFromUserAgent("something-else/1.0")).toEqual(EMPTY_DEVICE_CONTEXT);
  });

  it("accepts only a two-letter region hint, never an address", () => {
    expect(deviceContextFromUserAgent(WINDOWS_CHROME, "ir").regionHint).toBe("IR");
    expect(deviceContextFromUserAgent(WINDOWS_CHROME, "1.2.3.4").regionHint).toBeNull();
    expect(deviceContextFromUserAgent(WINDOWS_CHROME, "").regionHint).toBeNull();
    expect(deviceContextFromUserAgent(WINDOWS_CHROME, null).regionHint).toBeNull();
  });
});

describe("classifyRenewalRisk — low", () => {
  it("renews silently on an unchanged context", () => {
    const stored = context({ browserFamily: "chrome", osFamily: "windows", regionHint: "IR" });
    expect(classifyRenewalRisk({ credentialValid: true, stored, current: stored })).toEqual({
      level: "low",
      reasons: [],
    });
  });

  it("treats a network, VPN or travel change as low", () => {
    const stored = context({ browserFamily: "chrome", osFamily: "windows", regionHint: "IR" });
    const current = context({ browserFamily: "chrome", osFamily: "windows", regionHint: "DE" });
    const decision = classifyRenewalRisk({ credentialValid: true, stored, current });
    expect(decision.level).toBe("low");
    expect(decision.reasons).toEqual(["region_changed"]);
  });

  it("treats an unknown signal as unchanged rather than as a mismatch", () => {
    const stored = context({ browserFamily: "chrome", osFamily: "unknown" });
    const current = context({ browserFamily: "chrome", osFamily: "linux" });
    expect(classifyRenewalRisk({ credentialValid: true, stored, current }).level).toBe("low");
  });
});

describe("classifyRenewalRisk — moderate", () => {
  it("asks for a step-up when the browser family changes", () => {
    const stored = context({ browserFamily: "chrome", osFamily: "windows" });
    const current = context({ browserFamily: "firefox", osFamily: "windows" });
    const decision = classifyRenewalRisk({ credentialValid: true, stored, current });
    expect(decision.level).toBe("moderate");
    expect(decision.reasons).toEqual(["browser_family_changed"]);
  });

  it("asks for a step-up when the OS changes", () => {
    const stored = context({ browserFamily: "chrome", osFamily: "windows" });
    const current = context({ browserFamily: "chrome", osFamily: "macos" });
    const decision = classifyRenewalRisk({ credentialValid: true, stored, current });
    expect(decision.level).toBe("moderate");
    expect(decision.reasons).toEqual(["os_family_changed"]);
  });
});

describe("classifyRenewalRisk — high", () => {
  it("refuses when both context axes change at once", () => {
    const stored = context({ browserFamily: "chrome", osFamily: "windows" });
    const current = context({ browserFamily: "safari", osFamily: "macos" });
    const decision = classifyRenewalRisk({ credentialValid: true, stored, current });
    expect(decision.level).toBe("high");
    expect(decision.reasons).toContain("context_combination");
  });

  it("refuses on an OS change combined with a region change", () => {
    const stored = context({ browserFamily: "chrome", osFamily: "windows", regionHint: "IR" });
    const current = context({ browserFamily: "chrome", osFamily: "linux", regionHint: "NL" });
    expect(classifyRenewalRisk({ credentialValid: true, stored, current }).level).toBe("high");
  });

  it.each([
    ["an unknown credential", { credentialValid: false }],
    ["a replayed credential", { credentialValid: true, replayed: true }],
    ["a revoked family", { credentialValid: true, familyRevoked: true }],
    ["an expired family", { credentialValid: true, familyExpired: true }],
    ["an inactive identity", { credentialValid: true, identityActive: false }],
    ["a lost membership", { credentialValid: true, membershipActive: false }],
    ["a stale token version", { credentialValid: true, tokenVersionMatches: false }],
    ["an active lockout", { credentialValid: true, accountLocked: true }],
  ])("refuses %s", (_label, overrides) => {
    const stored = context({ browserFamily: "chrome", osFamily: "windows" });
    const decision = classifyRenewalRisk({
      stored,
      current: stored,
      ...overrides,
    });
    expect(decision.level).toBe("high");
    expect(decision.reasons.length).toBeGreaterThan(0);
  });
});
