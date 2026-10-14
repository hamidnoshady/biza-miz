import { describe, expect, it } from "vitest";
import {
  databaseAuthorizationSettings,
  getAuthorizationSnapshot,
  setAuthorizationSnapshot,
  withAuthorizationContext,
  type AuthorizationSnapshot,
} from "./authorization-context";
import type { TenantScope } from "./tenant-context";

const activeSnapshot: AuthorizationSnapshot = {
  businessId: "business-1",
  userId: "member-1",
  membershipActive: true,
  businessActive: true,
  canCloseFiscalPeriod: true,
};
const matchingScope: TenantScope = {
  kind: "business",
  businessId: "business-1",
  locationId: null,
  userId: "member-1",
};

const deniedSettings = { actorId: "", canCloseFiscalPeriod: "" };

describe("databaseAuthorizationSettings", () => {
  it("forwards only an active canonical grant for the matching tenant and actor", () => {
    expect(databaseAuthorizationSettings(matchingScope, activeSnapshot)).toEqual({
      actorId: "member-1",
      canCloseFiscalPeriod: "on",
    });
  });

  it.each([
    ["a different business", { ...matchingScope, businessId: "business-2" }],
    ["a different actor", { ...matchingScope, userId: "member-2" }],
    ["a background scope without a member", { ...matchingScope, userId: null }],
    ["an unscoped request", { kind: "none" }],
    ["a privileged bypass", { kind: "bypass", reason: "test" }],
  ] as const)("does not forward authority for %s", (_label, scope) => {
    expect(databaseAuthorizationSettings(scope, activeSnapshot)).toEqual(deniedSettings);
  });

  it.each([
    ["an inactive membership", { ...activeSnapshot, membershipActive: false }],
    ["an inactive business", { ...activeSnapshot, businessActive: false }],
  ] as const)("fails closed for %s", (_label, snapshot) => {
    expect(databaseAuthorizationSettings(matchingScope, snapshot)).toEqual(deniedSettings);
  });

  it("keeps the active actor but withholds the DB capability when the permission is absent", () => {
    expect(databaseAuthorizationSettings(matchingScope, { ...activeSnapshot, canCloseFiscalPeriod: false })).toEqual({
      actorId: "member-1",
      canCloseFiscalPeriod: "",
    });
  });

  it("fails closed when the request has no authorization snapshot", () => {
    expect(databaseAuthorizationSettings(matchingScope, null)).toEqual(deniedSettings);
  });

  it("makes authorization available to the caller continuation after authorize resolves", async () => {
    await withAuthorizationContext(async () => {
      expect(getAuthorizationSnapshot()).toBeNull();
      const authorize = async () => {
        await Promise.resolve();
        setAuthorizationSnapshot(activeSnapshot);
      };
      await authorize();
      await Promise.resolve();
      expect(getAuthorizationSnapshot()).toEqual(activeSnapshot);
    });
    expect(getAuthorizationSnapshot()).toBeNull();
  });

  it("isolates concurrent requests from each other's snapshots", async () => {
    const otherSnapshot = { ...activeSnapshot, userId: "member-2" };
    const [first, second] = await Promise.all([
      withAuthorizationContext(async () => {
        setAuthorizationSnapshot(activeSnapshot);
        await Promise.resolve();
        return getAuthorizationSnapshot();
      }),
      withAuthorizationContext(async () => {
        setAuthorizationSnapshot(otherSnapshot);
        await Promise.resolve();
        return getAuthorizationSnapshot();
      }),
    ]);
    expect(first?.userId).toBe("member-1");
    expect(second?.userId).toBe("member-2");
  });
});
