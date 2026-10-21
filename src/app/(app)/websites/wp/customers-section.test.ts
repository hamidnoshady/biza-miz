import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const section = readFileSync("src/app/(app)/websites/wp/customers-section.tsx", "utf8");

/**
 * The search box must survive its own keystrokes (#937): the toolbar that
 * holds it renders only when rows exist, so nulling the rows on every load
 * unmounted the focused input after the first character.
 */
describe("WP customers search keeps its focus", () => {
  it("debounces the server search while the input stays on the raw query", () => {
    expect(section).toContain("setDebouncedQuery(query)");
    expect(section).toContain("const needle = debouncedQuery.trim();");
    // The input itself is still controlled by the undebounced value, so
    // typing (IME composition included) is never rewritten mid-word.
    expect(section).toContain("value={query}");
  });

  it("retains the previous rows across reloads instead of nulling them", () => {
    // The only reset back to the skeleton is a store switch; a reload keeps
    // the rows (and with them the toolbar and its focused input) mounted.
    expect(section.split("setCustomers(null)")).toHaveLength(2);
    expect(section).toContain("setLoading(true)");
    expect(section).toContain("if (!hasLoadedRef.current) setCustomers([])");
  });

  it("aborts a superseded read and never reports the abort as an error", () => {
    expect(section).toContain("new AbortController()");
    expect(section).toContain("res.aborted");
  });

  it("keeps the list (with a retry banner) when a reload fails over existing rows", () => {
    expect(section).toContain("loadError && visible.length > 0");
    expect(section).toContain("loadError && visible.length === 0");
  });
});

describe("WP customers list is status-aware (#937)", () => {
  it("renders the reconciliation status the read model derived", () => {
    expect(section).toContain("CUSTOMER_STATUS_META");
    expect(section).toContain("CUSTOMER_STATUS_META[c.status]");
  });

  it("sends unreconciled rows to CRM reconciliation, linked rows to their party file", () => {
    expect(section).toContain('crmSectionHref("reconciliation")');
    expect(section).toContain("crmCustomerHref(c.localId)");
  });

  it("filters by status on the server, not by hiding rows on the page", () => {
    expect(section).toContain('params.set("status", nextStatus)');
  });
});
