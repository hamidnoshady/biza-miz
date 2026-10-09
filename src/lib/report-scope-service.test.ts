import { beforeEach, describe, expect, it, vi } from "vitest";

const resolvers = vi.hoisted(() => ({
  resolveActiveLocation: vi.fn(),
  resolveActiveLocationForUser: vi.fn(),
}));
vi.mock("./setup-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./setup-state")>()),
  ...resolvers,
}));

import {
  authorizedReportScope,
  authorizedReportScopeForUser,
} from "./report-scope-service";

const SESSION = { businessId: "biz-a", sub: "user-a", role: "manager" } as never;
const LOCATION = { id: "loc-b", name: "شعبهٔ ب", timezone: "Asia/Tehran" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  resolvers.resolveActiveLocation.mockResolvedValue(LOCATION);
  resolvers.resolveActiveLocationForUser.mockResolvedValue(LOCATION);
});

describe("authorizedReportScope", () => {
  it("re-reads the active branch for an ordinary report", async () => {
    const authorizeBusinessWide = vi.fn(async () => true);
    const result = await authorizedReportScope(SESSION, { authorizeBusinessWide });
    expect(result).toMatchObject({
      ok: true,
      scope: { mode: "branch", locationId: "loc-b", location: LOCATION },
    });
    expect(resolvers.resolveActiveLocation).toHaveBeenCalledWith(SESSION);
    expect(authorizeBusinessWide).not.toHaveBeenCalled();
  });

  it("refuses an ordinary report after the assignment is revoked", async () => {
    resolvers.resolveActiveLocation.mockResolvedValue(null);
    const result = await authorizedReportScope(SESSION, { authorizeBusinessWide: async () => true });
    expect(result).toEqual({ ok: false, reason: "no_accessible_branch" });
  });

  it("uses a separate capability path for consolidated reports, with no branch lookup", async () => {
    const authorizeBusinessWide = vi.fn(async () => true);
    const result = await authorizedReportScope(SESSION, {
      requested: "business-wide",
      authorizeBusinessWide,
    });
    expect(result).toEqual({
      ok: true,
      scope: { mode: "business-wide", locationId: undefined, location: null },
    });
    expect(authorizeBusinessWide).toHaveBeenCalledOnce();
    expect(resolvers.resolveActiveLocation).not.toHaveBeenCalled();
  });

  it("refuses consolidated access when the elevated authorization fails", async () => {
    const result = await authorizedReportScope(SESSION, {
      requested: "business-wide",
      authorizeBusinessWide: async () => false,
    });
    expect(result).toEqual({ ok: false, reason: "business_wide_forbidden" });
    expect(resolvers.resolveActiveLocation).not.toHaveBeenCalled();
  });
});

describe("authorizedReportScopeForUser (AI read tools)", () => {
  it("uses the acting member's assigned branch, not a business primary location", async () => {
    const result = await authorizedReportScopeForUser("biz-a", "user-a", {
      hasBusinessWide: false,
    });
    expect(result).toMatchObject({
      ok: true,
      scope: { mode: "branch", locationId: "loc-b", location: LOCATION },
    });
    expect(resolvers.resolveActiveLocationForUser).toHaveBeenCalledWith("biz-a", "user-a", null);
  });

  it("keeps an MCP read on the location its connection was authorized for", async () => {
    const result = await authorizedReportScopeForUser("biz-a", "user-a", {
      hasBusinessWide: false,
      pinnedLocationId: "loc-b",
    });
    expect(result).toMatchObject({ ok: true, scope: { mode: "branch", locationId: "loc-b" } });
    expect(resolvers.resolveActiveLocationForUser).toHaveBeenCalledWith("biz-a", "user-a", "loc-b");
  });

  it("refuses a pinned MCP branch instead of silently falling back to another assignment", async () => {
    resolvers.resolveActiveLocationForUser.mockResolvedValue({ id: "loc-c", name: "شعبهٔ ج" });
    const result = await authorizedReportScopeForUser("biz-a", "user-a", {
      hasBusinessWide: false,
      pinnedLocationId: "loc-b",
    });
    expect(result).toEqual({ ok: false, reason: "no_accessible_branch" });
  });

  it("refuses when the acting member has no accessible branch", async () => {
    resolvers.resolveActiveLocationForUser.mockResolvedValue(null);
    const result = await authorizedReportScopeForUser("biz-a", "user-a", {
      hasBusinessWide: true,
    });
    expect(result).toEqual({ ok: false, reason: "no_accessible_branch" });
  });

  it("does not resolve a branch for an explicitly authorized consolidated read", async () => {
    const result = await authorizedReportScopeForUser("biz-a", "user-a", {
      requested: "business-wide",
      hasBusinessWide: true,
    });
    expect(result).toEqual({
      ok: true,
      scope: { mode: "business-wide", locationId: undefined, location: null },
    });
    expect(resolvers.resolveActiveLocationForUser).not.toHaveBeenCalled();
  });

  it("does not grant any report scope to an anonymous/background actor", async () => {
    const result = await authorizedReportScopeForUser("biz-a", undefined, {
      requested: "business-wide",
      hasBusinessWide: true,
    });
    expect(result).toEqual({ ok: false, reason: "no_accessible_branch" });
    expect(resolvers.resolveActiveLocationForUser).not.toHaveBeenCalled();
  });
});
