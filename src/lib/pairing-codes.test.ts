import { describe, expect, it } from "vitest";
import {
  generatePairingCode,
  hashPairingCode,
  normalizePairingCode,
  pairingCodeState,
  PAIRING_CODE_ALPHABET,
} from "./pairing-codes";

describe("generatePairingCode", () => {
  it("produces a dashed XXXX-XXXX-XXXX code", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generatePairingCode()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    }
  });

  it("only uses characters from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i += 1) {
      for (const ch of generatePairingCode().replaceAll("-", "")) {
        expect(PAIRING_CODE_ALPHABET).toContain(ch);
      }
    }
  });

  it("excludes the characters people confuse when reading a code aloud", () => {
    for (const ch of ["0", "1", "O", "I"]) {
      expect(PAIRING_CODE_ALPHABET).not.toContain(ch);
    }
  });

  it("does not repeat within a reasonable sample", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(generatePairingCode());
    expect(seen.size).toBe(500);
  });
});

describe("normalizePairingCode", () => {
  it("strips dashes, spaces and case", () => {
    expect(normalizePairingCode("abcd-efgh-jkmn")).toBe("ABCDEFGHJKMN");
    expect(normalizePairingCode("  ABCD EFGH JKMN ")).toBe("ABCDEFGHJKMN");
    expect(normalizePairingCode("ABCDEFGHJKMN")).toBe("ABCDEFGHJKMN");
  });

  it("folds the ambiguous characters onto their alphabet members", () => {
    // 0 reads as O and 1 reads as I when a code is dictated over the phone;
    // the alphabet excludes O/I/0/1 entirely, so both fold to the letters.
    expect(normalizePairingCode("0000-1111-ABCD")).toBe("OOOOIIIIABCD");
  });

  it("folds Persian digits, since a Persian keyboard is the likely input", () => {
    expect(normalizePairingCode("۰۰۰۰-۱۱۱۱-ABCD")).toBe("OOOOIIIIABCD");
  });
});

describe("hashPairingCode", () => {
  it("is a 64-character hex sha-256", () => {
    expect(hashPairingCode("ABCD-EFGH-JKMN")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the normalised form, so formatting never changes the result", () => {
    expect(hashPairingCode("abcd-efgh-jkmn")).toBe(hashPairingCode("ABCDEFGHJKMN"));
    expect(hashPairingCode(" ABCD EFGH JKMN ")).toBe(hashPairingCode("ABCDEFGHJKMN"));
  });

  it("differs for different codes", () => {
    expect(hashPairingCode("ABCD-EFGH-JKMN")).not.toBe(hashPairingCode("ABCD-EFGH-JKMP"));
  });
});

describe("pairingCodeState", () => {
  const now = new Date("2026-08-03T12:00:00.000Z");
  const future = new Date("2026-08-05T12:00:00.000Z");
  const past = new Date("2026-08-01T12:00:00.000Z");

  it("accepts a live, unredeemed, unrevoked code", () => {
    expect(pairingCodeState({ expiresAt: future, redeemedAt: null, revokedAt: null }, now)).toBe(
      "valid",
    );
  });

  it("rejects an expired code", () => {
    expect(pairingCodeState({ expiresAt: past, redeemedAt: null, revokedAt: null }, now)).toBe(
      "code_expired",
    );
  });

  it("rejects an already-redeemed code", () => {
    expect(pairingCodeState({ expiresAt: future, redeemedAt: past, revokedAt: null }, now)).toBe(
      "code_already_redeemed",
    );
  });

  it("shows a reserved snapshot as pending rather than pretending it is activated", () => {
    expect(pairingCodeState({
      expiresAt: future,
      redeemedAt: null,
      revokedAt: null,
      enrollmentState: "snapshot_prepared",
    }, now)).toBe("code_pending_activation");
  });

  it("rejects a revoked code", () => {
    expect(pairingCodeState({ expiresAt: future, redeemedAt: null, revokedAt: past }, now)).toBe(
      "code_revoked",
    );
  });

  it("reports revocation ahead of expiry when both apply, so the message names the deliberate act", () => {
    expect(pairingCodeState({ expiresAt: past, redeemedAt: null, revokedAt: past }, now)).toBe(
      "code_revoked",
    );
  });

  it("reports redemption ahead of revocation, since a used code is the more useful fact", () => {
    expect(pairingCodeState({ expiresAt: future, redeemedAt: past, revokedAt: past }, now)).toBe(
      "code_already_redeemed",
    );
  });
});
