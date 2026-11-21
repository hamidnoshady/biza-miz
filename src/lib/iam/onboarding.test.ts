/**
 * ESH-202 / #1387 — the pure rules of short onboarding.
 *
 * The industry picker is the canonical enabled registry (not a second list), and
 * the staged logo obeys the same MIME/byte ceiling and magic-byte check as the
 * business logo setting it is moved into.
 */
import { describe, expect, it } from "vitest";
import { ENABLED_INDUSTRIES, INDUSTRY_LABELS } from "../industries";
import {
  ONBOARDING_STEPS,
  isOnboardingStep,
  onboardingIndustryOptions,
  parseOnboardingLogo,
} from "./onboarding";

/** A 1x1 transparent PNG — the smallest thing with a real PNG signature. */
const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("onboarding industries", () => {
  it("offers exactly the enabled registry, labelled", () => {
    const options = onboardingIndustryOptions();
    expect(options.map((option) => option.key)).toEqual(ENABLED_INDUSTRIES);
    expect(options.every((option) => option.label === INDUSTRY_LABELS[option.key])).toBe(true);
  });
});

describe("onboarding steps", () => {
  it("keeps the four approved steps and rejects anything else", () => {
    expect([...ONBOARDING_STEPS]).toEqual(["industry", "business", "logo", "profile"]);
    expect(isOnboardingStep("logo")).toBe(true);
    expect(isOnboardingStep("payment")).toBe(false);
    expect(isOnboardingStep(null)).toBe(false);
  });
});

describe("onboarding logo", () => {
  it("accepts a real image data URL", () => {
    const parsed = parseOnboardingLogo(ONE_PIXEL_PNG);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.logo.mimeType).toBe("image/png");
      expect(parsed.logo.byteLength).toBeGreaterThan(0);
    }
  });

  it("refuses a non-data URL, a mismatched signature and an empty payload", () => {
    expect(parseOnboardingLogo("https://example.com/logo.png")).toEqual({
      ok: false,
      error: "invalid_logo",
    });
    // Claims PNG, carries HTML: the declared MIME type is not evidence.
    expect(
      parseOnboardingLogo(`data:image/png;base64,${Buffer.from("<html></html>").toString("base64")}`),
    ).toEqual({ ok: false, error: "invalid_logo" });
    expect(parseOnboardingLogo("data:image/png;base64,")).toEqual({
      ok: false,
      error: "invalid_logo",
    });
  });

  it("refuses a payload above the canonical 256 KiB decoded ceiling", () => {
    const oversized = Buffer.alloc(300 * 1024, 1);
    // A real PNG signature, so size (not the signature check) is what refuses it.
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversized, 0);
    expect(
      parseOnboardingLogo(`data:image/png;base64,${oversized.toString("base64")}`),
    ).toEqual({ ok: false, error: "invalid_logo" });
  });
});
