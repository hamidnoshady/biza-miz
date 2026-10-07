/**
 * The DB half of an online order's chronology and document breakdown
 * (dashboard audit F06). The rules are pure, in `online-sale-policy.ts`.
 *
 * Both website adapters (WooCommerce, Eshobe CMS) call this the same way the
 * Holoo importer dates history (`holoo/imported-sale-service.ts`): the order's
 * `opened_at`/`closed_at`, the payment's `received_at` and the journal's
 * `entry_date` are the instant the sale *happened*, bucketed into the branch's
 * business day through `businessDateOf`. Importing last spring therefore lands
 * last spring — not in today's shift — and a closed fiscal month refuses the
 * import (migration 0024's lock) instead of quietly absorbing it.
 *
 * The import instant is kept separately on `online_order_documents`, together
 * with the remote created/paid/completed instants and the component breakdown,
 * so nothing about the remote document is lost or overwritten.
 */
import type { PoolClient } from "pg";
import { businessDateOf } from "./business-day";
import {
  chooseOnlineOccurredAt,
  reconcileOnlineDocument,
  type OccurredAtSource,
  type OnlineDocumentBreakdown,
} from "./online-sale-policy";
import type { OnlineSaleSourceType } from "./retail-online-sale-service";

export interface OnlineChronology {
  /** The instant the sale belongs to. */
  occurredAt: string;
  occurredAtSource: OccurredAtSource;
  /** When the remote order was placed (≤ occurredAt), else occurredAt. */
  openedAt: string;
  /** The business date the journal is filed under. */
  entryDate: string;
  importedAt: string;
  remoteCreatedAt: string | null;
  remotePaidAt: string | null;
  remoteCompletedAt: string | null;
}

export async function resolveOnlineChronology(
  client: PoolClient,
  locationId: string,
  remote: { createdAt: string | null; paidAt: string | null; completedAt: string | null },
  importedAt: Date = new Date(),
): Promise<OnlineChronology> {
  const importedIso = importedAt.toISOString();
  const { occurredAt, source } = chooseOnlineOccurredAt({ ...remote, importedAt: importedIso });
  const { rows } = await client.query<{ timezone: string; business_day_start_minutes: number | null }>(
    `SELECT timezone, business_day_start_minutes FROM locations WHERE id = $1`,
    [locationId],
  );
  if (!rows[0]) throw new Error("no_location");
  const created = remote.createdAt && Date.parse(remote.createdAt) <= Date.parse(occurredAt) ? remote.createdAt : null;
  return {
    occurredAt,
    occurredAtSource: source,
    openedAt: created ? new Date(created).toISOString() : occurredAt,
    entryDate: businessDateOf(new Date(occurredAt), rows[0].timezone, rows[0].business_day_start_minutes),
    importedAt: importedIso,
    remoteCreatedAt: remote.createdAt,
    remotePaidAt: remote.paidAt,
    remoteCompletedAt: remote.completedAt,
  };
}

export async function recordOnlineOrderDocument(
  client: PoolClient,
  input: {
    orderId: string;
    locationId: string;
    sourceType: OnlineSaleSourceType;
    remoteId: string;
    remoteNumber: string | null;
    currency: string | null;
    chronology: OnlineChronology;
    components: Parameters<typeof reconcileOnlineDocument>[0];
  },
): Promise<OnlineDocumentBreakdown> {
  const breakdown = reconcileOnlineDocument(input.components);
  const c = input.chronology;
  await client.query(
    `INSERT INTO online_order_documents
       (order_id, location_id, source_type, remote_id, remote_number,
        remote_created_at, remote_paid_at, remote_completed_at,
        occurred_at, occurred_at_source, imported_at, currency,
        lines_subtotal_rial, discount_rial, shipping_rial, fees_rial, tax_rial, total_rial,
        unexplained_difference_rial, breakdown_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (order_id) DO NOTHING`,
    [
      input.orderId, input.locationId, input.sourceType, input.remoteId, input.remoteNumber,
      c.remoteCreatedAt, c.remotePaidAt, c.remoteCompletedAt,
      c.occurredAt, c.occurredAtSource, c.importedAt, input.currency,
      breakdown.linesSubtotalRial.toString(), breakdown.discountRial.toString(), breakdown.shippingRial.toString(),
      breakdown.feesRial.toString(), breakdown.taxRial.toString(), breakdown.totalRial.toString(),
      breakdown.unexplainedDifferenceRial.toString(), breakdown.status,
    ],
  );
  return breakdown;
}
