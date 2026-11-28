/**
 * GH #1567 Phase 6A — tailoring / alterations service.
 *
 * Reuse, not parallel systems: the customer is a CRM `parties` row, the sale
 * is an ordinary `orders` row linked to the job, and measurement values are
 * encrypted with the business DEK (`field-crypto`, AES-256-GCM) before they
 * reach Postgres. Without a key, measurements are refused — never stored in
 * plaintext.
 *
 * Every measurement access (record, view, export, erase, purge) is written to
 * an append-only log in the same transaction. A job never carries measurement
 * values; it references a profile version.
 *
 * Not reachable from AI: no AI tool, AI action or MCP verb maps to any of
 * these functions (asserted in tailoring-workflow.test.ts and the coverage map).
 */
import type { PoolClient } from "pg";
import { withTenantTransaction } from "./db";
import { getBusinessDek } from "./business-keys";
import { decryptField, encryptField } from "./field-crypto";
import {
  parseTailoringMeasurements,
  planTailoringTransition,
  retentionCutoff,
  type TailoringKind,
  type TailoringMeasurements,
  type TailoringStatus,
  type TailoringTransitionInput,
} from "./tailoring-workflow";

export class TailoringError extends Error {
  constructor(public readonly code: string, public readonly status = 409) {
    super(code);
    this.name = "TailoringError";
  }
}

export interface TailoringActor {
  businessId: string;
  userId: string | null;
  name: string;
}

async function requireDek(businessId: string): Promise<Buffer> {
  const dek = await getBusinessDek(businessId);
  if (!dek) throw new TailoringError("tailoring_encryption_unavailable", 503);
  return dek;
}

async function requireParty(client: PoolClient, businessId: string, partyId: string) {
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM parties WHERE id = $1 AND business_id = $2", [partyId, businessId]);
  if (!rows[0]) throw new TailoringError("tailoring_party_not_found", 404);
}

async function logAccess(client: PoolClient, actor: TailoringActor, partyId: string, profileId: string | null,
  action: "record" | "view" | "export" | "erase" | "purge", purpose: string | null) {
  await client.query(
    `INSERT INTO tailoring_measurement_access_log (business_id, party_id, profile_id, actor_user_id, actor_name, action, purpose)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actor.businessId, partyId, profileId, actor.userId, actor.name.slice(0, 200) || "—", action, purpose],
  );
}

// ---------------------------------------------------------------------------
// Measurements

export interface MeasurementVersionMeta {
  id: string;
  version: number;
  unit: "cm" | "in";
  fieldCount: number;
  recordedAt: string;
  supersededAt: string | null;
  erasedAt: string | null;
}

const META_COLUMNS = `id, version, unit, field_count AS "fieldCount", recorded_at AS "recordedAt",
  superseded_at AS "supersededAt", erased_at AS "erasedAt"`;

/** Record a new version; the previous current version is superseded, not overwritten. */
export async function recordMeasurements(actor: TailoringActor, partyId: string, raw: unknown) {
  const parsed = parseTailoringMeasurements(raw);
  if (!parsed.ok) throw new TailoringError(parsed.error, 400);
  const dek = await requireDek(actor.businessId);
  return withTenantTransaction(actor.businessId, async client => {
    await requireParty(client, actor.businessId, partyId);
    // Serialise versions per customer.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tailoring_measurements:' || $1))", [partyId]);
    const { rows: [last] } = await client.query<{ version: number | null }>(
      "SELECT max(version) AS version FROM tailoring_measurement_profiles WHERE business_id = $1 AND party_id = $2",
      [actor.businessId, partyId]);
    await client.query(
      `UPDATE tailoring_measurement_profiles SET superseded_at = now()
        WHERE business_id = $1 AND party_id = $2 AND superseded_at IS NULL`, [actor.businessId, partyId]);
    const ciphertext = encryptField(JSON.stringify(parsed.value), dek);
    const { rows: [created] } = await client.query<MeasurementVersionMeta>(
      `INSERT INTO tailoring_measurement_profiles (business_id, party_id, version, unit, field_count, measurements_enc, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${META_COLUMNS}`,
      [actor.businessId, partyId, (last?.version ?? 0) + 1, parsed.value.unit,
        Object.keys(parsed.value.values).length, ciphertext, actor.userId]);
    await logAccess(client, actor, partyId, created.id, "record", null);
    return created;
  });
}

function decrypt(value: Buffer | null, dek: Buffer): TailoringMeasurements | null {
  return value ? JSON.parse(decryptField(Buffer.isBuffer(value) ? value : Buffer.from(value), dek)) as TailoringMeasurements : null;
}

/**
 * Open the current measurements for a stated purpose. The version history is
 * listed as metadata only; older values are not shown here (export is the
 * data-subject path that returns all of them, and is logged as such).
 */
export async function viewMeasurements(actor: TailoringActor, partyId: string, purpose: string) {
  const dek = await requireDek(actor.businessId);
  return withTenantTransaction(actor.businessId, async client => {
    await requireParty(client, actor.businessId, partyId);
    const { rows } = await client.query<MeasurementVersionMeta & { enc: Buffer | null }>(
      `SELECT ${META_COLUMNS}, measurements_enc AS enc FROM tailoring_measurement_profiles
        WHERE business_id = $1 AND party_id = $2 ORDER BY version DESC`, [actor.businessId, partyId]);
    const current = rows.find(row => !row.supersededAt && !row.erasedAt) ?? null;
    await logAccess(client, actor, partyId, current?.id ?? null, "view", purpose);
    return {
      current: current ? { ...strip(current), measurements: decrypt(current.enc, dek) } : null,
      versions: rows.map(strip),
    };
  });
}

function strip<T extends { enc?: unknown }>(row: T): Omit<T, "enc"> {
  const { enc: _enc, ...rest } = row;
  void _enc;
  return rest;
}

/** Data-subject export: every version that still has values, decrypted. */
export async function exportMeasurements(actor: TailoringActor, partyId: string) {
  const dek = await requireDek(actor.businessId);
  return withTenantTransaction(actor.businessId, async client => {
    await requireParty(client, actor.businessId, partyId);
    const { rows } = await client.query<MeasurementVersionMeta & { enc: Buffer | null }>(
      `SELECT ${META_COLUMNS}, measurements_enc AS enc FROM tailoring_measurement_profiles
        WHERE business_id = $1 AND party_id = $2 ORDER BY version`, [actor.businessId, partyId]);
    await logAccess(client, actor, partyId, null, "export", "data_subject_export");
    return {
      partyId,
      exportedAt: new Date().toISOString(),
      versions: rows.map(row => ({ ...strip(row), measurements: decrypt(row.enc, dek) })),
    };
  });
}

/** Erase every version's values for a customer. Rows (version, dates) and the access log remain. */
export async function eraseMeasurements(actor: TailoringActor, partyId: string, reason: string) {
  const text = reason.trim();
  if (text.length < 3 || text.length > 500) throw new TailoringError("tailoring_reason_required", 400);
  return withTenantTransaction(actor.businessId, async client => {
    await requireParty(client, actor.businessId, partyId);
    const { rowCount } = await client.query(
      `UPDATE tailoring_measurement_profiles
          SET measurements_enc = NULL, erased_at = now(), erased_reason = $3, superseded_at = COALESCE(superseded_at, now())
        WHERE business_id = $1 AND party_id = $2 AND erased_at IS NULL`, [actor.businessId, partyId, text]);
    await logAccess(client, actor, partyId, null, "erase", text.slice(0, 300));
    return { erased: rowCount ?? 0 };
  });
}

export async function measurementAccessLog(actor: TailoringActor, partyId: string) {
  return withTenantTransaction(actor.businessId, async client => {
    await requireParty(client, actor.businessId, partyId);
    const { rows } = await client.query(
      `SELECT id::text, profile_id AS "profileId", actor_user_id AS "actorUserId", actor_name AS "actorName",
              action, purpose, at FROM tailoring_measurement_access_log
        WHERE business_id = $1 AND party_id = $2 ORDER BY id DESC LIMIT 500`, [actor.businessId, partyId]);
    return rows;
  });
}

// ---------------------------------------------------------------------------
// Retention

export async function getRetentionDays(businessId: string): Promise<number> {
  return withTenantTransaction(businessId, async client => {
    const { rows } = await client.query<{ days: number }>(
      "SELECT measurement_retention_days AS days FROM tailoring_settings WHERE business_id = $1", [businessId]);
    return rows[0]?.days ?? 730;
  });
}

export async function setRetentionDays(actor: TailoringActor, days: number) {
  if (!Number.isInteger(days) || days < 30 || days > 3650) throw new TailoringError("tailoring_retention_invalid", 400);
  return withTenantTransaction(actor.businessId, async client => {
    await client.query(
      `INSERT INTO tailoring_settings (business_id, measurement_retention_days, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (business_id) DO UPDATE SET measurement_retention_days = EXCLUDED.measurement_retention_days,
         updated_by = EXCLUDED.updated_by, updated_at = now()`, [actor.businessId, days, actor.userId]);
    return { days };
  });
}

/**
 * Retention purge. Erases (a) superseded versions recorded before the cutoff
 * and (b) every version of a customer with no measurement or tailoring-job
 * activity since the cutoff and no open job. Dry-run unless `apply`.
 */
export async function purgeExpiredMeasurements(actor: TailoringActor, options: { apply: boolean; today?: Date }) {
  const days = await getRetentionDays(actor.businessId);
  const cutoff = retentionCutoff(options.today ?? new Date(), days);
  return withTenantTransaction(actor.businessId, async client => {
    const { rows } = await client.query<{ id: string; party_id: string }>(
      `SELECT p.id, p.party_id FROM tailoring_measurement_profiles p
        WHERE p.business_id = $1 AND p.erased_at IS NULL AND (
          (p.superseded_at IS NOT NULL AND p.recorded_at < $2)
          OR (
            NOT EXISTS (SELECT 1 FROM tailoring_measurement_profiles q
                         WHERE q.business_id = p.business_id AND q.party_id = p.party_id AND q.recorded_at >= $2)
            AND NOT EXISTS (SELECT 1 FROM tailoring_jobs j
                             WHERE j.business_id = p.business_id AND j.party_id = p.party_id
                               AND (j.updated_at >= $2 OR j.status NOT IN ('picked_up', 'cancelled')))
          ))
        ORDER BY p.party_id, p.version`, [actor.businessId, cutoff]);
    if (options.apply && rows.length > 0) {
      await client.query(
        `UPDATE tailoring_measurement_profiles
            SET measurements_enc = NULL, erased_at = now(), erased_reason = 'retention', superseded_at = COALESCE(superseded_at, now())
          WHERE business_id = $1 AND id = ANY($2::uuid[])`, [actor.businessId, rows.map(row => row.id)]);
      for (const row of rows) await logAccess(client, actor, row.party_id, row.id, "purge", `retention ${days}d`);
    }
    return { retentionDays: days, cutoff: cutoff.toISOString(), versions: rows.length,
      customers: new Set(rows.map(row => row.party_id)).size, applied: options.apply };
  });
}

// ---------------------------------------------------------------------------
// Jobs

export interface TailoringJob {
  id: string;
  locationId: string;
  partyId: string;
  partyName: string | null;
  measurementProfileId: string | null;
  kind: TailoringKind;
  description: string;
  status: TailoringStatus;
  estimateRial: string | null;
  approvedAt: string | null;
  dueDate: string | null;
  orderId: string | null;
  fittingCount: number;
  reworkCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const JOB_COLUMNS = `j.id, j.location_id AS "locationId", j.party_id AS "partyId", pa.name AS "partyName",
  j.measurement_profile_id AS "measurementProfileId", j.kind, j.description, j.status,
  j.estimate_rial::text AS "estimateRial", j.approved_at AS "approvedAt", j.due_date::text AS "dueDate",
  j.order_id AS "orderId", j.fitting_count AS "fittingCount", j.rework_count AS "reworkCount", j.version,
  j.created_at AS "createdAt", j.updated_at AS "updatedAt"`;

export async function createTailoringJob(actor: TailoringActor, input: {
  locationId: string; partyId: string; kind: TailoringKind; description: string; dueDate?: string | null;
  measurementProfileId?: string | null;
}): Promise<TailoringJob> {
  const description = input.description.trim();
  if (!description || description.length > 1000) throw new TailoringError("tailoring_description_required", 400);
  if (input.kind !== "alteration" && input.kind !== "made_to_measure") throw new TailoringError("tailoring_kind_invalid", 400);
  return withTenantTransaction(actor.businessId, async client => {
    await requireParty(client, actor.businessId, input.partyId);
    const { rows: [location] } = await client.query(
      "SELECT 1 FROM locations WHERE id = $1 AND business_id = $2", [input.locationId, actor.businessId]);
    if (!location) throw new TailoringError("tailoring_location_not_found", 404);
    if (input.measurementProfileId) {
      const { rows: [profile] } = await client.query(
        `SELECT 1 FROM tailoring_measurement_profiles WHERE id = $1 AND business_id = $2 AND party_id = $3 AND erased_at IS NULL`,
        [input.measurementProfileId, actor.businessId, input.partyId]);
      if (!profile) throw new TailoringError("tailoring_profile_not_found", 404);
    }
    const { rows: [job] } = await client.query<{ id: string }>(
      `INSERT INTO tailoring_jobs (business_id, location_id, party_id, measurement_profile_id, kind, description, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [actor.businessId, input.locationId, input.partyId, input.measurementProfileId ?? null, input.kind, description,
        input.dueDate ?? null, actor.userId]);
    await client.query(
      `INSERT INTO tailoring_job_events (business_id, job_id, from_status, to_status, actor_user_id, actor_name)
       VALUES ($1, $2, NULL, 'intake', $3, $4)`, [actor.businessId, job.id, actor.userId, actor.name.slice(0, 200) || "—"]);
    return (await loadJob(client, actor.businessId, job.id))!;
  });
}

async function loadJob(client: PoolClient, businessId: string, id: string, lock = false): Promise<TailoringJob | null> {
  const { rows } = await client.query<TailoringJob>(
    `SELECT ${JOB_COLUMNS} FROM tailoring_jobs j LEFT JOIN parties pa ON pa.id = j.party_id
      WHERE j.id = $1 AND j.business_id = $2 ${lock ? "FOR UPDATE OF j" : ""}`, [id, businessId]);
  return rows[0] ?? null;
}

export async function getTailoringJob(actor: TailoringActor, id: string) {
  return withTenantTransaction(actor.businessId, async client => {
    const job = await loadJob(client, actor.businessId, id);
    if (!job) throw new TailoringError("tailoring_job_not_found", 404);
    const { rows: events } = await client.query(
      `SELECT id::text, from_status AS "fromStatus", to_status AS "toStatus", actor_name AS "actorName", note, at
         FROM tailoring_job_events WHERE job_id = $1 AND business_id = $2 ORDER BY id`, [id, actor.businessId]);
    return { job, events };
  });
}

export async function listTailoringJobs(actor: TailoringActor, locationId: string, status?: TailoringStatus) {
  return withTenantTransaction(actor.businessId, async client => {
    const { rows } = await client.query<TailoringJob>(
      `SELECT ${JOB_COLUMNS} FROM tailoring_jobs j LEFT JOIN parties pa ON pa.id = j.party_id
        WHERE j.business_id = $1 AND j.location_id = $2 AND ($3::text IS NULL OR j.status = $3)
        ORDER BY j.created_at DESC LIMIT 500`, [actor.businessId, locationId, status ?? null]);
    return rows;
  });
}

/** One workflow step under an optimistic lock (`expectedVersion`). */
export async function transitionTailoringJob(actor: TailoringActor, id: string,
  input: TailoringTransitionInput & { expectedVersion: number }) {
  return withTenantTransaction(actor.businessId, async client => {
    const job = await loadJob(client, actor.businessId, id, true);
    if (!job) throw new TailoringError("tailoring_job_not_found", 404);
    if (job.version !== input.expectedVersion) throw new TailoringError("tailoring_job_changed");
    const decision = planTailoringTransition({
      status: job.status, kind: job.kind, estimateRial: job.estimateRial === null ? null : BigInt(job.estimateRial), orderId: job.orderId,
    }, input);
    if (!decision.ok) throw new TailoringError(decision.error);
    const { plan } = decision;
    await client.query(
      `UPDATE tailoring_jobs SET status = $3, estimate_rial = $4,
              approved_at = CASE WHEN $5 THEN now() ELSE approved_at END,
              approved_by = CASE WHEN $5 THEN $6::uuid ELSE approved_by END,
              fitting_count = fitting_count + CASE WHEN $7 THEN 1 ELSE 0 END,
              rework_count = rework_count + CASE WHEN $8 THEN 1 ELSE 0 END,
              version = version + 1, updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [id, actor.businessId, plan.to, plan.estimateRial === null ? null : plan.estimateRial.toString(), plan.approve,
        actor.userId, plan.fitting, plan.rework]);
    const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;
    await client.query(
      `INSERT INTO tailoring_job_events (business_id, job_id, from_status, to_status, actor_user_id, actor_name, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [actor.businessId, id, job.status, plan.to, actor.userId, actor.name.slice(0, 200) || "—", note]);
    return (await loadJob(client, actor.businessId, id))!;
  });
}

/**
 * Link the sale. The order must be in the job's branch, not voided, for the
 * same customer (when the order names one), and not linked to another job.
 * Money, VAT and the ledger stay on the ordinary order path.
 */
export async function linkTailoringJobOrder(actor: TailoringActor, id: string, orderId: string) {
  return withTenantTransaction(actor.businessId, async client => {
    const job = await loadJob(client, actor.businessId, id, true);
    if (!job) throw new TailoringError("tailoring_job_not_found", 404);
    if (job.status === "picked_up" || job.status === "cancelled") throw new TailoringError("tailoring_transition_invalid");
    const { rows: [order] } = await client.query<{ location_id: string; customer_id: string | null; status: string }>(
      `SELECT o.location_id, o.customer_id, o.status::text AS status FROM orders o
         JOIN locations l ON l.id = o.location_id WHERE o.id = $1 AND l.business_id = $2`, [orderId, actor.businessId]);
    if (!order) throw new TailoringError("tailoring_order_not_found", 404);
    if (order.location_id !== job.locationId || order.status === "voided" ||
        (order.customer_id && order.customer_id !== job.partyId)) throw new TailoringError("tailoring_order_mismatch");
    const { rows: [other] } = await client.query(
      "SELECT 1 FROM tailoring_jobs WHERE order_id = $1 AND id <> $2", [orderId, id]);
    if (other) throw new TailoringError("tailoring_order_mismatch");
    await client.query(
      "UPDATE tailoring_jobs SET order_id = $3, version = version + 1, updated_at = now() WHERE id = $1 AND business_id = $2",
      [id, actor.businessId, orderId]);
    return (await loadJob(client, actor.businessId, id))!;
  });
}
