/** Retention is indefinite. Archival appends a reproducible checkpoint; it never purges. */
import { query, withTenant, withTenantTransaction } from "./db";
import { canonicalJson, hashPayload, verifyPayloadHash } from "./tax-invoice-core";
import { TaxServiceError, type TaxActor } from "./tax-invoice-service";

export async function getTaxArchivePolicy(businessId: string): Promise<{ archiveAfterDays: number; retention: "indefinite"; archivedCount: number }> {
  return withTenant(businessId, async () => {
    const { rows } = await query<{ days: number; count: number }>(`SELECT
      COALESCE((SELECT archive_after_days FROM tax_invoice_profiles WHERE business_id = $1), 365) AS days,
      (SELECT count(*)::int FROM tax_invoice_archives WHERE business_id = $1) AS count`, [businessId]);
    return { archiveAfterDays: rows[0].days, retention: "indefinite", archivedCount: rows[0].count };
  });
}

export async function saveTaxArchivePolicy(actor: TaxActor, days: unknown): Promise<void> {
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 36500) {
    throw new TaxServiceError("invalid_archive_days", 400, "مهلت بایگانی باید بین ۱ و ۳۶٬۵۰۰ روز باشد.");
  }
  await withTenantTransaction(actor.businessId, async () => {
    await query("SELECT id FROM businesses WHERE id = $1 FOR KEY SHARE", [actor.businessId]);
    await query(`INSERT INTO tax_invoice_profiles (business_id, archive_after_days) VALUES ($1, $2)
      ON CONFLICT (business_id) DO UPDATE SET archive_after_days = EXCLUDED.archive_after_days`, [actor.businessId, days]);
    await query(`INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
      VALUES ($1::uuid, $2::uuid, 'tax_invoice.archive_policy', 'tax_invoice_profile', $3::text, $4::jsonb)`,
    [actor.businessId, actor.userId, actor.businessId, JSON.stringify({ archiveAfterDays: days, retention: "indefinite" })]);
  });
}

/** Each archived JSON includes the immutable payload and the event history at the checkpoint. */
export async function archiveTaxInvoices(businessId: string, now = new Date(), limit = 100): Promise<number> {
  return withTenantTransaction(businessId, async () => {
    await query("SELECT id FROM businesses WHERE id = $1 FOR KEY SHARE", [businessId]);
    const { rows } = await query<Record<string, unknown>>(`SELECT s.* FROM tax_invoice_submissions s
      JOIN tax_invoice_profiles p ON p.business_id = s.business_id
      WHERE s.business_id = $1 AND s.status IN ('accepted', 'rejected', 'cancelled')
        AND COALESCE(s.accepted_at, s.submitted_at) <= $2::timestamptz - p.archive_after_days * interval '1 day'
        AND NOT EXISTS (SELECT 1 FROM tax_invoice_archives a WHERE a.submission_id = s.id)
      ORDER BY s.prepared_at, s.id LIMIT $3 FOR UPDATE OF s SKIP LOCKED`, [businessId, now, Math.min(Math.max(limit, 1), 500)]);
    let count = 0;
    for (const row of rows) {
      if (!verifyPayloadHash(row.payload_snapshot, row.payload_hash as string)) throw new Error("tax_archive_payload_corrupt");
      const events = await query(`SELECT id, event_type, from_status, to_status, correlation_id, detail, callback_event_id, callback_hash,
          created_at::text FROM tax_invoice_events WHERE submission_id = $1 ORDER BY created_at, id`, [row.id]);
      const snapshot = JSON.parse(JSON.stringify({ version: "tax-archive/v1", record: row, events: events.rows }));
      const inserted = await query(`INSERT INTO tax_invoice_archives (business_id, submission_id, snapshot, sha256)
        VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (submission_id) DO NOTHING RETURNING id`,
      [businessId, row.id, canonicalJson(snapshot), hashPayload(snapshot)]);
      count += inserted.rowCount ?? 0;
      if (inserted.rowCount) await query(`INSERT INTO tax_invoice_events
        (business_id, submission_id, event_type, correlation_id, detail) VALUES ($1, $2, 'archived', $3, $4::jsonb)`,
      [businessId, row.id, row.correlation_id, JSON.stringify({ sha256: hashPayload(snapshot) })]);
    }
    return count;
  });
}

export async function readTaxArchive(businessId: string, submissionId: string): Promise<unknown | null> {
  return withTenant(businessId, async () => {
    const { rows } = await query<{ snapshot: unknown; sha256: string }>(
      `SELECT snapshot, sha256 FROM tax_invoice_archives WHERE business_id = $1 AND submission_id = $2`, [businessId, submissionId]);
    const row = rows[0];
    if (!row) return null;
    if (hashPayload(row.snapshot) !== row.sha256) throw new Error("tax_archive_corrupt");
    return row;
  });
}
