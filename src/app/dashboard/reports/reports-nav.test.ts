import { describe, expect, it } from "vitest";
import {
  isReportsTabKey,
  REPORTS_TABS,
  reportsTabHref,
  reportsTabsForCapabilities,
  resolveReportsTab,
} from "./reports-nav";
import { reportCapabilities } from "@/lib/report-permissions";
import { PERMISSIONS } from "@/lib/permissions";

/** A capability object with every reporting key held. */
const full = reportCapabilities(new Set(Object.values(PERMISSIONS).filter((key) => key.startsWith("reports."))));

describe("REPORTS_TABS", () => {
  it("lists every section exactly once, first tab first", () => {
    const keys = REPORTS_TABS.map((tab) => tab.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe("standard");
  });

  it("points every section at the reports tabbed route", () => {
    for (const tab of REPORTS_TABS) {
      const href = reportsTabHref(tab.key);
      expect(href.startsWith("/accounting/reports")).toBe(true);
      expect(href).toContain(`tab=${tab.key}`);
    }
  });

  it("names a real capability for every tab", () => {
    for (const tab of REPORTS_TABS) {
      expect(tab.capability in full, tab.key).toBe(true);
    }
  });
});

describe("reportsTabsForCapabilities", () => {
  it("shows the owner (every capability) the branch comparison too", () => {
    expect(reportsTabsForCapabilities(full).map((t) => t.key)).toEqual(
      REPORTS_TABS.map((t) => t.key),
    );
  });

  it("offers a read-only member the sections they can run, and no branch comparison", () => {
    const capabilities = reportCapabilities(new Set([PERMISSIONS.reportsView]));
    const keys = reportsTabsForCapabilities(capabilities).map((t) => t.key);
    expect(keys).toContain("standard");
    expect(keys).toContain("builder");
    expect(keys).not.toContain("branches");
  });

  it("offers the branch comparison to any member actually granted the capability", () => {
    const capabilities = reportCapabilities(
      new Set([PERMISSIONS.reportsView, PERMISSIONS.reportsBusinessWide]),
    );
    expect(reportsTabsForCapabilities(capabilities).map((t) => t.key)).toContain("branches");
  });

  it("shows nothing to a member the reports page already refuses", () => {
    expect(reportsTabsForCapabilities(reportCapabilities(new Set()))).toEqual([]);
  });
});

describe("resolveReportsTab", () => {
  it("honours a requested tab that is in the member's own list", () => {
    const tabs = reportsTabsForCapabilities(full);
    expect(resolveReportsTab("builder", tabs)).toBe("builder");
    expect(resolveReportsTab("branches", tabs)).toBe("branches");
  });

  it("falls back to the first allowed tab for an unknown key", () => {
    expect(resolveReportsTab("nonsense", reportsTabsForCapabilities(full))).toBe("standard");
    expect(resolveReportsTab(null, reportsTabsForCapabilities(full))).toBe("standard");
  });

  it("refuses a valid-but-disallowed tab, so a crafted URL cannot render it", () => {
    // The key is real; the member's capabilities simply do not include it.
    const readOnly = reportsTabsForCapabilities(reportCapabilities(new Set([PERMISSIONS.reportsView])));
    expect(isReportsTabKey("branches")).toBe(true);
    expect(resolveReportsTab("branches", readOnly)).toBe("standard");
  });

  it("answers null when the member has no tabs at all", () => {
    expect(resolveReportsTab("standard", [])).toBeNull();
  });
});

describe("isReportsTabKey", () => {
  it("accepts the known keys and rejects the unknown", () => {
    expect(isReportsTabKey("builder")).toBe(true);
    expect(isReportsTabKey("standard")).toBe(true);
    expect(isReportsTabKey("nonsense")).toBe(false);
    expect(isReportsTabKey(null)).toBe(false);
  });
});
