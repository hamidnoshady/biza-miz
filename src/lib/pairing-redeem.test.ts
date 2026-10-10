/**
 * The redeem handler's half of the version boundary (issue #824 finding 3).
 * The service rules are pinned against real Postgres in
 * integration/pairing.integration.test.ts; here the question is only what the
 * HTTP layer passes down and how it answers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const redeemPairingCode = vi.hoisted(() => vi.fn());
vi.mock("./pairing-service", () => ({ redeemPairingCode }));

const { handlePairingRedeem } = await import("./pairing-redeem");

function request(body: unknown): NextRequest {
  return new NextRequest("https://biz.example.test/api/pairing/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handlePairingRedeem — the declared snapshot capability", () => {
  beforeEach(() => {
    redeemPairingCode.mockReset();
  });

  it("passes a declared capability through to the service", async () => {
    redeemPairingCode.mockResolvedValueOnce({ ok: false, error: "code_not_found" });
    await handlePairingRedeem(request({ code: "ABCD-EFGH-JKLM", maxSnapshotVersion: 7 }));
    expect(redeemPairingCode.mock.calls[0][4]).toEqual({ maxSnapshotVersion: 7 });
  });

  it("treats an absent capability as a legacy desktop, not as a current one", async () => {
    redeemPairingCode.mockResolvedValueOnce({ ok: false, error: "code_not_found" });
    await handlePairingRedeem(request({ code: "ABCD-EFGH-JKLM" }));
    expect(redeemPairingCode.mock.calls[0][4]).toEqual({ maxSnapshotVersion: undefined });
  });

  it("ignores a capability that is not an integer rather than trusting it", async () => {
    redeemPairingCode.mockResolvedValueOnce({ ok: false, error: "code_not_found" });
    await handlePairingRedeem(request({ code: "ABCD-EFGH-JKLM", maxSnapshotVersion: "7" }));
    expect(redeemPairingCode.mock.calls[0][4]).toEqual({ maxSnapshotVersion: undefined });
  });

  it("answers an update-required refusal as 409 with its code", async () => {
    redeemPairingCode.mockResolvedValueOnce({ ok: false, error: "pairing_requires_newer_client" });
    const response = await handlePairingRedeem(request({ code: "ABCD-EFGH-JKLM" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "pairing_requires_newer_client" });
  });
});
