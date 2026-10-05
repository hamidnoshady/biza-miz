/**
 * Every queue that can be opened, opened.
 *
 * A queue card says «۶ مورد» and shows four. This module is what makes the
 * other two reachable — and, more importantly, what makes the *claim* honest:
 * the link a card renders is a document in its owning screen's vocabulary, and
 * that screen's own parser must accept it. If the two ever drift, a reader
 * following «دیدن همه» lands on something that is not the queue, which is worse
 * than no link at all, because it teaches them the count is approximate.
 *
 * So this file asserts the drift-prevention directly:
 *
 *   1. **Round trip.** Each document parses with no error and re-serialises to
 *      itself — nothing is dropped on the way in or invented on the way out.
 *   2. **The link and the document agree.** The href carries exactly the
 *      document, under the section that owns the queue.
 *   3. **Exactly five are openable, and the rest are named.** The `null`s are a
 *      decision, argued in `crm-queue-views.ts`; listing them here means adding
 *      a queue, or opening one, is a deliberate act rather than a default.
 */
import { describe, expect, it } from "vitest";
import { CRM_QUEUE_KEYS, CRM_QUEUE_PRESENTATION, type CrmQueueKey } from "./crm-shared";
import { crmQueueView, crmQueueViewFilters } from "./crm-queue-views";
import { parseCaseViewFilters, caseViewQuery } from "./crm-case-views";
import { parseActivityViewFilters, activityViewQuery } from "./crm-activity-views";

/** The queues whose rule a screen's vocabulary can state — the whole point of the table. */
const OPENABLE: Record<string, Record<string, string>> = {
  overdue_follow_ups: { state: "overdue" },
  due_today: { state: "today" },
  sla_risk: { open: "1", breached: "1" },
  waiting_on_customer: { status: "waiting" },
  unassigned_cases: { open: "1", assignee: "none" },
};

/**
 * The queues with no view, and the reason is not repeated here — `crm-queue-views.ts`
 * argues each one. This list exists so that *removing* a reason, or adding a
 * queue that silently has no link, fails a test.
 */
const NOT_OPENABLE: CrmQueueKey[] = [
  "stalled_deals",
  "high_value_open",
  "departed_owner",
  "new_leads",
  "vip_follow_up",
  "at_risk_customers",
  "new_identities",
  "possible_duplicates",
];

/**
 * A document in the case vocabulary, read back the way the desk reads it.
 *
 * Deliberately through the desk's own parser and serialiser rather than by
 * comparing objects: the question is not «is this the same plain object» but «does
 * the screen that receives it see the same filter».
 */
function caseRoundTrip(document: Record<string, string>) {
  const source = new URLSearchParams(document);
  const parsed = parseCaseViewFilters(source);
  return { parsed, rendered: caseViewQuery(parsed.filters) };
}

function activityRoundTrip(document: Record<string, string>) {
  const source = new URLSearchParams(document);
  const parsed = parseActivityViewFilters(source);
  return { parsed, rendered: activityViewQuery(parsed.filters) };
}

describe("crmQueueViewFilters", () => {
  it("opens exactly the queues that say they are openable", () => {
    const openable = Object.fromEntries(
      CRM_QUEUE_KEYS.map((key) => [key, crmQueueViewFilters(key)]),
    );
    for (const [key, document] of Object.entries(OPENABLE)) {
      expect(openable[key], key).toEqual(document);
    }
    for (const key of NOT_OPENABLE) {
      expect(openable[key], key).toBeNull();
    }
    // Every declared queue is in one list or the other: a new queue must be a
    // decision, not a `null` nobody looked at.
    expect([...Object.keys(OPENABLE), ...NOT_OPENABLE].sort()).toEqual([...CRM_QUEUE_KEYS].sort());
  });

  it("is a non-empty document in the owning screen's own vocabulary", () => {
    for (const key of CRM_QUEUE_KEYS) {
      const document = crmQueueViewFilters(key);
      if (document === null) continue;
      expect(Object.keys(document).length, key).toBeGreaterThan(0);
      for (const value of Object.values(document)) {
        expect(value, key).not.toBe("");
      }
    }
  });

  it("survives the case desk's parser unchanged", () => {
    for (const [key, document] of Object.entries(OPENABLE)) {
      if (key === "overdue_follow_ups" || key === "due_today") continue;
      const { parsed, rendered } = caseRoundTrip(document);
      // `null` is the parser's «no complaint»; an error is a field name.
      expect(parsed.error, key).toBeNull();
      expect(rendered, key).toEqual(document);
    }
  });

  it("survives the task list's parser unchanged", () => {
    for (const key of ["overdue_follow_ups", "due_today"]) {
      const document = OPENABLE[key];
      const { parsed, rendered } = activityRoundTrip(document);
      expect(parsed.error, key).toBeNull();
      expect(rendered, key).toEqual(document);
    }
  });
});

describe("crmQueueView", () => {
  it("links to the section that owns the queue, with the document in the query", () => {
    for (const key of CRM_QUEUE_KEYS) {
      const view = crmQueueView(key);
      const document = crmQueueViewFilters(key);
      if (document === null) {
        expect(view, key).toBeNull();
        continue;
      }
      expect(view, key).not.toBeNull();
      const section = CRM_QUEUE_PRESENTATION[key].sections[0];
      const url = new URL(view!.href, "https://example.test");
      expect(url.pathname, key).toBe(section === "overview" ? "/crm/overview" : `/crm/${section}`);
      // Reading the link back gives the document — the link is not a second
      // spelling of the filter that can fall out of step with the first.
      const read = Object.fromEntries(url.searchParams.entries());
      expect(read, key).toEqual(document);
    }
  });

  it("spells the section route the way the app's own routes do", () => {
    // `overview` is the home page, not `/crm/overview`-as-a-section: the one
    // queue that lives there must link to a route that exists.
    const view = crmQueueView("sla_risk");
    expect(view?.href.startsWith("/crm/cases?")).toBe(true);
  });
});
