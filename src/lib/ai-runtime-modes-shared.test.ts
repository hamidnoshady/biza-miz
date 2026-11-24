/**
 * Issue #1546 (Fast truthfulness) — the picker's normalizer.
 *
 * Discovery is an aid, not the enforcement: the chat route still refuses an
 * unusable mode. So the normalizer must fail OPEN on anything it cannot read,
 * and only trust an explicit `available: false` from the server.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeAiModeAvailability,
  unavailableModeReason,
} from "./ai-runtime-modes-shared";

describe("issue #1546 — normalizeAiModeAvailability", () => {
  it("carries the server's decision, defaulting unreported modes to available", () => {
    expect(
      normalizeAiModeAvailability([
        { mode: "instant", available: false, reason: "fast_alias_not_configured" },
      ]),
    ).toEqual([
      { mode: "auto", available: true, reason: null },
      { mode: "instant", available: false, reason: "fast_alias_not_configured" },
      { mode: "thinking", available: true, reason: null },
    ]);
  });

  it("ignores retired, unknown and malformed entries instead of rendering them", () => {
    const modes = normalizeAiModeAvailability([
      { mode: "deep_research", available: true },
      { mode: "turbo", available: true },
      null,
      "instant",
      { mode: "thinking", available: true, reason: "fast_alias_not_configured" },
    ]);
    expect(modes?.map((entry) => entry.mode)).toEqual(["auto", "instant", "thinking"]);
    // An available mode never carries a reason.
    expect(modes?.find((entry) => entry.mode === "thinking")).toEqual({
      mode: "thinking",
      available: true,
      reason: null,
    });
  });

  it("treats an unrecognized reason as a plain disabled mode", () => {
    expect(
      normalizeAiModeAvailability([{ mode: "instant", available: false, reason: "provider_down" }]),
    ).toContainEqual({ mode: "instant", available: false, reason: "disabled" });
  });

  it("reports a mode's reason only when the server said it is unavailable", () => {
    const modes = normalizeAiModeAvailability([
      { mode: "instant", available: false, reason: "fast_alias_not_configured" },
    ]);
    expect(unavailableModeReason(modes, "instant")).toBe("fast_alias_not_configured");
    expect(unavailableModeReason(modes, "auto")).toBeNull();
    // An unreadable payload fails open, so nothing is disabled.
    expect(unavailableModeReason(undefined, "instant")).toBeNull();
  });

  it("returns null for a payload it cannot use, so the caller keeps the optimistic default", () => {
    expect(normalizeAiModeAvailability(undefined)).toBeNull();
    expect(normalizeAiModeAvailability({ modes: [] })).toBeNull();
    expect(normalizeAiModeAvailability([])).toBeNull();
    expect(normalizeAiModeAvailability([{ mode: "turbo" }])).toBeNull();
  });
});
