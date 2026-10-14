/**
 * A queue, as a view its owning screen can open.
 *
 * ## A queue is a promise about rows; this is how it is kept
 *
 * A queue card says «۶ مورد» and lists four. Until now there was no way to see
 * the other two: the card's only links were the individual rows, and the section
 * it belonged to opened unfiltered. So a queue was a *number* a person had to
 * trust, and the screen it pointed at could not be asked the question the number
 * answered.
 *
 * Each document below is built by the owning screen's own serialiser
 * (`crm-case-views.ts`, `crm-activity-views.ts`) rather than by hand, so the
 * link a queue emits is, by construction, a query that screen's parser accepts —
 * the two cannot drift. `integration/crm-queues.integration.test.ts` goes
 * further and asks the service for the rows the document names, demanding that
 * they be the queue's own rows.
 *
 * ## Why this is a pure module
 *
 * The table is a contract, not an implementation detail: it says which queues a
 * person can open as a filtered list, and that is a fact about the product that
 * should be readable and testable without a database. `crm-queues.ts` — which
 * owns the rules and therefore reaches `db` — imports it.
 *
 * ## Why some queues have none
 *
 * `null` is an answer, not an omission, and the reasons are the interesting
 * part:
 *
 * - `stalled_deals` and `high_value_open` are relative to the row set: «no
 *   activity for seven days» is a rule over a related table, and the top
 *   quintile is a *percentile* of the current values, which no stored threshold
 *   reproduces once a deal is added.
 * - `departed_owner` is a union over deals *and* tickets, so no single screen's
 *   vocabulary names it.
 * - `new_leads` carries a recency window and a «not converted» test the leads
 *   vocabulary does not declare.
 * - `vip_follow_up` and `at_risk_customers` are scored populations: the score is
 *   computed across the whole customer list, so the filter that reproduced them
 *   would have to be the score itself.
 * - `new_identities` and `possible_duplicates` are workspaces that *are* their
 *   own list.
 *
 * Naming them here is the point. The alternative — a link that opens a screen
 * showing something else — is worse than no link, because it teaches people that
 * the count is approximate.
 */

import { CRM_QUEUE_PRESENTATION, type CrmQueueKey } from "./crm-shared";
import { EMPTY_CASE_VIEW_FILTERS, caseViewQuery } from "./crm-case-views";
import { EMPTY_ACTIVITY_VIEW_FILTERS, activityViewQuery } from "./crm-activity-views";

export interface CrmQueueView {
  /** The owning screen, with the filter document already serialised. */
  href: string;
  /** The document itself, in the owning screen's own vocabulary. */
  filters: Record<string, string>;
}

/** The section key's own route. `overview` is the home page, not `/crm/overview`. */
function sectionHref(section: string): string {
  return section === "overview" ? "/crm/overview" : `/crm/${section}`;
}

export function crmQueueView(key: CrmQueueKey): CrmQueueView | null {
  const section = CRM_QUEUE_PRESENTATION[key].sections[0];
  if (!section) return null;
  const filters = crmQueueViewFilters(key);
  if (!filters) return null;
  return {
    href: `${sectionHref(section)}?${new URLSearchParams(filters).toString()}`,
    filters,
  };
}

/**
 * The document itself, or `null` for a queue whose rule a screen cannot state.
 *
 * Kept separate from the href so a test can ask «which queues are openable?»
 * without parsing a URL string.
 */
export function crmQueueViewFilters(key: CrmQueueKey): Record<string, string> | null {
  switch (key) {
    case "overdue_follow_ups":
      return activityViewQuery({ ...EMPTY_ACTIVITY_VIEW_FILTERS, state: "overdue" });
    case "due_today":
      return activityViewQuery({ ...EMPTY_ACTIVITY_VIEW_FILTERS, state: "today" });
    case "sla_risk":
      return caseViewQuery({ ...EMPTY_CASE_VIEW_FILTERS, openOnly: true, breachedOnly: true });
    case "waiting_on_customer":
      return caseViewQuery({ ...EMPTY_CASE_VIEW_FILTERS, status: "waiting" });
    case "unassigned_cases":
      return caseViewQuery({ ...EMPTY_CASE_VIEW_FILTERS, openOnly: true, assignee: "none" });
    default:
      // Every other queue is one of the cases named in the module comment, and
      // a `default` that guessed would be the drift this module exists to stop.
      return null;
  }
}
