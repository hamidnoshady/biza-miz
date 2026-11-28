/**
 * Issue #1430 — the Business Control Center's MCP argument contract.
 *
 * These are the properties the console's tolerant URL parser cannot express:
 * a bad filter is refused (never dropped, never widened), pagination is
 * bounded, and an owner-profile read never leaks a tenant outside the
 * credential's bridge scope.
 */
import { describe, expect, it } from "vitest";
import { BUSINESS_SORT_VALUES } from "../business-sort";
import { INDUSTRIES } from "../industries";
import type { OwnerProfile } from "../platform-owner-profile";
import {
  BUSINESS_DIRECTORY_DEFAULT_PAGE_SIZE,
  BUSINESS_DIRECTORY_FILTER_ENUMS,
  BUSINESS_DIRECTORY_MAX_OFFSET,
  BUSINESS_DIRECTORY_MAX_PAGE,
  BUSINESS_DIRECTORY_MAX_PAGE_SIZE,
  PlatformMcpInputError,
  parseBusinessDirectoryQuery,
  parseMembershipId,
  scopeOwnerProfileForCredential,
} from "./platform-business-tools";

describe("parseBusinessDirectoryQuery", () => {
  it("translates the console's full filter vocabulary into BusinessQuery", () => {
    expect(
      parseBusinessDirectoryQuery({
        search: "  cafe  ",
        status: "suspended",
        plan: "pro",
        industry: "jewelry",
        createdFrom: "2026-01-01",
        createdTo: "2026-03-31",
        activity: "active",
        sort: "members",
        sortDir: "asc",
        page: 2,
        pageSize: 50,
      }),
    ).toEqual({
      search: "cafe",
      status: "suspended",
      plan: "pro",
      industry: "jewelry",
      createdFrom: "2026-01-01",
      createdTo: "2026-03-31",
      activity: "active",
      sort: "members",
      sortDir: "asc",
      page: 2,
      pageSize: 50,
    });
  });

  it("defaults to the console's first page and 20-row page", () => {
    const query = parseBusinessDirectoryQuery({});
    expect(query.page).toBe(1);
    expect(query.pageSize).toBe(BUSINESS_DIRECTORY_DEFAULT_PAGE_SIZE);
    expect(query.status).toBeUndefined();
    expect(query.sort).toBeUndefined();
    expect(query.sortDir).toBeUndefined();
  });

  it("accepts every value the schema advertises", () => {
    for (const industry of INDUSTRIES) {
      expect(parseBusinessDirectoryQuery({ industry }).industry).toBe(industry);
    }
    for (const sort of BUSINESS_SORT_VALUES) {
      expect(parseBusinessDirectoryQuery({ sort }).sort).toBe(sort);
    }
    for (const status of BUSINESS_DIRECTORY_FILTER_ENUMS.status) {
      expect(parseBusinessDirectoryQuery({ status }).status).toBe(status);
    }
    for (const activity of BUSINESS_DIRECTORY_FILTER_ENUMS.activity) {
      expect(parseBusinessDirectoryQuery({ activity }).activity).toBe(activity);
    }
    for (const sortDir of BUSINESS_DIRECTORY_FILTER_ENUMS.sortDir) {
      expect(parseBusinessDirectoryQuery({ sortDir }).sortDir).toBe(sortDir);
    }
  });

  it("treats empty strings as 'no filter', like the console's URL", () => {
    expect(
      parseBusinessDirectoryQuery({
        search: "   ",
        status: "",
        plan: "",
        industry: "",
        activity: "",
        sort: "",
        sortDir: "",
      }),
    ).toEqual({ page: 1, pageSize: BUSINESS_DIRECTORY_DEFAULT_PAGE_SIZE });
  });

  it("keeps the legacy limit/offset pair working with the old arithmetic", () => {
    expect(parseBusinessDirectoryQuery({ limit: 25, offset: 50 })).toMatchObject({
      page: 3,
      pageSize: 25,
    });
    // Offset without limit keeps the console's default page size.
    expect(parseBusinessDirectoryQuery({ offset: 40 })).toMatchObject({
      page: 3,
      pageSize: BUSINESS_DIRECTORY_DEFAULT_PAGE_SIZE,
    });
  });

  it.each([
    [{ status: "deleted" }, "status"],
    [{ industry: "cafe" }, "industry"],
    [{ activity: "busy" }, "activity"],
    [{ sort: "revenue" }, "sort"],
    [{ sortDir: "up" }, "sortDir"],
    [{ createdFrom: "2026/01/01" }, "createdFrom"],
    [{ createdTo: "2026-02-30" }, "createdTo"],
    [{ page: 0 }, "page"],
    [{ page: 1.5 }, "page"],
    [{ page: BUSINESS_DIRECTORY_MAX_PAGE + 1 }, "page"],
    [{ page: "2" }, "page"],
    [{ pageSize: 0 }, "pageSize"],
    [{ pageSize: BUSINESS_DIRECTORY_MAX_PAGE_SIZE + 1 }, "pageSize"],
    [{ limit: 0 }, "limit"],
    [{ limit: BUSINESS_DIRECTORY_MAX_PAGE_SIZE + 1 }, "limit"],
    [{ offset: -1 }, "offset"],
    [{ offset: BUSINESS_DIRECTORY_MAX_OFFSET + 1 }, "offset"],
    [{ search: 7 }, "search"],
    [{ plan: false }, "plan"],
  ])("rejects %j instead of widening the filter", (args, field) => {
    expect(() => parseBusinessDirectoryQuery(args)).toThrow(PlatformMcpInputError);
    expect(() => parseBusinessDirectoryQuery(args)).toThrow(new RegExp(field));
  });

  it("refuses an inverted creation range", () => {
    expect(() =>
      parseBusinessDirectoryQuery({ createdFrom: "2026-06-02", createdTo: "2026-06-01" }),
    ).toThrow(/createdFrom must be on or before createdTo/);
  });

  it("refuses mixing the two pagination vocabularies", () => {
    expect(() => parseBusinessDirectoryQuery({ page: 2, offset: 20 })).toThrow(/not both/);
    expect(() => parseBusinessDirectoryQuery({ pageSize: 10, limit: 10 })).toThrow(/not both/);
  });
});

describe("scopeOwnerProfileForCredential", () => {
  const profile: OwnerProfile = {
    membershipId: "membership-a",
    role: "owner",
    membershipActive: true,
    membershipCreatedAt: "2026-01-01T00:00:00.000Z",
    fullName: "Owner One",
    membershipEmail: "owner@example.com",
    membershipPhone: "+989121234567",
    platformUserId: "identity-1",
    email: "owner@example.com",
    identityActive: true,
    identityCreatedAt: "2025-12-01T00:00:00.000Z",
    lastLoginAt: "2026-02-01T00:00:00.000Z",
    membershipCount: 3,
    otherBusinesses: [
      { id: "business-b", name: "Cafe Two" },
      { id: "business-c", name: "Cafe Three" },
    ],
    mfa: {
      method: "sms_otp",
      phoneE164: "+989121234567",
      confirmedAt: "2026-01-02T00:00:00.000Z",
      graceUntil: null,
      recoveryCodesRemaining: 2,
    },
    branchAccess: { locationId: null, locationName: null },
  };

  it("returns the console DTO untouched for an unscoped credential", () => {
    expect(scopeOwnerProfileForCredential(profile, null)).toBe(profile);
  });

  it("filters cross-business hints to the credential's bridge list", () => {
    const scoped = scopeOwnerProfileForCredential(profile, ["business-a", "business-c"]);
    expect(scoped.otherBusinesses).toEqual([{ id: "business-c", name: "Cafe Three" }]);
    // The identity's true reach stays visible: it explains consequential edits
    // without naming a tenant outside the credential's scope.
    expect(scoped.membershipCount).toBe(3);
    expect(scoped).not.toBe(profile);
    // The source DTO is never mutated for the next caller.
    expect(profile.otherBusinesses).toHaveLength(2);
  });

  it("keeps the same object when every hinted business is in scope", () => {
    const all = scopeOwnerProfileForCredential(profile, ["business-b", "business-c"]);
    expect(all).toBe(profile);
  });
});

describe("parseMembershipId", () => {
  it("normalizes a provided id", () => {
    expect(parseMembershipId("  membership-a  ")).toBe("membership-a");
  });

  it("treats absence as 'all owner/managers'", () => {
    expect(parseMembershipId(undefined)).toBeUndefined();
    expect(parseMembershipId(null)).toBeUndefined();
  });

  it("rejects an empty or non-string selector", () => {
    expect(() => parseMembershipId("   ")).toThrow(PlatformMcpInputError);
    expect(() => parseMembershipId(42)).toThrow(/membershipId/);
  });
});
