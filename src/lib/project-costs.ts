/**
 * Issue #907 F04 — the one definition of what a project cost, in SQL.
 *
 * Before this, four places answered "how much has this project spent?" and
 * three of them answered differently:
 *
 * - `workspace.projectReport` summed **every debit** on the project's entries.
 *   A project sale debits receivables, so selling more raised "spend"; a
 *   reversal credits the expense account, so an expense that was undone still
 *   counted in full.
 * - `aec-boq-service.projectControlSummary` did the same thing again, in its own
 *   string, so the two could drift apart on the next edit.
 * - `ai-projects.listProjectCostReport` / `getProjectCostSummary` summed debits
 *   filtered by `posting_kind = 'marketing_campaign_cost'` — a third answer that
 *   only counted campaign cost.
 *
 * The audit asked for a canonical ledger query reused by the report, the
 * cockpit, insights and the assistant. That is this module: the policy is
 * written once, as a correlated subquery any of them can paste into a SELECT,
 * and it is pure SQL text so a client-adjacent module can import it without
 * pulling the database pool in.
 *
 * ## The policy
 *
 * A project's **cost** is the net debit on **expense accounts** of the entries
 * attributed to that project:
 *
 * - **Expense accounts only** (`accounts.type = 'expense'`). That is where the
 *   chart of accounts keeps cost of sales and operating cost. A receivable,
 *   a bank line or a revenue line is not a cost however large its debit is, and
 *   a capitalized amount (an asset account, e.g. work in progress) is not a cost
 *   until it is expensed — counting both would double-count the same money.
 * - **Net, `debit - credit`.** Reversals and refunds are real posted entries
 *   that credit the account they debited (0029 reverses rather than deletes), so
 *   netting is what makes "the expense was undone" true in the number. Summing
 *   debits alone ignores the accounting domain's own correction mechanism.
 * - **Posted entries only.** In this schema every `journal_entries` row is
 *   posted: drafts live in `journal_entry_drafts` (0029) and reach
 *   `journal_entries` only when approved, and a fiscal-period lock (0024)
 *   refuses late postings. There is therefore no "unposted" row to filter, and a
 *   `status` filter here would be a filter on a column that does not exist.
 * - **A reversal belongs to the project it reverses.** A reversal mirrors the
 *   original's lines but not every writer copies `project_id` onto it (the A/P
 *   and manual-journal reversals post through `postJournalEntry` without one).
 *   Attributing it through `reverses_entry_id` states the rule once, in the
 *   query, instead of depending on every current and future writer remembering
 *   it: the credit nets the original debit for the project even though the
 *   reversal row itself carries no `project_id`.
 *
 * ## What this is not
 *
 * Budget − cost is a **budget variance**, not profit. Revenue recognition
 * (when a project sale becomes revenue, and what is capitalized before it does)
 * is an Accounting decision this module does not make; see the "remaining
 * issues" note in `docs/phases/Phase-G-My-Workspace.md`.
 */

/** The placeholders the cost subquery refers to. Both must already be bound. */
export interface ProjectCostSqlInput {
  /** The bound parameter (or column) holding the business id. */
  business: string;
  /** The bound parameter (or column) holding the project id. */
  project: string;
}

/**
 * A correlated subquery yielding the project's net cost in Rial, as a bigint.
 *
 * Correlated on the project, so it is valid inside a `SELECT` over
 * `ai_projects p` (`project: "p.id"`) and also with plain parameters
 * (`business: "$1"`, `project: "$2"`). Placeholders are never interpolated from
 * user input: they are a bound parameter or a column reference the caller's own
 * query controls.
 */
export function projectCostSubquerySql(input: ProjectCostSqlInput): string {
  const { business, project } = input;
  return `COALESCE((
    SELECT sum(jl.debit - jl.credit)
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      JOIN accounts a ON a.id = jl.account_id
     WHERE je.business_id = ${business}
       AND a.business_id = ${business}
       AND a.type = 'expense'
       AND (
         je.project_id = ${project}
         OR (
           je.project_id IS NULL
           AND je.reverses_entry_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM journal_entries original
              WHERE original.id = je.reverses_entry_id
                AND original.project_id = ${project}
           )
         )
       )
  ), 0)`;
}

/**
 * The project's **revenue** on the same attribution rules — net credit on
 * revenue accounts. Exported because the cockpit shows both sides of a project
 * and it must not invent a second attribution rule; nothing user-facing calls it
 * as "profit" until Accounting defines recognition.
 */
export function projectRevenueSubquerySql(input: ProjectCostSqlInput): string {
  const { business, project } = input;
  return `COALESCE((
    SELECT sum(jl.credit - jl.debit)
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      JOIN accounts a ON a.id = jl.account_id
     WHERE je.business_id = ${business}
       AND a.business_id = ${business}
       AND a.type = 'revenue'
       AND (
         je.project_id = ${project}
         OR (
           je.project_id IS NULL
           AND je.reverses_entry_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM journal_entries original
              WHERE original.id = je.reverses_entry_id
                AND original.project_id = ${project}
           )
         )
       )
  ), 0)`;
}
