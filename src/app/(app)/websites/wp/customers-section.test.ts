import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const section = readFileSync("src/app/(app)/websites/wp/customers-section.tsx", "utf8");

/**
 * The search box must survive its own keystrokes (#937): the toolbar that
 * holds it renders only when rows exist, so nulling the rows on every load
 * unmounted the focused input after the first character.
 *
 * The screen was rewritten by the WooCommerce customer-identity work (#937's
 * own read model, rendered as `identityStatus`/`IDENTITY_LABELS`) while this
 * suite was written against the first draft's names. The behaviour assertions
 * are the same; the anchors point at the mechanism that survived the merge.
 */
describe("WP customers search keeps its focus", () => {
  it("debounces the server search while the input stays on the raw query", () => {
    expect(section).toContain("setDebouncedQuery(query)");
    // The words that reach the request are trimmed from the *raw* query, so a
    // debounce tick never rewrites what is in the box.
    expect(section).toContain("const needle = query.trim();");
    // The input itself is still controlled by the undebounced value, so
    // typing (IME composition included) is never rewritten mid-word.
    expect(section).toContain("value={query}");
    expect(section).toContain("onCompositionStart");
  });

  it("retains the previous rows across reloads instead of nulling them", () => {
    // The only resets back to the skeleton are the two store switches (the
    // picker's own handler and the selection effect); a reload keeps the rows
    // — and with them the toolbar and its focused input — mounted.
    expect(section.split("setCustomers(null)")).toHaveLength(3);
    expect(section).toContain("if (selectedId && !searchComposing) void load(selectedId, page, pageSize, debouncedQuery)");
    // The screen still tells the reader a read is in flight without dropping
    // the rows it has.
    expect(section).toContain("aria-busy={query !== debouncedQuery || searchComposing || customers === null}");
  });

  it("aborts a superseded read and never reports the abort as an error", () => {
    // Supersede protection is a sequence stamp rather than an AbortController:
    // a response whose stamp is stale (or whose store changed, or that lands
    // after unmount) is dropped before it can touch state.
    expect(section).toContain("const seq = ++loadSeqRef.current;");
    expect(section).toContain("seq !== loadSeqRef.current");
    expect(section).toContain("loadSeqRef.current += 1");
  });

  it("keeps the list (with a retry banner) when a reload fails over existing rows", () => {
    // A failed reload keeps what is on screen and says it may be stale; only a
    // read with nothing to keep gets the full error card.
    expect(section).toContain("loadError && customers !== null && customers.length > 0");
    expect(section).toContain("loadError && (customers === null || customers.length === 0)");
    expect(section).toContain("به‌روزرسانی فهرست مشتریان ناموفق بود");
  });
});

describe("WP customers list is status-aware (#937)", () => {
  it("renders the reconciliation status the read model derived", () => {
    expect(section).toContain("IDENTITY_LABELS");
    expect(section).toContain("IDENTITY_LABELS[c.identityStatus]");
    expect(section).toContain("identityTone(c.identityStatus)");
  });

  it("sends unreconciled rows to CRM reconciliation, linked rows to their party file", () => {
    // Reconciliation is offered on the rows the read model could not link;
    // linked rows open their own CRM party file instead.
    expect(section).toContain('href="/crm/reconciliation"');
    expect(section).toContain("crmCustomerHref(c.localId)");
    expect(section).toContain('["unmapped", "needs_review", "conflict"].includes(c.identityStatus)');
  });

  it("filters by status on the server, not by hiding rows on the page", () => {
    expect(section).toContain("identity: identityFilter");
    expect(section).toContain("remote: remoteFilter");
  });
});
