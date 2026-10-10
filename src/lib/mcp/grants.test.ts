import { describe, expect, it } from "vitest";
import {
  LEGACY_GRANTS,
  MCP_APPS,
  defaultGrantsForConsents,
  grantsToStorage,
  isLegacyGrants,
  mcpBranchScopeOf,
  mcpBrancheIds,
  mcpCanReadApp,
  mcpCanWriteApp,
  mcpGrantsUsable,
  parseMcpGrants,
  validateMcpGrantsMint,
  type McpGrants,
} from "./grants";

describe("parseMcpGrants", () => {
  it("treats the legacy empty document as the conservative full set", () => {
    const grants = parseMcpGrants({});
    expect(grants.apps).toEqual({});
    expect(grants.branches).toBe("all");
    expect(isLegacyGrants(grants)).toBe(true);
  });

  it("treats missing and malformed top-level values as the legacy default, so an unreadable legacy row never loses access", () => {
    for (const value of [null, undefined, [], "string", 42, true]) {
      expect(parseMcpGrants(value)).toBe(LEGACY_GRANTS);
    }
  });

  it("keeps only known apps and the explicit read/write booleans", () => {
    const grants = parseMcpGrants({
      apps: {
        crm: { read: true, write: false },
        accounting: { read: "yes", write: true },
        pos: "everything",
        unknown_app: { read: true },
      },
      branches: ["loc-1"],
    });
    expect(grants.apps).toEqual({
      crm: { read: true, write: false },
      // Coerced: only `=== true` counts so string/number leaks cannot widen.
      accounting: { read: false, write: true },
    });
    expect(grants.branches).toEqual(["loc-1"]);
  });

  it("parses branches as an explicit list or 'all' — never the other way around", () => {
    expect(parseMcpGrants({ branches: "all" }).branches).toBe("all");
    expect(parseMcpGrants({ branches: ["a", 42, "b", ""] }).branches).toEqual(["a", "b"]);
  });

  it("parses a malformed branches value to CLOSED — never back to 'all'", () => {
    for (const value of [
      { branches: "most" },
      { branches: 7 },
      { branches: null },
      { branches: { a: true } },
    ]) {
      expect(parseMcpGrants(value).branches).toEqual([]);
    }
  });

  it("drops unknown top-level keys without complaint — never widens on them", () => {
    const grants = parseMcpGrants({
      apps: { crm: { read: true } },
      branches: ["a"],
      admin: true,
      scopes: ["pos.admin"],
    });
    expect(grants).toEqual({
      apps: { crm: { read: true, write: false } },
      branches: ["a"],
    });
  });

  it("keeps empty arrays/objects so a stored closed document round-trips closed", () => {
    const grants = parseMcpGrants({ apps: {}, branches: [] });
    expect(grants.branches).toEqual([]);
    expect(mcpGrantsUsable(grants)).toBe(false);
    expect(isLegacyGrants(grants)).toBe(false);
  });

  it("does NOT treat 'apps empty + branches all' as closed — that IS legacy", () => {
    const grants = parseMcpGrants({ apps: {}, branches: "all" });
    expect(isLegacyGrants(grants)).toBe(true);
    expect(mcpGrantsUsable(grants)).toBe(true);
  });
});

describe("consent derivations", () => {
  it("single vs multi branch scope is derived from the consented set", () => {
    expect(mcpBranchScopeOf(parseMcpGrants({}))).toBe("multi");
    expect(
      mcpBranchScopeOf(parseMcpGrants({ apps: { crm: { read: true } }, branches: "all" })),
    ).toBe("multi");
    expect(
      mcpBranchScopeOf(parseMcpGrants({ apps: { crm: { read: true } }, branches: ["a"] })),
    ).toBe("single");
    expect(
      mcpBranchScopeOf(parseMcpGrants({ apps: { crm: { read: true } }, branches: ["a", "b"] })),
    ).toBe("multi");
  });

  it("brancheIds is null only for explicit-all consent", () => {
    expect(mcpBrancheIds(parseMcpGrants({}))).toBeNull();
    expect(mcpBrancheIds(parseMcpGrants({ apps: { crm: { read: true } }, branches: "all" }))).toBeNull();
    expect(
      mcpBrancheIds(parseMcpGrants({ apps: { crm: { read: true } }, branches: ["a", "b"] })),
    ).toEqual(["a", "b"]);
  });
});

describe("per-app access", () => {
  it("legacy answers yes everywhere, as it did when minted", () => {
    const grants = parseMcpGrants({});
    expect(mcpCanReadApp(grants, "crm")).toBe(true);
    expect(mcpCanWriteApp(grants, "accounting")).toBe(true);
  });

  it("an explicit document honors exactly its booleans — nothing else reaches", () => {
    const grants = parseMcpGrants({
      apps: { crm: { read: true, write: false }, accounting: { read: true, write: true } },
      branches: "all",
    });
    expect(mcpCanReadApp(grants, "crm")).toBe(true);
    expect(mcpCanWriteApp(grants, "crm")).toBe(false);
    expect(mcpCanWriteApp(grants, "accounting")).toBe(true);
    expect(mcpCanReadApp(grants, "pos")).toBe(false);
    expect(mcpCanWriteApp(grants, "pos")).toBe(false);
  });
});

describe("validateMcpGrantsMint", () => {
  it("rejects documents that grant nothing — a mint is supposed to MEAN something", () => {
    expect(
      validateMcpGrantsMint(parseMcpGrants({ apps: { crm: { read: false } }, branches: ["a"] })),
    ).toBe("no_apps");
    expect(validateMcpGrantsMint(parseMcpGrants({}))).toBeNull(); // legacy passes
  });

  it("rejects write-without-read — a blind writer is not a thing", () => {
    expect(
      validateMcpGrantsMint(
        parseMcpGrants({ apps: { crm: { read: "yes", write: true } }, branches: ["a"] }),
      ),
    ).toBe("write_without_read");
  });

  it("rejects an empty branch set — the connector would be blind", () => {
    expect(
      validateMcpGrantsMint(
        parseMcpGrants({ apps: { crm: { read: true } }, branches: [] }),
      ),
    ).toBe("no_branches");
  });

  it("accepts a well-formed document", () => {
    expect(
      validateMcpGrantsMint(
        parseMcpGrants({
          apps: { crm: { read: true, write: false } },
          branches: ["loc-a", "loc-b"],
        }),
      ),
    ).toBeNull();
  });

  it("accepts the all-branches consent when the apps are explicit", () => {
    expect(
      validateMcpGrantsMint(
        parseMcpGrants({
          apps: { crm: { read: true }, accounting: { read: true, write: true } },
          branches: "all",
        }),
      ),
    ).toBeNull();
  });
});


describe("defaultGrantsForConsents / grantsToStorage (issue #883 safe defaults)", () => {
  it("the panel default is read-everything, write-nothing, current-branch-only", () => {
    const grants = defaultGrantsForConsents("loc-main");
    expect(grants.branches).toEqual(["loc-main"]);
    for (const app of MCP_APPS) {
      expect(grants.apps[app]).toEqual({ read: true, write: false });
    }
    // It must complete mint validation as-is — the safe default must not be
    // an editing trap.
    expect(validateMcpGrantsMint(grants)).toBeNull();
    expect(isLegacyGrants(grants)).toBe(false);
  });

  it("storage round-trips through parse", () => {
    const grants = defaultGrantsForConsents("loc-main");
    grants.apps.crm = { read: true, write: true };
    grants.branches = ["loc-main", "loc-west"];
    const parsed = parseMcpGrants(grantsToStorage(grants));
    expect(parsed).toEqual(grants);
  });

  it("the all-branches storage shape round-trips too", () => {
    const grants: McpGrants = {
      apps: { pos: { read: true, write: true } },
      branches: "all",
    };
    expect(parseMcpGrants(grantsToStorage(grants))).toEqual(grants);
  });
});
