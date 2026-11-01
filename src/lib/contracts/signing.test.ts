/**
 * Issue #908 — the ordering and completion rules of a multi-party signature
 * round, plus the two privacy rules around what the evidence trail stores.
 *
 * These are the pure decisions the API and the signer page both depend on, so
 * they are tested without a database: a sequential envelope that lets the second
 * party sign before the first is a contract with a forged order of events.
 */
import { describe, expect, it } from "vitest";
import type {
  ContractEnvelopeStatus,
  ContractSignerStatus,
  ContractSigningMode,
} from "./view";
import {
  DEFAULT_INVITATION_DAYS,
  MAX_INVITATION_DAYS,
  envelopeExpired,
  maskPhone,
  signerMayAct,
  signingProgress,
  signingUrl,
  truncateIp,
} from "./signing";

const signer = (
  id: string,
  order: number,
  status: ContractSignerStatus,
  required = true,
): { id: string; sign_order: number; status: ContractSignerStatus; required: boolean } => ({
  id,
  sign_order: order,
  status,
  required,
});

const envelope = (signing_mode: ContractSigningMode, status: ContractEnvelopeStatus) => ({
  signing_mode,
  status,
});

describe("signerMayAct", () => {
  it("lets either party sign first in a parallel envelope", () => {
    const seen = [signer("a", 1, "invited"), signer("b", 2, "invited")];
    expect(signerMayAct(envelope("parallel", "sent"), seen, seen[1])).toEqual({ ok: true });
  });

  it("holds the second party in a sequential envelope until the first signs", () => {
    const seen = [signer("a", 1, "invited"), signer("b", 2, "invited")];
    expect(signerMayAct(envelope("sequential", "sent"), seen, seen[1])).toEqual({
      ok: false,
      reason: "turn_pending",
    });
    expect(signerMayAct(envelope("sequential", "sent"), seen, seen[0])).toEqual({ ok: true });
  });

  it("lets the second party sign once the first has, on the same envelope", () => {
    const seen = [signer("a", 1, "signed"), signer("b", 2, "invited")];
    expect(signerMayAct(envelope("sequential", "partially_signed"), seen, seen[1])).toEqual({
      ok: true,
    });
  });

  it("ignores an optional unsigned party when deciding whose turn it is", () => {
    const seen = [signer("a", 1, "invited", false), signer("b", 2, "invited")];
    expect(signerMayAct(envelope("sequential", "sent"), seen, seen[1])).toEqual({ ok: true });
  });

  it("refuses a closed, already-signed or declined session with a distinguishable reason", () => {
    const seen = [signer("a", 1, "invited"), signer("b", 2, "invited")];
    for (const status of ["cancelled", "expired", "completed", "draft"] as ContractEnvelopeStatus[]) {
      expect(signerMayAct(envelope("parallel", status), seen, seen[0])).toEqual({
        ok: false,
        reason: "not_live",
      });
    }
    expect(
      signerMayAct(envelope("parallel", "sent"), seen, signer("a", 1, "signed")),
    ).toEqual({ ok: false, reason: "already_signed" });
    expect(
      signerMayAct(envelope("parallel", "sent"), seen, signer("a", 1, "declined")),
    ).toEqual({ ok: false, reason: "declined" });
  });
});

describe("signingProgress", () => {
  it("counts only required signers and is complete only when all of them signed", () => {
    expect(signingProgress([{ status: "signed", required: true }])).toEqual({
      required: 1,
      signed: 1,
      complete: true,
    });
    expect(
      signingProgress([
        { status: "signed", required: true },
        { status: "invited", required: true },
        { status: "signed", required: false },
      ]),
    ).toEqual({ required: 2, signed: 1, complete: false });
  });

  it("is never complete without a required signer — an empty envelope signs nothing", () => {
    expect(signingProgress([])).toEqual({ required: 0, signed: 0, complete: false });
    expect(signingProgress([{ status: "signed", required: false }]).complete).toBe(false);
  });
});

describe("maskPhone", () => {
  it("keeps the prefix and last four digits of an Iranian mobile number", () => {
    expect(maskPhone("+989123456789")).toBe("0912•••6789");
    expect(maskPhone("09123456789")).toBe("0912•••6789");
    expect(maskPhone("0912 345 6789")).toBe("0912•••6789");
  });

  it("never prints a short value", () => {
    expect(maskPhone("12345")).toBe("•••");
    expect(maskPhone("")).toBe("•••");
  });
});

describe("truncateIp", () => {
  it("keeps a /24 of an IPv4 address and drops the rest", () => {
    expect(truncateIp("192.168.10.44")).toBe("192.168.10.0");
    expect(truncateIp("192.168.10.44, 10.0.0.1")).toBe("192.168.10.0");
  });

  it("keeps a /64 of an IPv6 address", () => {
    expect(truncateIp("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe("2001:db8:85a3:8d3::");
  });

  it("returns an empty string for nothing and for unparseable values", () => {
    expect(truncateIp(null)).toBe("");
    expect(truncateIp("   ")).toBe("");
    expect(truncateIp("unknown")).toBe("");
  });
});

describe("envelopeExpired", () => {
  const now = new Date("2026-11-01T12:00:00Z");

  it("treats no deadline as never expiring", () => {
    expect(envelopeExpired({ expiresAt: null }, now)).toBe(false);
  });

  it("expires at the boundary and after it, but not before", () => {
    expect(envelopeExpired({ expiresAt: "2026-11-01T12:00:00Z" }, now)).toBe(true);
    expect(envelopeExpired({ expiresAt: "2026-11-01T11:59:59Z" }, now)).toBe(true);
    expect(envelopeExpired({ expiresAt: "2026-11-01T12:00:01Z" }, now)).toBe(false);
  });

  it("ignores an unparseable deadline instead of expiring a live round by accident", () => {
    expect(envelopeExpired({ expiresAt: "not-a-date" }, now)).toBe(false);
  });
});

describe("signingUrl", () => {
  it("builds the public URL and tolerates a trailing slash", () => {
    expect(signingUrl("https://app.example.com", "tok")).toBe("https://app.example.com/sign/tok");
    expect(signingUrl("https://app.example.com///", "tok")).toBe("https://app.example.com/sign/tok");
    expect(signingUrl("", "tok")).toBe("/sign/tok");
  });
});

describe("invitation bounds", () => {
  it("defaults inside the maximum the API accepts", () => {
    expect(DEFAULT_INVITATION_DAYS).toBeGreaterThan(0);
    expect(DEFAULT_INVITATION_DAYS).toBeLessThanOrEqual(MAX_INVITATION_DAYS);
  });
});
