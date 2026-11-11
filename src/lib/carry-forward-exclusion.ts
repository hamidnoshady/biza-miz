/**
 * The carry-forward exclusion — one predicate, used by every balance read.
 *
 * The ledger model (docs/architecture/ledger-model.md) is *continuous*: a
 * fiscal-year carry-forward posts an ordinary, numbered, reversible journal
 * entry at the new year's first day, but that entry is a **documentary
 * snapshot** of balances the ledger already carries in its history. Counting
 * it again would double every permanent balance the moment a year turns
 * (GH #1334 / ESH-165).
 *
 * `is_carry_forward_snapshot()` (migration 0297) recognises exactly that
 * entry: `source_type = 'opening'` **and** its `source_id` naming a set whose
 * `source` is `carry_forward`. Everything else stays counted — a manual
 * initial-opening set (`source = 'manual'`) and the setup wizard's own
 * opening entry (`source_id` naming no set at all) are real ledger history
 * and must never be swept up by a blanket `source_type` filter.
 *
 * The fragment is `STABLE` SQL over a primary-key probe, ordered cheap-first
 * (CASE) so ordinary rows never touch `opening_balance_sets`. Rows the
 * predicate cannot decide (a NULL entry reference) evaluate to "not a
 * snapshot" — a balance read fails open to the pre-fix behaviour rather than
 * silently dropping history.
 *
 * Scope: **balance reads** — trial balance, statements, subledgers, cash
 * flow, dashboards, dimension reports, the reporting view, and the
 * carry-forward derivation itself. Document-scoped reads deliberately do NOT
 * use it: the journal list and detail, whole-ledger integrity totals, voucher
 * numbering, bank-reconciliation candidates and closing-entry lookups keep the
 * snapshot visible, because a document is a document. See the model doc for
 * the full boundary.
 */
export function notCarryForwardSnapshotSql(alias = "je"): string {
  return `NOT is_carry_forward_snapshot(${alias})`;
}
