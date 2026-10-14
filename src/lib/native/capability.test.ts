import { describe, expect, it } from "vitest";
import type { NativeAppInfo } from "./bridge-contract";
import {
  NO_BROWSER_FEATURES,
  resolveAllCapabilities,
  resolveCapability,
  type BrowserFeatures,
} from "./capability";

const WITH_BARCODE: BrowserFeatures = { ...NO_BROWSER_FEATURES, barcodeDetector: true };
const WITH_WEBAUTHN: BrowserFeatures = { ...NO_BROWSER_FEATURES, webAuthn: true };

function app(overrides: Partial<NativeAppInfo>): NativeAppInfo {
  return {
    appVersionName: "1.0.0",
    appVersionCode: 1,
    environment: "production",
    bridgeVersion: 2,
    capabilities: [],
    ...overrides,
  };
}

describe("resolveCapability", () => {
  it("uses the native app when it reports the capability at a sufficient bridge version", () => {
    const native = app({ bridgeVersion: 2, capabilities: ["barcode.scan"] });
    expect(resolveCapability("barcode.scan", NO_BROWSER_FEATURES, native)).toEqual({
      available: true,
      provider: "native",
      updateRequired: false,
    });
  });

  it("prefers the native provider over the browser when both exist", () => {
    const native = app({ bridgeVersion: 2, capabilities: ["barcode.scan"] });
    expect(resolveCapability("barcode.scan", WITH_BARCODE, native).provider).toBe("native");
  });

  it("falls back to the browser API when the app does not report the capability", () => {
    expect(resolveCapability("barcode.scan", WITH_BARCODE, app({ capabilities: [] }))).toEqual({
      available: true,
      provider: "web",
      updateRequired: false,
    });
  });

  it("is unavailable in a plain browser, without asking for an update", () => {
    expect(resolveCapability("barcode.scan", NO_BROWSER_FEATURES, null)).toEqual({
      available: false,
      provider: null,
      updateRequired: false,
    });
  });

  it("asks for an app update when the installed app predates the bridge version that provides the capability", () => {
    const oldApp = app({ bridgeVersion: 1, capabilities: ["printer"] });
    expect(resolveCapability("printer", NO_BROWSER_FEATURES, oldApp)).toEqual({
      available: false,
      provider: null,
      updateRequired: true,
    });
  });

  it("asks for an app update even when a browser fallback is absent on this device", () => {
    const oldApp = app({ bridgeVersion: 1, capabilities: [] });
    expect(resolveCapability("barcode.scan", NO_BROWSER_FEATURES, oldApp).updateRequired).toBe(true);
  });

  it("does not ask for an update when an up-to-date app simply lacks the capability", () => {
    expect(resolveCapability("printer", NO_BROWSER_FEATURES, app({ bridgeVersion: 2 })).updateRequired).toBe(false);
  });

  it("uses a browser feature for a capability that has one, regardless of the app", () => {
    expect(resolveCapability("biometric", WITH_WEBAUTHN, app({ bridgeVersion: 1 }))).toEqual({
      available: true,
      provider: "web",
      updateRequired: false,
    });
  });
});

describe("resolveAllCapabilities", () => {
  it("returns a resolution for every capability in the contract", () => {
    const all = resolveAllCapabilities(NO_BROWSER_FEATURES, null);
    expect(Object.keys(all).sort()).toEqual(
      ["barcode.scan", "biometric", "crm.caller-id", "notifications", "printer", "share"].sort(),
    );
    expect(Object.isFrozen(all)).toBe(true);
  });
});
