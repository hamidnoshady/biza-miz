import { describe, expect, it } from "vitest";
import { DEFAULT_UI_INTERACTION_SETTINGS, normalizeUiInteractionSettings, parseUiInteractionSettings } from "./ui-interaction-settings";

describe("UI interaction policy", () => {
  it("keeps the installed-tenant gesture defaults", () => {
    expect(DEFAULT_UI_INTERACTION_SETTINGS.paymentHoldMs).toBe(4000);
    expect(DEFAULT_UI_INTERACTION_SETTINGS.addOnHoldMs).toBe(2000);
    expect(DEFAULT_UI_INTERACTION_SETTINGS.doubleTapEnabled).toBe(true);
  });

  it("accepts a complete versioned policy and rejects unknown or unsafe values", () => {
    expect(normalizeUiInteractionSettings(DEFAULT_UI_INTERACTION_SETTINGS)).toEqual(DEFAULT_UI_INTERACTION_SETTINGS);
    expect(normalizeUiInteractionSettings({ ...DEFAULT_UI_INTERACTION_SETTINGS, paymentHoldMs: 999 })).toBeNull();
    expect(normalizeUiInteractionSettings({ ...DEFAULT_UI_INTERACTION_SETTINGS, addOnHoldMs: 4001 })).toBeNull();
    expect(normalizeUiInteractionSettings({ ...DEFAULT_UI_INTERACTION_SETTINGS, doubleTapEnabled: "false" })).toBeNull();
    expect(normalizeUiInteractionSettings({ ...DEFAULT_UI_INTERACTION_SETTINGS, arbitrary: true })).toBeNull();
    expect(normalizeUiInteractionSettings({ ...DEFAULT_UI_INTERACTION_SETTINGS, version: 2 })).toBeNull();
  });

  it("fails safely back to the legacy gesture defaults for malformed stored values", () => {
    expect(parseUiInteractionSettings({ version: 1, paymentHoldMs: 1 })).toEqual(DEFAULT_UI_INTERACTION_SETTINGS);
  });
});
