/**
 * Universal safe import (issue #1118) — the tenant-scoped service.
 *
 * Every function here runs inside `withTenantTransaction`, so the staged
 * tables obey RLS like any other tenant data, and a failure rolls the whole
 * step back. The shape of a reconciliation, in the order a source walks it:
 *
 *   openRun            claim the scope (one active run per business/domain/source/branch)
 *   stage*             resolve a bounded batch and write ONLY the staging tables
 *   completeDiscovery  gate: fast path (empty domain / all verified) or staged review
 *   decideItem /       an owner links, creates separately, skips, picks field
 *   approveSafeBatch   authority or keeps it for review — each an append-only decision
 *   revalidateRun      is the preview still true? (source, policy, canonical state)
 *   applyRun           resumable, bounded batches; per-item transaction + audit
 *   crossCheckRun      post-apply: do counts and identities add up?
 *
 * A preview (everything up to and including `completeDiscovery`) never touches
 * a canonical row. Domain writes happen only in an `ApplyHandler`, which is the
 * module that owns the table — this service decides *whether*, never *how*.
 */

import type { PoolClient } from "pg";
import { withTenantTransaction } from "../db";
import { upsertMappingOnClient } from "../integrations/mapping-service";
import { DEFAULT_FIELD_AUTHORITY_POLICY, isProtectedClass, fieldClassFor, type FieldAuthorityOverrides, type FieldAuthorityPolicy } from "./field-authority";
import {
  canTransitionRun,
  countOutcomes,
  effectForDecision,
  evaluateFirstRunGate,
  isPreviewStale,
  progressStage,
  summarizeItems,
  type GateDecision,
  type PreviewFingerprint,
  type Progress,
  type ReconciliationCounts,
  type StaleCheck,
} from "./lifecycle";
import { identityKeysOf, planProducts, type PlannedItem } from "./plan";
import { normalizeBarcodeKey, normalizeNameKey, normalizeSkuKey } from "./normalize";
import type { CanonicalProduct, ProductContext } from "./resolvers";
import {
  RECONCILIATION_DECISIONS,
  RECONCILIATION_DOMAINS,
  RECONCILIATION_IMPORT_MODES,
  RECONCILIATION_SOURCE_KINDS,
  type IncomingProduct,
  type ReconciliationDecision,
  type ReconciliationDomain,
  type ReconciliationEffect,
  type ReconciliationImportMode,
  type ReconciliationItemStatus,
  type ReconciliationOutcome,
  type ReconciliationRunStatus,
  type ReconciliationSourceKind,
  type Resolution,
} from "./types";

export class ReconciliationError extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "ReconciliationError";
  }
}

export interface Actor {
  userId: string | null;
  name: string;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface ReconciliationRun {
  id: string;
  businessId: string;
  locationId: string | null;
  domain: ReconciliationDomain;
  sourceKind: ReconciliationSourceKind;
  provider: string;
  sourceKey: string;
  connectionId: string | null;
  importMode: ReconciliationImportMode;
  status: ReconciliationRunStatus;
  sourceFingerprint: string;
  profileKey: string | null;
  profileVersion: number | null;
  policyVersion: number;
  canonicalToken: string | null;
  scope: Record<string, unknown>;
  cursor: Record<string, unknown>;
  evidence: Record<string, unknown>;
  crossChecked: boolean;
  createdByName: string;
  createdAt: string;
  stagedAt: string | null;
  appliedAt: string | null;
}

export interface StagedItem {
  id: number;
  runId: string;
  externalType: string;
  externalKey: string;
  rowNumber: number | null;
  snapshot: unknown;
  outcome: ReconciliationOutcome;
  reasons: string[];
  canonicalId: string | null;
  candidates: Array<{ id: string; label: string }>;
  evidence: Array<{ kind: string; value: string; weak: boolean }>;
  conflicts: unknown[];
  notes: string[];
  historical: boolean;
  status: ReconciliationItemStatus;
  effect: ReconciliationEffect | null;
  resolvedCanonicalId: string | null;
  error: string | null;
  attempts: number;
}

type Row = Record<string, unknown>;

function mapRun(r: Row): ReconciliationRun {
  const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
  return {
    id: String(r.id),
    businessId: String(r.business_id),
    locationId: r.location_id == null ? null : String(r.location_id),
    domain: r.domain as ReconciliationDomain,
    sourceKind: r.source_kind as ReconciliationSourceKind,
    provider: String(r.provider ?? ""),
    sourceKey: String(r.source_key),
    connectionId: r.connection_id == null ? null : String(r.connection_id),
    importMode: r.import_mode as ReconciliationImportMode,
    status: r.status as ReconciliationRunStatus,
    sourceFingerprint: String(r.source_fingerprint),
    profileKey: (r.profile_key as string | null) ?? null,
    profileVersion: (r.profile_version as number | null) ?? null,
    policyVersion: Number(r.policy_version),
    canonicalToken: (r.canonical_token as string | null) ?? null,
    scope: (r.scope as Record<string, unknown>) ?? {},
    cursor: (r.cursor as Record<string, unknown>) ?? {},
    evidence: (r.evidence as Record<string, unknown>) ?? {},
    crossChecked: Boolean(r.cross_checked),
    createdByName: String(r.created_by_name ?? ""),
    createdAt: iso(r.created_at) as string,
    stagedAt: iso(r.staged_at),
    appliedAt: iso(r.applied_at),
  };
}

function mapItem(r: Row): StagedItem {
  return {
    id: Number(r.id),
    runId: String(r.run_id),
    externalType: String(r.external_type),
    externalKey: String(r.external_key),
    rowNumber: r.row_number == null ? null : Number(r.row_number),
    snapshot: r.snapshot,
    outcome: r.outcome as ReconciliationOutcome,
    reasons: (r.reasons as string[]) ?? [],
    canonicalId: (r.canonical_id as string | null) ?? null,
    candidates: (r.candidates as StagedItem["candidates"]) ?? [],
    evidence: (r.evidence as StagedItem["evidence"]) ?? [],
    conflicts: (r.conflicts as unknown[]) ?? [],
    notes: (r.notes as string[]) ?? [],
    historical: Boolean(r.historical),
    status: r.status as ReconciliationItemStatus,
    effect: (r.effect as ReconciliationEffect | null) ?? null,
    resolvedCanonicalId: (r.resolved_canonical_id as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    attempts: Number(r.attempts ?? 0),
  };
}

async function audit(
  client: PoolClient,
  businessId: string,
  actor: Actor | null,
  action: string,
  runId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2::uuid, $3, 'import_reconciliation', $4, $5::jsonb)`,
    [businessId, actor?.userId ?? null, action, runId, JSON.stringify(payload)],
  );
}

async function loadRun(client: PoolClient, businessId: string, runId: string, lock = false): Promise<ReconciliationRun> {
  const { rows } = await client.query(
    `SELECT * FROM import_reconciliation_runs WHERE id = $1 AND business_id = $2 ${lock ? "FOR UPDATE" : ""}`,
    [runId, businessId],
  );
  if (!rows[0]) throw new ReconciliationError("run_not_found");
  return mapRun(rows[0]);
}

async function setRunStatus(
  client: PoolClient,
  run: ReconciliationRun,
  to: ReconciliationRunStatus,
  extra: { stagedAt?: boolean; appliedAt?: boolean; crossChecked?: boolean } = {},
): Promise<void> {
  if (run.status !== to && !canTransitionRun(run.status, to)) {
    throw new ReconciliationError("invalid_run_transition", { from: run.status, to });
  }
  await client.query(
    `UPDATE import_reconciliation_runs
        SET status = $3,
            staged_at = CASE WHEN $4 THEN now() ELSE staged_at END,
            applied_at = CASE WHEN $5 THEN now() ELSE applied_at END,
            cross_checked = COALESCE($6, cross_checked),
            updated_at = now()
      WHERE id = $1 AND business_id = $2`,
    [run.id, run.businessId, to, extra.stagedAt ?? false, extra.appliedAt ?? false, extra.crossChecked ?? null],
  );
  run.status = to;
}

// ---------------------------------------------------------------------------
// Open a run
// ---------------------------------------------------------------------------

export interface OpenRunInput {
  businessId: string;
  locationId?: string | null;
  domain: ReconciliationDomain;
  sourceKind: ReconciliationSourceKind;
  provider?: string;
  /** A connection id, or the operator's name for a file source. */
  sourceKey: string;
  connectionId?: string | null;
  importMode: ReconciliationImportMode;
  sourceFingerprint: string;
  profileKey?: string | null;
  profileVersion?: number | null;
  policyVersion?: number;
  scope?: Record<string, unknown>;
  /** Immutable source evidence: file name, size, hash, provider build. */
  evidence?: Record<string, unknown>;
  actor: Actor;
}

/**
 * Claim the scope. A second active run on the same business/domain/source/branch
 * is refused (`active_run_exists`) and names the run that owns it — which is how
 * a manual sync, a webhook backfill and a re-upload are kept from racing.
 */
export async function openRun(input: OpenRunInput): Promise<ReconciliationRun> {
  if (!RECONCILIATION_DOMAINS.includes(input.domain)) throw new ReconciliationError("invalid_domain");
  if (!RECONCILIATION_SOURCE_KINDS.includes(input.sourceKind)) throw new ReconciliationError("invalid_source_kind");
  if (!RECONCILIATION_IMPORT_MODES.includes(input.importMode)) throw new ReconciliationError("invalid_import_mode");
  if (!input.sourceKey.trim()) throw new ReconciliationError("source_key_required");

  return withTenantTransaction(input.businessId, async (client) => {
    const { rows: existing } = await client.query<{ id: string }>(
      `SELECT id FROM import_reconciliation_runs
        WHERE business_id = $1 AND domain = $2 AND source_key = $3
          AND COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
          AND status IN ('discovering', 'staged', 'in_review', 'applying', 'stale')
        LIMIT 1`,
      [input.businessId, input.domain, input.sourceKey, input.locationId ?? null],
    );
    if (existing[0]) throw new ReconciliationError("active_run_exists", { runId: existing[0].id });

    const { rows } = await client.query(
      `INSERT INTO import_reconciliation_runs
         (business_id, location_id, domain, source_kind, provider, source_key, connection_id,
          import_mode, source_fingerprint, profile_key, profile_version, policy_version,
          scope, evidence, created_by, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::uuid, $16)
       RETURNING *`,
      [
        input.businessId,
        input.locationId ?? null,
        input.domain,
        input.sourceKind,
        input.provider ?? "",
        input.sourceKey,
        input.connectionId ?? null,
        input.importMode,
        input.sourceFingerprint,
        input.profileKey ?? null,
        input.profileVersion ?? null,
        input.policyVersion ?? DEFAULT_FIELD_AUTHORITY_POLICY.version,
        JSON.stringify(input.scope ?? {}),
        JSON.stringify(input.evidence ?? {}),
        input.actor.userId,
        input.actor.name,
      ],
    );
    const run = mapRun(rows[0]);
    await audit(client, input.businessId, input.actor, "reconciliation.run.opened", run.id, {
      domain: run.domain,
      sourceKind: run.sourceKind,
      provider: run.provider,
      sourceKey: run.sourceKey,
      importMode: run.importMode,
    });
    return run;
  });
}

// ---------------------------------------------------------------------------
// Verified source identities
// ---------------------------------------------------------------------------

export interface LinkIdentityInput {
  businessId: string;
  domain: ReconciliationDomain;
  sourceKey: string;
  provider?: string;
  externalType: string;
  externalId: string;
  canonicalType: string;
  canonicalId: string;
  runId?: string | null;
  linkedBy?: string | null;
}

/**
 * Record "source X's record Y is canonical row Z". Idempotent for the same
 * target; a live identity pointing somewhere else is NEVER silently re-pointed
 * (`identity_already_linked`) — re-pointing is a separate, approved act.
 */
export async function linkSourceIdentity(client: PoolClient, input: LinkIdentityInput): Promise<"created" | "unchanged"> {
  const { rows } = await client.query<{ id: string; canonical_type: string; canonical_id: string }>(
    `SELECT id, canonical_type, canonical_id FROM source_identities
      WHERE business_id = $1 AND source_key = $2 AND domain = $3 AND external_type = $4
        AND external_id = $5 AND retired_at IS NULL`,
    [input.businessId, input.sourceKey, input.domain, input.externalType, input.externalId],
  );
  const live = rows[0];
  if (live) {
    if (live.canonical_type === input.canonicalType && live.canonical_id === input.canonicalId) return "unchanged";
    throw new ReconciliationError("identity_already_linked", {
      externalId: input.externalId,
      linkedTo: live.canonical_id,
    });
  }
  await client.query(
    `INSERT INTO source_identities
       (business_id, domain, source_key, provider, external_type, external_id,
        canonical_type, canonical_id, created_by_run_id, linked_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid)`,
    [
      input.businessId,
      input.domain,
      input.sourceKey,
      input.provider ?? "",
      input.externalType,
      input.externalId,
      input.canonicalType,
      input.canonicalId,
      input.runId ?? null,
      input.linkedBy ?? null,
    ],
  );
  return "created";
}

/**
 * Retire an identity with a tombstone. Never called because a feed omitted a
 * record — absence in a partial feed is not deletion — only on an explicit,
 * reasoned act.
 */
export async function retireSourceIdentity(
  businessId: string,
  identityId: string,
  reason: string,
  actor: Actor,
): Promise<void> {
  if (!reason.trim()) throw new ReconciliationError("reason_required");
  await withTenantTransaction(businessId, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE source_identities
          SET retired_at = now(), retired_reason = $3, updated_at = now()
        WHERE id = $1 AND business_id = $2 AND retired_at IS NULL`,
      [identityId, businessId, reason.trim()],
    );
    if (!rowCount) throw new ReconciliationError("identity_not_found");
    await audit(client, businessId, actor, "reconciliation.identity.retired", identityId, { reason: reason.trim() });
  });
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

export interface StageResult {
  staged: number;
  unchanged: number;
  /** Items whose record changed since an earlier batch; they returned to review. */
  changed: number;
}

function initialStatus(outcome: ReconciliationOutcome): ReconciliationItemStatus {
  switch (outcome) {
    // Nothing to write: the link already exists or the books already hold it.
    case "already_linked":
    case "historical_match":
      return "applied";
    case "skipped":
      return "skipped";
    case "invalid":
      return "held";
    default:
      return "proposed";
  }
}

/**
 * Write a planned batch to the staging tables — and nothing else. Re-sending a
 * batch is safe: an identical record is a no-op, a changed one re-resolves and
 * returns to review, and an item that already applied is left exactly as it is.
 */
export async function stagePlannedItems(
  businessId: string,
  runId: string,
  planned: readonly PlannedItem[],
): Promise<StageResult> {
  return withTenantTransaction(businessId, async (client) => {
    const run = await loadRun(client, businessId, runId, true);
    if (run.status !== "discovering") throw new ReconciliationError("run_not_discovering", { status: run.status });
    const result: StageResult = { staged: 0, unchanged: 0, changed: 0 };

    for (const item of planned) {
      if (item.domain !== run.domain) throw new ReconciliationError("domain_mismatch");
      const { outcome, reasons, canonicalId, candidates, evidence, notes, historical } = item.resolution;
      const status = initialStatus(outcome);
      const { rows } = await client.query<{ inserted: boolean; was_changed: boolean; skipped_applied: boolean }>(
        `INSERT INTO import_reconciliation_items
           (business_id, run_id, external_type, external_key, row_number, fingerprint, snapshot,
            outcome, reasons, canonical_id, candidates, evidence, conflicts, notes, historical,
            identity_keys, status, effect, resolved_canonical_id, applied_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::text[], $10, $11::jsonb, $12::jsonb,
                 $13::jsonb, $14::text[], $15, $16::text[], $17::text,
                 CASE WHEN $17::text = 'applied' THEN 'none' WHEN $17::text = 'skipped' THEN 'skip' ELSE NULL END,
                 CASE WHEN $17::text = 'applied' THEN $10::text ELSE NULL END,
                 CASE WHEN $17::text = 'applied' THEN now() ELSE NULL END)
         ON CONFLICT (run_id, external_type, external_key) DO UPDATE
            SET fingerprint = EXCLUDED.fingerprint, snapshot = EXCLUDED.snapshot,
                outcome = EXCLUDED.outcome, reasons = EXCLUDED.reasons,
                canonical_id = EXCLUDED.canonical_id, candidates = EXCLUDED.candidates,
                evidence = EXCLUDED.evidence, conflicts = EXCLUDED.conflicts, notes = EXCLUDED.notes,
                historical = EXCLUDED.historical, identity_keys = EXCLUDED.identity_keys,
                row_number = EXCLUDED.row_number,
                status = EXCLUDED.status, effect = EXCLUDED.effect,
                resolved_canonical_id = EXCLUDED.resolved_canonical_id,
                applied_at = EXCLUDED.applied_at, last_decision_id = NULL,
                error = NULL, updated_at = now()
          WHERE import_reconciliation_items.fingerprint <> EXCLUDED.fingerprint
            AND import_reconciliation_items.status <> 'applied'
         RETURNING (xmax = 0) AS inserted, (xmax <> 0) AS was_changed, false AS skipped_applied`,
        [
          businessId,
          runId,
          item.externalType,
          item.externalKey,
          item.rowNumber,
          item.fingerprint,
          JSON.stringify(item.record),
          outcome,
          reasons,
          canonicalId,
          JSON.stringify(candidates),
          JSON.stringify(evidence),
          JSON.stringify(item.conflicts),
          notes,
          historical,
          identityKeysOf(item.record),
          status,
        ],
      );
      if (rows.length === 0) result.unchanged += 1;
      else if (rows[0].inserted) result.staged += 1;
      else result.changed += 1;
    }

    await sweepCrossBatchDuplicates(client, run, planned);
    return result;
  });
}

/**
 * Duplicate keys that land in different bounded batches are invisible to a
 * per-batch resolver. After each batch, any staged item sharing an identity key
 * with another item of the run becomes `ambiguous` (`duplicate_in_source`) —
 * unless it rides a verified mapping, which a duplicate in the file cannot undo.
 */
async function sweepCrossBatchDuplicates(
  client: PoolClient,
  run: ReconciliationRun,
  planned: readonly PlannedItem[],
): Promise<void> {
  const keys = [...new Set(planned.flatMap((p) => identityKeysOf(p.record)))];
  if (keys.length === 0) return;
  await client.query(
    `UPDATE import_reconciliation_items i
        SET outcome = 'ambiguous',
            reasons = CASE WHEN 'duplicate_in_source' = ANY(i.reasons) THEN i.reasons
                           ELSE array_append(i.reasons, 'duplicate_in_source') END,
            status = 'proposed', effect = NULL, updated_at = now()
      WHERE i.run_id = $1 AND i.business_id = $2
        AND i.outcome IN ('safe_match', 'create_new')
        AND i.status IN ('proposed', 'approved')
        AND EXISTS (
          SELECT 1 FROM import_reconciliation_items o
           WHERE o.run_id = i.run_id AND o.id <> i.id
             AND o.identity_keys && i.identity_keys
             AND o.identity_keys && $3::text[]
        )`,
    [run.id, run.businessId, keys],
  );
}

// ---------------------------------------------------------------------------
// Product context (DB half of the product resolver)
// ---------------------------------------------------------------------------

type CatalogueTable = "items" | "menu_items";

async function catalogueTableFor(client: PoolClient, businessId: string): Promise<CatalogueTable> {
  const { rows } = await client.query<{ industry: string }>("SELECT industry FROM businesses WHERE id = $1", [businessId]);
  // Same split the Woo/Holoo product writers use: F&B sells `menu_items`, every
  // other trade with a sellable catalogue sells `items`.
  return rows[0]?.industry === "food_service" ? "menu_items" : "items";
}

interface CatalogueRow extends Row {
  id: string;
  location_id: string;
  name: string;
  sku: string | null;
  kind: string | null;
  unit: string | null;
  tracking: string | null;
  is_active: boolean;
  barcode: string | null;
  price: string | null;
}

function toCanonicalProduct(row: CatalogueRow, barcodes: readonly string[]): CanonicalProduct {
  const all = new Set(barcodes);
  if (row.barcode) all.add(row.barcode);
  return {
    id: row.id,
    locationId: row.location_id,
    name: row.name,
    sku: row.sku,
    barcodes: [...all],
    kind: (row.kind as CanonicalProduct["kind"] | null) ?? "simple",
    unit: row.unit,
    tracking: (row.tracking as CanonicalProduct["tracking"] | null) ?? null,
    isActive: row.is_active,
    fields: {
      name: row.name,
      sku: row.sku,
      ...(row.unit != null ? { unit: row.unit } : {}),
      ...(row.price != null ? { price: row.price } : {}),
    },
  };
}

/** Build the resolver's view of the catalogue for exactly the keys this batch mentions. */
export async function loadProductContext(
  client: PoolClient,
  run: ReconciliationRun,
  records: readonly IncomingProduct[],
): Promise<{ ctx: Omit<ProductContext, "incomingSkuCounts" | "incomingBarcodeCounts">; table: CatalogueTable }> {
  if (!run.locationId) throw new ReconciliationError("location_required");
  const table = await catalogueTableFor(client, run.businessId);
  const locationId = run.locationId;

  // Verified mappings of THIS source: file/API identities and connection mappings.
  const externalIds = records.map((r) => r.externalId).filter((id): id is string => id != null);
  const mappings = new Map<string, string>();
  if (externalIds.length > 0) {
    const { rows } = await client.query<{ external_id: string; canonical_id: string }>(
      `SELECT external_id, canonical_id FROM source_identities
        WHERE business_id = $1 AND source_key = $2 AND domain = 'product'
          AND external_type = 'product' AND canonical_type = $3
          AND retired_at IS NULL AND verified AND external_id = ANY($4::text[])`,
      [run.businessId, run.sourceKey, table, externalIds],
    );
    for (const r of rows) mappings.set(r.external_id, r.canonical_id);
    if (run.connectionId) {
      const { rows: connRows } = await client.query<{ remote_id: string; local_id: string }>(
        `SELECT remote_id, local_id::text AS local_id FROM integration_mappings
          WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'product'
            AND remote_id = ANY($3::text[])`,
        [run.businessId, run.connectionId, externalIds],
      );
      for (const r of connRows) if (!mappings.has(r.remote_id)) mappings.set(r.remote_id, r.local_id);
    }
  }

  const skus = [...new Set(records.map((r) => normalizeSkuKey(r.sku)).filter((s): s is string => s != null))];
  const barcodes = [...new Set(records.flatMap((r) => (r.barcodes ?? []).map(normalizeBarcodeKey)).filter((b): b is string => b != null))];
  const nameOnly = [
    ...new Set(
      records
        .filter((r) => !normalizeSkuKey(r.sku) && !(r.barcodes ?? []).some((b) => normalizeBarcodeKey(b)))
        .map((r) => (r.name ?? "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ];

  const hasItems = table === "items";
  const select = hasItems
    ? `SELECT i.id::text AS id, i.location_id::text AS location_id, i.name, i.sku, i.kind, i.unit, i.tracking,
              i.is_active, i.barcode, NULL::text AS price
         FROM items i`
    : `SELECT m.id::text AS id, m.location_id::text AS location_id, m.name, m.sku, NULL::text AS kind,
              NULL::text AS unit, NULL::text AS tracking, m.is_active, NULL::text AS barcode,
              m.price::text AS price
         FROM menu_items m`;
  const alias = hasItems ? "i" : "m";

  const found = new Map<string, CatalogueRow>();
  const collect = async (where: string, params: unknown[]) => {
    const { rows } = await client.query<CatalogueRow>(`${select} WHERE ${alias}.location_id = $1 AND (${where})`, [locationId, ...params]);
    for (const r of rows) found.set(r.id, r);
  };
  // SKUs are compared the way the normaliser folds them (digits, case, spacing).
  if (skus.length > 0) {
    await collect(`upper(btrim(regexp_replace(translate(COALESCE(${alias}.sku, ''), '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', '01234567890123456789'), '\\s+', ' ', 'g'))) = ANY($2::text[])`, [skus]);
  }
  if (hasItems && barcodes.length > 0) {
    await collect(
      `${alias}.barcode = ANY($2::text[]) OR ${alias}.id IN (SELECT item_id FROM item_barcodes WHERE location_id = $1 AND code = ANY($2::text[]))`,
      [barcodes],
    );
  }
  if (nameOnly.length > 0) await collect(`lower(btrim(${alias}.name)) = ANY($2::text[])`, [nameOnly]);
  const mappedTargets = [...new Set(mappings.values())].filter((id) => !found.has(id));
  if (mappedTargets.length > 0) await collect(`${alias}.id::text = ANY($2::text[])`, [mappedTargets]);

  const barcodesByItem = new Map<string, string[]>();
  if (hasItems && found.size > 0) {
    const { rows } = await client.query<{ item_id: string; code: string }>(
      `SELECT item_id::text AS item_id, code FROM item_barcodes WHERE location_id = $1 AND item_id::text = ANY($2::text[])`,
      [locationId, [...found.keys()]],
    );
    for (const r of rows) barcodesByItem.set(r.item_id, [...(barcodesByItem.get(r.item_id) ?? []), r.code]);
  }

  const canonicalById = new Map<string, CanonicalProduct>();
  const candidatesBySku = new Map<string, CanonicalProduct[]>();
  const candidatesByBarcode = new Map<string, CanonicalProduct[]>();
  const candidatesByName = new Map<string, CanonicalProduct[]>();
  const push = (map: Map<string, CanonicalProduct[]>, key: string | null, product: CanonicalProduct) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    if (!list.some((p) => p.id === product.id)) list.push(product);
    map.set(key, list);
  };
  for (const row of found.values()) {
    const product = toCanonicalProduct(row, barcodesByItem.get(row.id) ?? []);
    canonicalById.set(product.id, product);
    push(candidatesBySku, normalizeSkuKey(product.sku), product);
    for (const b of product.barcodes) push(candidatesByBarcode, normalizeBarcodeKey(b), product);
    push(candidatesByName, normalizeNameKey(product.name), product);
  }
  return { ctx: { locationId, mappings, canonicalById, candidatesBySku, candidatesByBarcode, candidatesByName }, table };
}

/** A digest of the catalogue + identities a product preview was matched against. */
export async function productCanonicalToken(client: PoolClient, run: ReconciliationRun): Promise<string> {
  const table = await catalogueTableFor(client, run.businessId);
  const { rows } = await client.query<{ token: string }>(
    `SELECT md5(
        (SELECT count(*)::text || ':' || COALESCE(max(updated_at)::text, '') FROM ${table} WHERE location_id = $1)
        || '|' ||
        (SELECT count(*)::text || ':' || COALESCE(max(updated_at)::text, '') FROM source_identities
          WHERE business_id = $2 AND domain = 'product')
     ) AS token`,
    [run.locationId, run.businessId],
  );
  return rows[0].token;
}

export interface StageProductsOptions {
  policy?: FieldAuthorityPolicy;
  /** Every incoming product of the run when this batch is a slice, for run-wide duplicate counts. */
  wholeRun?: readonly IncomingProduct[];
}

/** Resolve and stage one bounded batch of incoming products. Writes nothing canonical. */
export async function stageProducts(
  businessId: string,
  runId: string,
  records: readonly IncomingProduct[],
  options: StageProductsOptions = {},
): Promise<StageResult> {
  const planned = await withTenantTransaction(businessId, async (client) => {
    const run = await loadRun(client, businessId, runId);
    if (run.domain !== "product") throw new ReconciliationError("domain_mismatch");
    const { ctx } = await loadProductContext(client, run, records);
    return planProducts(
      records,
      ctx,
      {
        policy: options.policy ?? DEFAULT_FIELD_AUTHORITY_POLICY,
        readCanonical: (id) => ctx.canonicalById.get(id)?.fields ?? null,
      },
      options.wholeRun ?? records,
    );
  });
  return stagePlannedItems(businessId, runId, planned);
}

// ---------------------------------------------------------------------------
// Completing discovery — the gate
// ---------------------------------------------------------------------------

export interface DiscoveryResult {
  run: ReconciliationRun;
  gate: GateDecision;
  counts: ReconciliationCounts;
}

export interface CompleteDiscoveryInput {
  businessId: string;
  runId: string;
  /** How many canonical rows of this domain/scope the business already had. */
  canonicalCount: number;
  canonicalToken?: string | null;
  actor: Actor;
}

export async function completeDiscovery(input: CompleteDiscoveryInput): Promise<DiscoveryResult> {
  return withTenantTransaction(input.businessId, async (client) => {
    const run = await loadRun(client, input.businessId, input.runId, true);
    const items = await readItemViews(client, run);
    const gate = evaluateFirstRunGate({
      canonicalCount: input.canonicalCount,
      counts: countOutcomes(items.map((i) => i.outcome)),
      mode: run.importMode,
    });
    if (input.canonicalToken !== undefined) {
      await client.query(`UPDATE import_reconciliation_runs SET canonical_token = $3 WHERE id = $1 AND business_id = $2`, [
        run.id,
        run.businessId,
        input.canonicalToken,
      ]);
      run.canonicalToken = input.canonicalToken;
    }
    await setRunStatus(client, run, "staged", { stagedAt: true });
    if (gate.path === "fast") {
      await approveSafe(client, run, { userId: null, name: "fast_path" }, true);
    }
    await audit(client, input.businessId, input.actor, "reconciliation.run.staged", run.id, {
      gate: gate.path,
      reasons: gate.reasons,
      counts: summarizeItems(items),
    });
    const counts = summarizeItems(await readItemViews(client, run));
    return { run: await loadRun(client, input.businessId, input.runId), gate, counts };
  });
}

async function readItemViews(
  client: PoolClient,
  run: ReconciliationRun,
): Promise<Array<{ outcome: ReconciliationOutcome; status: ReconciliationItemStatus }>> {
  const { rows } = await client.query<{ outcome: ReconciliationOutcome; status: ReconciliationItemStatus }>(
    `SELECT outcome, status FROM import_reconciliation_items WHERE run_id = $1 AND business_id = $2`,
    [run.id, run.businessId],
  );
  return rows;
}

/** Discovery for a product run: counts the branch's catalogue and digests it for later staleness checks. */
export async function completeProductDiscovery(businessId: string, runId: string, actor: Actor): Promise<DiscoveryResult> {
  const { canonicalCount, canonicalToken } = await withTenantTransaction(businessId, async (client) => {
    const run = await loadRun(client, businessId, runId);
    if (run.domain !== "product") throw new ReconciliationError("domain_mismatch");
    const table = await catalogueTableFor(client, businessId);
    const { rows } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE location_id = $1`, [run.locationId]);
    return { canonicalCount: Number(rows[0].n), canonicalToken: await productCanonicalToken(client, run) };
  });
  return completeDiscovery({ businessId, runId, canonicalCount, canonicalToken, actor });
}

/** Release the scope. Staged evidence, decisions and applied links are kept; nothing canonical is undone. */
export async function cancelRun(businessId: string, runId: string, actor: Actor): Promise<ReconciliationRun> {
  return withTenantTransaction(businessId, async (client) => {
    const run = await loadRun(client, businessId, runId, true);
    if (!canTransitionRun(run.status, "cancelled")) throw new ReconciliationError("run_not_cancellable", { status: run.status });
    await setRunStatus(client, run, "cancelled");
    await audit(client, businessId, actor, "reconciliation.run.cancelled", run.id, {});
    return loadRun(client, businessId, runId);
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface RunSummary {
  run: ReconciliationRun;
  counts: ReconciliationCounts;
  progress: Progress;
}

export async function getRunSummary(businessId: string, runId: string): Promise<RunSummary> {
  return withTenantTransaction(businessId, async (client) => {
    const run = await loadRun(client, businessId, runId);
    const counts = summarizeItems(await readItemViews(client, run));
    return { run, counts, progress: progressStage({ runStatus: run.status, counts, crossChecked: run.crossChecked }) };
  });
}

export interface ListItemsQuery {
  outcome?: ReconciliationOutcome;
  status?: ReconciliationItemStatus;
  /** Matches the external key or the incoming name/sku in the snapshot. */
  search?: string;
  afterId?: number;
  limit?: number;
}

export async function listItems(businessId: string, runId: string, q: ListItemsQuery = {}): Promise<StagedItem[]> {
  return withTenantTransaction(businessId, async (client) => {
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
    const search = q.search?.trim();
    const { rows } = await client.query(
      `SELECT * FROM import_reconciliation_items
        WHERE run_id = $1 AND business_id = $2
          AND ($3::text IS NULL OR outcome = $3)
          AND ($4::text IS NULL OR status = $4)
          AND ($5::bigint IS NULL OR id > $5)
          AND ($6::text IS NULL
               OR external_key ILIKE '%' || $6 || '%'
               OR snapshot ->> 'name' ILIKE '%' || $6 || '%'
               OR snapshot ->> 'sku' ILIKE '%' || $6 || '%')
        ORDER BY id
        LIMIT $7`,
      [runId, businessId, q.outcome ?? null, q.status ?? null, q.afterId ?? null, search ? search : null, limit],
    );
    return rows.map(mapItem);
  });
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export interface DecideInput {
  businessId: string;
  runId: string;
  itemId: number;
  decision: ReconciliationDecision;
  /** For `link`: the candidate chosen. Must be one the engine offered. */
  canonicalId?: string | null;
  authorityOverrides?: FieldAuthorityOverrides;
  reason?: string;
  actor: Actor;
}

const REVIEWABLE: readonly ReconciliationRunStatus[] = ["staged", "in_review", "partially_applied"];

export async function decideItem(input: DecideInput): Promise<StagedItem> {
  if (!RECONCILIATION_DECISIONS.includes(input.decision)) throw new ReconciliationError("invalid_decision");
  return withTenantTransaction(input.businessId, async (client) => {
    const run = await loadRun(client, input.businessId, input.runId, true);
    if (run.importMode === "preview_only") throw new ReconciliationError("preview_only_run");
    if (!REVIEWABLE.includes(run.status)) throw new ReconciliationError("run_not_reviewable", { status: run.status });

    const { rows } = await client.query(
      `SELECT * FROM import_reconciliation_items WHERE id = $1 AND run_id = $2 AND business_id = $3 FOR UPDATE`,
      [input.itemId, input.runId, input.businessId],
    );
    if (!rows[0]) throw new ReconciliationError("item_not_found");
    const item = mapItem(rows[0]);
    if (item.status === "applied") throw new ReconciliationError("item_already_applied");

    const effect = effectForDecision(item.outcome, input.decision, item.candidates.length > 0);
    if (effect === null) throw new ReconciliationError("decision_not_allowed", { outcome: item.outcome, decision: input.decision });

    const reason = (input.reason ?? "").trim();
    let canonicalId: string | null = item.canonicalId;
    if (input.decision === "link") {
      canonicalId = input.canonicalId ?? item.canonicalId;
      if (!canonicalId || !item.candidates.some((c) => c.id === canonicalId)) {
        throw new ReconciliationError("candidate_not_offered", { canonicalId });
      }
    }
    // Overruling the engine needs a stated reason on the record.
    if (input.decision === "create_separate" && item.outcome === "ambiguous" && !reason) {
      throw new ReconciliationError("reason_required");
    }
    if (input.decision === "choose_authority") {
      const overrides = input.authorityOverrides ?? {};
      if (Object.keys(overrides).length === 0) throw new ReconciliationError("authority_required");
      const touchesProtected = Object.entries(overrides).some(
        ([field, owner]) => owner === "source" && isProtectedClass(fieldClassFor(run.domain, field)),
      );
      if (touchesProtected && !reason) throw new ReconciliationError("reason_required");
    }

    const { rows: decisionRows } = await client.query<{ id: string }>(
      `INSERT INTO import_reconciliation_decisions
         (business_id, run_id, item_id, decision, canonical_id, authority_overrides, reason, evidence,
          decided_by, decided_by_name)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::uuid, $10) RETURNING id`,
      [
        input.businessId,
        input.runId,
        input.itemId,
        input.decision,
        canonicalId,
        JSON.stringify(input.authorityOverrides ?? {}),
        reason,
        JSON.stringify({ outcome: item.outcome, reasons: item.reasons, candidates: item.candidates, evidence: item.evidence }),
        input.actor.userId,
        input.actor.name,
      ],
    );

    const status: ReconciliationItemStatus =
      effect === "skip" ? "skipped" : effect === "none" ? "held" : "approved";
    const { rows: updated } = await client.query(
      `UPDATE import_reconciliation_items
          SET status = $3, effect = $4, canonical_id = COALESCE($5, canonical_id),
              last_decision_id = $6::uuid, error = NULL, updated_at = now()
        WHERE id = $1 AND business_id = $2
        RETURNING *`,
      [input.itemId, input.businessId, status, effect === "none" ? null : effect, canonicalId, decisionRows[0].id],
    );
    if (run.status === "staged") await setRunStatus(client, run, "in_review");
    await audit(client, input.businessId, input.actor, "reconciliation.decision", run.id, {
      itemId: input.itemId,
      decision: input.decision,
      effect,
      canonicalId,
    });
    return mapItem(updated[0]);
  });
}

async function approveSafe(client: PoolClient, run: ReconciliationRun, actor: Actor, fastPath: boolean): Promise<number> {
  if (run.importMode === "preview_only") return 0;
  const { rows } = await client.query<{ id: string; outcome: ReconciliationOutcome; canonical_id: string | null }>(
    `SELECT id, outcome, canonical_id FROM import_reconciliation_items
      WHERE run_id = $1 AND business_id = $2 AND status = 'proposed'
        AND outcome IN ('safe_match', 'create_new')
      ORDER BY id FOR UPDATE`,
    [run.id, run.businessId],
  );
  for (const item of rows) {
    const effect: ReconciliationEffect = item.outcome === "safe_match" ? "link" : "create";
    const decision: ReconciliationDecision = effect === "link" ? "link" : "create_separate";
    const { rows: d } = await client.query<{ id: string }>(
      `INSERT INTO import_reconciliation_decisions
         (business_id, run_id, item_id, decision, canonical_id, reason, evidence, batch, decided_by, decided_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, true, $7::uuid, $8) RETURNING id`,
      [run.businessId, run.id, item.id, decision, item.canonical_id, fastPath ? "fast_path" : "batch_safe", actor.userId, actor.name],
    );
    await client.query(
      `UPDATE import_reconciliation_items
          SET status = 'approved', effect = $3, last_decision_id = $4::uuid, updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [item.id, run.businessId, effect, d[0].id],
    );
  }
  return rows.length;
}

/** "Approve all safe": only `safe_match` and `create_new`; everything needing a person is left alone. */
export async function approveSafeBatch(businessId: string, runId: string, actor: Actor): Promise<{ approved: number }> {
  return withTenantTransaction(businessId, async (client) => {
    const run = await loadRun(client, businessId, runId, true);
    if (run.importMode === "preview_only") throw new ReconciliationError("preview_only_run");
    if (!REVIEWABLE.includes(run.status)) throw new ReconciliationError("run_not_reviewable", { status: run.status });
    const approved = await approveSafe(client, run, actor, false);
    if (approved > 0 && run.status === "staged") await setRunStatus(client, run, "in_review");
    await audit(client, businessId, actor, "reconciliation.batch_approved", run.id, { approved });
    return { approved };
  });
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

export interface RevalidateResult extends StaleCheck {
  run: ReconciliationRun;
}

/**
 * Is the preview still true? A stale run stops being appliable, and every
 * approval given against the old picture falls back to `proposed` — the owner
 * approved what they saw, not what is there now.
 */
export async function revalidateRun(
  businessId: string,
  runId: string,
  current: PreviewFingerprint,
  options: { maxAgeMs?: number; now?: Date } = {},
): Promise<RevalidateResult> {
  return withTenantTransaction(businessId, async (client) => {
    const run = await loadRun(client, businessId, runId, true);
    const check = isPreviewStale({
      staged: {
        sourceFingerprint: run.sourceFingerprint,
        policyVersion: run.policyVersion,
        canonicalToken: run.canonicalToken,
        stagedAt: new Date(run.stagedAt ?? run.createdAt),
      },
      current,
      now: options.now ?? new Date(),
      maxAgeMs: options.maxAgeMs,
    });
    if (check.stale && REVIEWABLE.includes(run.status)) {
      await setRunStatus(client, run, "stale");
      await client.query(
        `UPDATE import_reconciliation_items
            SET status = 'proposed', effect = NULL, updated_at = now()
          WHERE run_id = $1 AND business_id = $2 AND status = 'approved'`,
        [run.id, businessId],
      );
      await audit(client, businessId, null, "reconciliation.run.stale", run.id, { reasons: check.reasons });
    }
    return { ...check, run: await loadRun(client, businessId, runId) };
  });
}

/** Reopen a stale run for re-staging against the new source/canonical state. */
export async function reopenStaleRun(
  businessId: string,
  runId: string,
  next: { sourceFingerprint: string; policyVersion?: number },
  actor: Actor,
): Promise<ReconciliationRun> {
  return withTenantTransaction(businessId, async (client) => {
    const run = await loadRun(client, businessId, runId, true);
    if (run.status !== "stale") throw new ReconciliationError("run_not_stale", { status: run.status });
    await client.query(
      `UPDATE import_reconciliation_runs
          SET source_fingerprint = $3, policy_version = COALESCE($4, policy_version), canonical_token = NULL
        WHERE id = $1 AND business_id = $2`,
      [run.id, businessId, next.sourceFingerprint, next.policyVersion ?? null],
    );
    await setRunStatus(client, run, "discovering");
    await audit(client, businessId, actor, "reconciliation.run.reopened", run.id, {});
    return loadRun(client, businessId, runId);
  });
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

export interface ApplyContext {
  client: PoolClient;
  run: ReconciliationRun;
  item: StagedItem;
  /** The canonical row to link to, when the effect is `link`. */
  canonicalId: string | null;
  /** Stable per item; a domain write that is not naturally idempotent keys on it. */
  idempotencyKey: string;
  actor: Actor;
}

export interface ApplyHandler {
  domain: ReconciliationDomain;
  /** Link a source record to an existing canonical row. Returns the canonical row linked. */
  link(ctx: ApplyContext): Promise<{ canonicalId: string }>;
  /** Create the canonical row through the owning domain service. Absent ⇒ create is refused. */
  create?(ctx: ApplyContext): Promise<{ canonicalId: string }>;
}

export interface ApplyOptions {
  businessId: string;
  runId: string;
  handler: ApplyHandler;
  /** The source/policy/canonical state right now — the preview is re-validated against it. */
  current: PreviewFingerprint;
  actor: Actor;
  batchSize?: number;
  /** Apply even though the source or canonical state could not be re-read. */
  allowUnverified?: boolean;
  /** Stop after this many batches (lets a worker resume later). */
  maxBatches?: number;
}

export interface ApplyResult {
  run: ReconciliationRun;
  counts: ReconciliationCounts;
  progress: Progress;
}

export async function applyRun(options: ApplyOptions): Promise<ApplyResult> {
  const { businessId, runId, handler, actor } = options;
  const batchSize = Math.min(Math.max(options.batchSize ?? 50, 1), 500);

  // Re-validate before the first write: permissions are the caller's, but the
  // preview itself must still be true.
  const check = await revalidateRun(businessId, runId, options.current);
  if (check.stale) throw new ReconciliationError("preview_stale", { reasons: check.reasons });
  if (check.unverified && !options.allowUnverified) throw new ReconciliationError("preview_unverified");

  await withTenantTransaction(businessId, async (client) => {
    const run = await loadRun(client, businessId, runId, true);
    if (run.importMode === "preview_only") throw new ReconciliationError("preview_only_run");
    if (run.domain !== handler.domain) throw new ReconciliationError("domain_mismatch");
    if (run.status === "applying") return; // resume
    if (!REVIEWABLE.includes(run.status)) throw new ReconciliationError("run_not_appliable", { status: run.status });
    await setRunStatus(client, run, "applying");
  });

  for (let batch = 0; options.maxBatches == null || batch < options.maxBatches; batch += 1) {
    const processed = await withTenantTransaction(businessId, async (client) => {
      const run = await loadRun(client, businessId, runId);
      const { rows } = await client.query(
        `SELECT * FROM import_reconciliation_items
          WHERE run_id = $1 AND business_id = $2 AND status = 'approved'
          ORDER BY id LIMIT $3 FOR UPDATE SKIP LOCKED`,
        [runId, businessId, batchSize],
      );
      for (const row of rows) {
        const item = mapItem(row);
        await client.query("SAVEPOINT reconciliation_item");
        try {
          const ctx: ApplyContext = {
            client,
            run,
            item,
            canonicalId: item.canonicalId,
            idempotencyKey: `${runId}:${item.id}`,
            actor,
          };
          let canonicalId: string | null = null;
          if (item.effect === "link") {
            if (!item.canonicalId) throw new ReconciliationError("link_target_missing");
            canonicalId = (await handler.link(ctx)).canonicalId;
          } else if (item.effect === "create") {
            if (!handler.create) throw new ReconciliationError("create_not_supported");
            canonicalId = (await handler.create(ctx)).canonicalId;
          }
          await client.query(
            `UPDATE import_reconciliation_items
                SET status = 'applied', resolved_canonical_id = $3, applied_at = now(),
                    attempts = attempts + 1, error = NULL, updated_at = now()
              WHERE id = $1 AND business_id = $2`,
            [item.id, businessId, canonicalId],
          );
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT reconciliation_item");
          const message = error instanceof Error ? error.message : String(error);
          await client.query(
            `UPDATE import_reconciliation_items
                SET status = 'failed', attempts = attempts + 1, error = $3, updated_at = now()
              WHERE id = $1 AND business_id = $2`,
            [item.id, businessId, message.slice(0, 500)],
          );
        }
        await client.query("RELEASE SAVEPOINT reconciliation_item");
      }
      return rows.length;
    });
    if (processed === 0) break;
  }

  return withTenantTransaction(businessId, async (client) => {
    const run = await loadRun(client, businessId, runId, true);
    const counts = summarizeItems(await readItemViews(client, run));
    const { rows: pendingApproved } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM import_reconciliation_items WHERE run_id = $1 AND business_id = $2 AND status = 'approved'`,
      [runId, businessId],
    );
    // More approved work left (maxBatches) keeps the run in `applying`.
    if (Number(pendingApproved[0].n) === 0 && run.status === "applying") {
      const remaining = counts.pending + counts.failed;
      await setRunStatus(client, run, remaining === 0 ? "applied" : "partially_applied", { appliedAt: remaining === 0 });
      await audit(client, businessId, actor, "reconciliation.run.applied", run.id, { counts, status: run.status });
    }
    const finalRun = await loadRun(client, businessId, runId);
    return {
      run: finalRun,
      counts,
      progress: progressStage({ runStatus: finalRun.status, counts, crossChecked: finalRun.crossChecked }),
    };
  });
}

// ---------------------------------------------------------------------------
// Cross-check
// ---------------------------------------------------------------------------

export interface CrossCheckResult {
  ok: boolean;
  problems: string[];
}

/**
 * After an apply: every applied `link`/`create` item must have a live source
 * identity pointing at the canonical row it resolved to. Only a run that passes
 * is allowed to call itself reconciled.
 */
export async function crossCheckRun(businessId: string, runId: string): Promise<CrossCheckResult> {
  return withTenantTransaction(businessId, async (client) => {
    const run = await loadRun(client, businessId, runId, true);
    const problems: string[] = [];
    if (run.status !== "applied") problems.push("run_not_fully_applied");
    const { rows } = await client.query<{ external_type: string; external_key: string; resolved_canonical_id: string | null; has_identity: boolean }>(
      `SELECT i.external_type, i.external_key, i.resolved_canonical_id,
              EXISTS (
                SELECT 1 FROM source_identities s
                 WHERE s.business_id = i.business_id AND s.source_key = $3 AND s.domain = $4
                   AND s.external_type = i.external_type AND s.external_id = i.external_key
                   AND s.canonical_id = i.resolved_canonical_id AND s.retired_at IS NULL
              ) AS has_identity
         FROM import_reconciliation_items i
        WHERE i.run_id = $1 AND i.business_id = $2 AND i.status = 'applied' AND i.effect IN ('link', 'create')`,
      [runId, businessId, run.sourceKey, run.domain],
    );
    for (const r of rows) {
      if (!r.resolved_canonical_id) problems.push(`no_target:${r.external_key}`);
      else if (!r.has_identity && !r.external_key.startsWith("row:")) problems.push(`no_identity:${r.external_key}`);
    }
    const ok = problems.length === 0;
    if (ok) await client.query(`UPDATE import_reconciliation_runs SET cross_checked = true WHERE id = $1 AND business_id = $2`, [runId, businessId]);
    return { ok, problems };
  });
}

// ---------------------------------------------------------------------------
// Product apply handler
// ---------------------------------------------------------------------------

export interface ProductHandlerOptions {
  /**
   * Create the canonical product through the owning service. Absent ⇒ a `create`
   * effect fails the item with `create_not_supported` instead of guessing.
   */
  create?: ApplyHandler["create"];
}

/**
 * Links write a verified source identity (and, for a connection-backed source,
 * the `integration_mappings` row the existing sync code reads). A link never
 * touches the canonical product itself: field authority is applied by the
 * owning services, not by an import.
 */
export function createProductApplyHandler(options: ProductHandlerOptions = {}): ApplyHandler {
  /** Remember the link: a verified source identity, plus the mapping row for a connection-backed source. */
  async function recordIdentity(ctx: ApplyContext, table: CatalogueTable, canonicalId: string): Promise<void> {
    // A file row without an id column has no identity to remember.
    if (ctx.item.externalKey.startsWith("row:")) return;
    await linkSourceIdentity(ctx.client, {
      businessId: ctx.run.businessId,
      domain: "product",
      sourceKey: ctx.run.sourceKey,
      provider: ctx.run.provider,
      externalType: ctx.item.externalType,
      externalId: ctx.item.externalKey,
      canonicalType: table,
      canonicalId,
      runId: ctx.run.id,
      linkedBy: ctx.actor.userId,
    });
    if (!ctx.run.connectionId) return;
    const { rows: existing } = await ctx.client.query<{ local_id: string }>(
      `SELECT local_id::text AS local_id FROM integration_mappings
        WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'product' AND remote_id = $3`,
      [ctx.run.businessId, ctx.run.connectionId, ctx.item.externalKey],
    );
    if (existing[0] && existing[0].local_id !== canonicalId) {
      throw new ReconciliationError("identity_already_linked", { linkedTo: existing[0].local_id });
    }
    if (!existing[0]) {
      await upsertMappingOnClient(ctx.client, ctx.run.businessId, ctx.run.connectionId, "product", ctx.item.externalKey, canonicalId, null, false);
    }
  }

  return {
    domain: "product",
    async link(ctx) {
      const canonicalId = ctx.canonicalId as string;
      const table = await catalogueTableFor(ctx.client, ctx.run.businessId);
      const { rows } = await ctx.client.query(`SELECT 1 FROM ${table} WHERE id::text = $1 AND location_id = $2`, [
        canonicalId,
        ctx.run.locationId,
      ]);
      if (!rows[0]) throw new ReconciliationError("link_target_not_found", { canonicalId });
      await recordIdentity(ctx, table, canonicalId);
      return { canonicalId };
    },
    async create(ctx) {
      if (!options.create) throw new ReconciliationError("create_not_supported");
      const created = await options.create(ctx);
      await recordIdentity(ctx, await catalogueTableFor(ctx.client, ctx.run.businessId), created.canonicalId);
      return created;
    },
  };
}

export type { Resolution };
