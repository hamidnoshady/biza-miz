import { describe, expect, it } from "vitest";
import {
  generatePasswordResetToken,
  hashPasswordResetToken,
  validatePasswordStrength,
} from "./password-reset";

describe("validatePasswordStrength", () => {
  it("rejects passwords shorter than 8 characters", () => {
    expect(validatePasswordStrength("short")).toEqual({
      ok: false,
      error: "password_too_short",
    });
  });

  it("rejects passwords longer than 128 characters", () => {
    expect(validatePasswordStrength("a".repeat(129))).toEqual({
      ok: false,
      error: "password_too_long",
    });
  });

  it("rejects reusing the current password when provided", () => {
    expect(validatePasswordStrength("same-password-123", "same-password-123")).toEqual({
      ok: false,
      error: "password_unchanged",
    });
  });

  it("accepts strong new passwords", () => {
    expect(validatePasswordStrength("new-strong-password-123", "old-password-123")).toEqual({
      ok: true,
    });
  });
});

describe("generatePasswordResetToken & hashPasswordResetToken", () => {
  it("mints high-entropy tokens and deterministic SHA-256 hashes", () => {
    const first = generatePasswordResetToken();
    const second = generatePasswordResetToken();
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).toHaveLength(64);
    expect(hashPasswordResetToken(first.token)).toBe(first.tokenHash);
  });
});
