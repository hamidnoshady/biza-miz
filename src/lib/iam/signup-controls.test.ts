import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIGNUP_CONTROLS,
  SIGNUP_MAINTENANCE_MESSAGE_MAX,
  inspectionLimitDecision,
  normalizeMaintenanceMessage,
  resolveSignupGate,
  signupControlsFromRow,
  signupGateError,
  type SignupControls,
} from "./signup-controls";

/**
 * Issue #1388 — the registration control's precedence and masking rules.
 *
 * The precedence is the security-relevant half: an install that has never
 * stored a control must behave exactly as it did before #1388, and a stored
 * control must be the one the server enforces.
 */

const stored = (overrides: Partial<SignupControls> = {}): SignupControls => ({
  ...DEFAULT_SIGNUP_CONTROLS,
  publicSignupEnabled: true,
  updatedAt: "2026-11-24T10:00:00.000Z",
  updatedBy: "11111111-1111-4111-8111-111111111111",
  ...overrides,
});

describe("resolveSignupGate precedence", () => {
  it("uses the deployment gate when no control has been stored", () => {
    expect(resolveSignupGate(null, "true")).toEqual({
      enabled: true,
      reason: "enabled",
      source: "environment",
    });
    expect(resolveSignupGate(null, "false")).toEqual({
      enabled: false,
      reason: "environment_disabled",
      source: "environment",
    });
    expect(resolveSignupGate(null, undefined)).toEqual({
      enabled: false,
      reason: "environment_disabled",
      source: "environment",
    });
  });

  it("accepts only the exact 'true' deployment value, as before", () => {
    for (const value of ["TRUE", "1", "yes", " true", ""]) {
      expect(resolveSignupGate(null, value).enabled, value).toBe(false);
    }
  });

  it("lets a stored control enable registration on a deployment that never set the env gate", () => {
    expect(resolveSignupGate(stored(), undefined)).toEqual({
      enabled: true,
      reason: "enabled",
      source: "runtime",
    });
  });

  it("lets a stored control close registration even when the env gate is open", () => {
    expect(resolveSignupGate(stored({ publicSignupEnabled: false }), "true")).toEqual({
      enabled: false,
      reason: "administratively_disabled",
      source: "runtime",
    });
  });

  it("maintenance closes the door even when registration is enabled", () => {
    expect(
      resolveSignupGate(stored({ maintenanceMode: true, maintenanceMessage: "تعمیرات" }), "true"),
    ).toEqual({ enabled: false, reason: "maintenance", source: "runtime" });
  });

  it("keeps the maintenance distinction when registration was already disabled", () => {
    // The public copy differs: a maintenance pause says "come back later", an
    // administratively closed door does not promise a reopening.
    expect(
      resolveSignupGate(stored({ publicSignupEnabled: false, maintenanceMode: true }), undefined),
    ).toEqual({ enabled: false, reason: "maintenance", source: "runtime" });
  });

  it("maps the two public refusals to distinct codes", () => {
    expect(signupGateError("maintenance")).toBe("signup_maintenance");
    expect(signupGateError("administratively_disabled")).toBe("signup_disabled");
    expect(signupGateError("environment_disabled")).toBe("signup_disabled");
    expect(signupGateError("enabled")).toBe("signup_disabled");
  });
});

describe("stored control validation", () => {
  it("reads a stored row and serialises its timestamp", () => {
    expect(
      signupControlsFromRow({
        public_signup_enabled: false,
        maintenance_mode: true,
        maintenance_message: "  تعمیرات  ",
        updated_at: new Date("2026-11-24T10:00:00.000Z"),
        updated_by: null,
        updated_by_name: "مدیر",
      }),
    ).toEqual({
      publicSignupEnabled: false,
      maintenanceMode: true,
      maintenanceMessage: "  تعمیرات  ",
      updatedAt: "2026-11-24T10:00:00.000Z",
      updatedBy: null,
      updatedByName: "مدیر",
    });
  });

  it("refuses an invalid shape instead of guessing a boolean", () => {
    for (const bad of [
      null,
      {},
      { public_signup_enabled: "yes", maintenance_mode: false },
      { public_signup_enabled: true, maintenance_mode: "no" },
      { public_signup_enabled: true, maintenance_mode: false, maintenance_message: 42 },
    ]) {
      expect(signupControlsFromRow(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("the maintenance message", () => {
  it("normalises whitespace and treats blank as no message", () => {
    expect(normalizeMaintenanceMessage("  ثبت‌نام   موقتاً  بسته است ")).toBe(
      "ثبت‌نام موقتاً بسته است",
    );
    expect(normalizeMaintenanceMessage("   ")).toBeNull();
    expect(normalizeMaintenanceMessage(null)).toBeNull();
    expect(normalizeMaintenanceMessage(undefined)).toBeNull();
  });

  it("rejects non-strings and over-long copy", () => {
    expect(normalizeMaintenanceMessage(42)).toBe("invalid");
    expect(normalizeMaintenanceMessage("x".repeat(SIGNUP_MAINTENANCE_MESSAGE_MAX))).toBe(
      "x".repeat(SIGNUP_MAINTENANCE_MESSAGE_MAX),
    );
    expect(normalizeMaintenanceMessage("x".repeat(SIGNUP_MAINTENANCE_MESSAGE_MAX + 1))).toBe(
      "invalid",
    );
  });
});

describe("the inspection budget", () => {
  const now = new Date("2026-11-24T10:00:00.000Z");

  it("allows lookups below the ceiling and refuses the one that reaches it", () => {
    const recent = (n: number) =>
      Array.from({ length: n }, (_, i) => new Date(now.getTime() - i * 1_000));
    expect(inspectionLimitDecision(recent(19), now).allowed).toBe(true);
    const blocked = inspectionLimitDecision(recent(20), now);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("ignores attempts older than the window", () => {
    const old = Array.from(
      { length: 40 },
      (_, i) => new Date(now.getTime() - 61_000 - i * 1_000),
    );
    expect(inspectionLimitDecision(old, now).allowed).toBe(true);
  });
});
