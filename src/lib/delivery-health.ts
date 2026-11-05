/**
 * Issue #902 §6 — one verdict for a set of sends, in one place.
 *
 * This lived inside `messaging-delivery-report.ts`, which owns a database query;
 * the Superadmin card and the per-campaign report both need the same rule, and
 * the card is a client component, so it kept a hand-copy of the thresholds with a
 * comment saying "mirrors the server". A copy of a rule is exactly how two
 * answers start — the third caller would have made a third copy. It lives here
 * now: pure, importable from either side, and every caller uses the same one.
 *
 * The thresholds are deliberately coarse (this is triage, not an SLA), and
 * `idle` is distinct from `healthy`: no attempts means no evidence, and a report
 * that calls silence "healthy" trains the operator to ignore it.
 */
export type DeliveryHealth = "healthy" | "degraded" | "attention" | "idle";

export function deliveryHealth(row: {
  sent: number;
  delivered: number;
  failed: number;
  pending: number;
}): DeliveryHealth {
  const decided = row.sent + row.delivered + row.failed;
  if (decided === 0) return row.pending > 0 ? "degraded" : "idle";
  if (row.failed > 0 && row.failed / decided >= 0.1) return "attention";
  if (row.failed > 0 || row.pending > 0) return "degraded";
  return "healthy";
}
