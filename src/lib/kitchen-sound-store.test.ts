// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KITCHEN_SOUND_ENABLED_STORAGE_KEY,
  KITCHEN_SOUND_PREFERENCES_EVENT,
  KITCHEN_SOUND_PREFERENCES_STORAGE_KEY,
  readKitchenSoundPreferences,
  subscribeKitchenSoundPreferences,
  writeKitchenSoundPreferences,
} from "./kitchen-sound-store";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("kitchen sound preferences store", () => {
  it("defaults to silent with every event armed", () => {
    expect(readKitchenSoundPreferences()).toEqual({
      enabled: false,
      events: {
        newTicket: true,
        addedItems: true,
        aging: true,
        connection: true,
        printFailure: true,
      },
    });
  });

  it("round-trips a write through both storage keys and announces it", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeKitchenSoundPreferences(listener);
    try {
      writeKitchenSoundPreferences({
        enabled: true,
        events: {
          newTicket: true,
          addedItems: false,
          aging: true,
          connection: false,
          printFailure: true,
        },
      });

      expect(localStorage.getItem(KITCHEN_SOUND_ENABLED_STORAGE_KEY)).toBe("true");
      expect(JSON.parse(localStorage.getItem(KITCHEN_SOUND_PREFERENCES_STORAGE_KEY)!).events.addedItems)
        .toBe(false);
      expect(readKitchenSoundPreferences().enabled).toBe(true);
      expect(readKitchenSoundPreferences().events.addedItems).toBe(false);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it("honours the legacy master switch that predates the per-event matrix", () => {
    localStorage.setItem(KITCHEN_SOUND_ENABLED_STORAGE_KEY, "true");
    expect(readKitchenSoundPreferences().enabled).toBe(true);
  });

  it("falls back to defaults on corrupt storage instead of failing the screen", () => {
    localStorage.setItem(KITCHEN_SOUND_PREFERENCES_STORAGE_KEY, "{not json");
    expect(readKitchenSoundPreferences().enabled).toBe(false);
    expect(readKitchenSoundPreferences().events.newTicket).toBe(true);
  });

  it("follows a `storage` event from another tab", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeKitchenSoundPreferences(listener);
    try {
      window.dispatchEvent(
        new StorageEvent("storage", { key: KITCHEN_SOUND_PREFERENCES_STORAGE_KEY }),
      );
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it("stops listening after the subscription is released", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeKitchenSoundPreferences(listener);
    unsubscribe();
    window.dispatchEvent(new CustomEvent(KITCHEN_SOUND_PREFERENCES_EVENT));
    expect(listener).not.toHaveBeenCalled();
  });
});
