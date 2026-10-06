import { describe, expect, it } from "vitest";
import { issueHolooPreviewToken, verifyHolooPreviewToken, type HolooPreviewClaims } from "./preview-token";

const claims: HolooPreviewClaims = {
  businessId: "business-1",
  actorUserId: "user-1",
  connectionId: "connection-1",
  locationId: "location-1",
  source: "connected_sql",
  profileKey: "holoo-generic-v1",
  profileVersion: 1,
  scopes: ["goods", "persons"],
  inputFingerprint: "a".repeat(64),
};
const key = Buffer.from("preview-signing-test-key");

describe("Holoo preview approval tokens", () => {
  it("binds an apply to the same tenant, actor, connection, profile, scopes and source snapshot", () => {
    const token = issueHolooPreviewToken(claims, key, 1_000);
    expect(verifyHolooPreviewToken(token, claims, key, 2_000)).toBe(true);
    expect(verifyHolooPreviewToken(token, { ...claims, inputFingerprint: "b".repeat(64) }, key, 2_000)).toBe(false);
    expect(verifyHolooPreviewToken(token, { ...claims, businessId: "business-2" }, key, 2_000)).toBe(false);
    expect(verifyHolooPreviewToken(token, { ...claims, locationId: "location-2" }, key, 2_000)).toBe(false);
    expect(verifyHolooPreviewToken(token, { ...claims, scopes: ["persons", "goods"] }, key, 2_000)).toBe(true);
  });

  it("expires and refuses tampered tokens", () => {
    const token = issueHolooPreviewToken(claims, key, 1_000);
    expect(verifyHolooPreviewToken(token, claims, key, 15 * 60 * 1000 + 1_001)).toBe(false);
    const [payload, signature] = token.split(".");
    expect(verifyHolooPreviewToken(`${payload}.${signature.slice(1)}`, claims, key, 2_000)).toBe(false);
  });
});
