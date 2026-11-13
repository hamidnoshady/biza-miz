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
import { isRetailCatalogueIndustry } from "../industries";
import { upsertMappingOnClient } from "../integrations/mapping-service";
import { phoneMatchKeys, phoneMatchSql } from "../parties-service";
import {
  DEFAULT_FIELD_AUTHORITY_POLICY,
  fieldClassFor,
  isProtectedClass,
  isRejectedRemoteEdit,
  remoteEditFingerprint,
  type FieldAuthorityOverrides,
  type FieldAuthorityPolicy,
} from "./field-authority";
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
import {
  identityKeysOf,
  planFinancialDocuments,
  planInventory,
  planParties,
  planProducts,
  type PlannedItem,
} from "./plan";
import {
  normalizeBarcodeKey,
  normalizeEmailKey,
  normalizeNameKey,
  normalizePhoneKey,
  normalizeReferenceKey,
  normalizeSkuKey,
} from "./normalize";
import {
  amountDateKey,
  type CanonicalFinancialDocument,
  type CanonicalParty,
  type CanonicalProduct,
  type CanonicalStock,
  type FinancialDocumentContext,
  type InventoryContext,
  type PartyContext,
  type ProductContext,
} from "./resolvers";
import {
  RECONCILIATION_DECISIONS,
  RECONCILIATION_DOMAINS,
  RECONCILIATION_IMPORT_MODES,
  RECONCILIATION_SOURCE_KINDS,
  type FieldConflict,
  type CutoverAuthority,
  type IncomingFinancialDocument,
  type IncomingInventory,
  type IncomingParty,
  type IncomingProduct,
  type PartyRole,
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

export type { CutoverAuthority };

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
  cutoverAuthority: CutoverAuthority | null;
  cutoverAt: string | null;
  policySnapshot: Record<string, unknown>;
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
  conflicts: FieldConflict[];
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
    cutoverAuthority: (r.cutover_authority as CutoverAuthority | null) ?? null,
    cutoverAt: iso(r.cutover_at),
    policySnapshot: (r.policy_snapshot as Record<string, unknown>) ?? {},
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
    conflicts: (r.conflicts as FieldConflict[]) ?? [],
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
  cutoverAuthority?: CutoverAuthority | null;
  cutoverAt?: string | null;
  policySnapshot?: Record<string, unknown>;
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
          cutover_authority, cutover_at, policy_snapshot, scope, evidence, created_by, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15::jsonb, $16::jsonb, $17::jsonb, $18::uuid, $19)
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
        input.cutoverAuthority ?? null,
        input.cutoverAt ?? null,
        JSON.stringify(input.policySnapshot ?? {}),
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

type CatalogueTable = "items" | "menu_items" | "inventory_items";

async function catalogueTableFor(
  client: PoolClient,
  businessId: string,
  run?: Pick<ReconciliationRun, "scope">,
): Promise<CatalogueTable> {
  const { rows } = await client.query<{ industry: string }>("SELECT industry FROM businesses WHERE id = $1", [businessId]);
  const industry = rows[0]?.industry;
  const scopeTable = run?.scope?.canonicalTable;
  const scopeEntity = run?.scope?.entityKey;
  if (industry === "food_service" && (scopeTable === "inventory_items" || scopeEntity === "inventory.items")) {
    return "inventory_items";
  }
  if (industry === "food_service") return "menu_items";
  if (isRetailCatalogueIndustry(industry)) return "items";
  throw new ReconciliationError("industry_not_supported", { industry: industry ?? "unknown" });
}

// ---------------------------------------------------------------------------
// Rejected remote edits (no endless conflict / outbound bounce)
// ---------------------------------------------------------------------------

async function loadRejectedEdits(
  client: PoolClient,
  businessId: string,
  sourceKey: string,
  domain: ReconciliationDomain,
  externalIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (externalIds.length === 0) return out;
  const { rows } = await client.query<{ external_id: string; fingerprint: string }>(
    `SELECT external_id, fingerprint
       FROM import_reconciliation_rejected_edits
      WHERE business_id = $1 AND source_key = $2 AND domain = $3 AND external_id = ANY($4::text[])`,
    [businessId, sourceKey, domain, externalIds],
  );
  for (const row of rows) {
    const set = out.get(row.external_id) ?? new Set<string>();
    set.add(row.fingerprint);
    out.set(row.external_id, set);
  }
  return out;
}

function suppressRejectedConflicts(
  planned: PlannedItem[],
  rejectedByExternalId: ReadonlyMap<string, ReadonlySet<string>>,
): PlannedItem[] {
  if (rejectedByExternalId.size === 0) return planned;
  return planned.map((item) => {
    const rejected = rejectedByExternalId.get(item.externalKey);
    if (!rejected || item.conflicts.length === 0) return item;
    const keptConflicts = item.conflicts.filter((c) => !isRejectedRemoteEdit(rejected, c.field, c.incoming));
    if (keptConflicts.length === item.conflicts.length) return item;
    const stillNeedsReview = keptConflicts.some((c) => c.needsReview);
    const outcome =
      item.resolution.outcome === "field_conflict" && !stillNeedsReview
        ? item.resolution.reasons.includes("verified_mapping")
          ? "already_linked"
          : "safe_match"
        : item.resolution.outcome;
    return {
      ...item,
      conflicts: keptConflicts,
      resolution: { ...item.resolution, outcome },
    };
  });
}

export async function recordRejectedRemoteEdit(
  client: PoolClient,
  input: {
    businessId: string;
    sourceKey: string;
    domain: ReconciliationDomain;
    externalType: string;
    externalId: string;
    field: string;
    value: unknown;
    reason?: string;
    actor: Actor;
  },
): Promise<void> {
  const fingerprint = remoteEditFingerprint(input.field, input.value);
  await client.query(
    `INSERT INTO import_reconciliation_rejected_edits
       (business_id, source_key, domain, external_type, external_id, field, fingerprint, reason, rejected_by, rejected_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10)
     ON CONFLICT (business_id, source_key, domain, external_type, external_id, field)
     DO UPDATE SET fingerprint = EXCLUDED.fingerprint,
                   reason = EXCLUDED.reason,
                   rejected_by = EXCLUDED.rejected_by,
                   rejected_by_name = EXCLUDED.rejected_by_name,
                   updated_at = now()`,
    [
      input.businessId,
      input.sourceKey,
      input.domain,
      input.externalType,
      input.externalId,
      input.field,
      fingerprint,
      (input.reason ?? "").trim(),
      input.actor.userId,
      input.actor.name,
    ],
  );
}

export async function isRemoteEditSuppressed(
  businessId: string,
  sourceKey: string,
  domain: ReconciliationDomain,
  externalType: string,
  externalId: string,
  field: string,
  value: unknown,
): Promise<boolean> {
  const fingerprint = remoteEditFingerprint(field, value);
  return withTenantTransaction(businessId, async (client) => {
    const { rows } = await client.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM import_reconciliation_rejected_edits
          WHERE business_id = $1 AND source_key = $2 AND domain = $3
            AND external_type = $4 AND external_id = $5 AND field = $6 AND fingerprint = $7
       ) AS ok`,
      [businessId, sourceKey, domain, externalType, externalId, field, fingerprint],
    );
    return Boolean(rows[0]?.ok);
  });
}

export async function listRejectedRemoteEdits(
  businessId: string,
  filter: { sourceKey?: string; domain?: ReconciliationDomain; externalId?: string } = {},
) {
  return withTenantTransaction(businessId, async (client) => {
    const { rows } = await client.query<{
      id: string;
      source_key: string;
      domain: ReconciliationDomain;
      external_type: string;
      external_id: string;
      field: string;
      fingerprint: string;
      reason: string;
      rejected_by_name: string;
      created_at: Date;
    }>(
      `SELECT id, source_key, domain, external_type, external_id, field, fingerprint, reason, rejected_by_name, created_at
         FROM import_reconciliation_rejected_edits
        WHERE business_id = $1
          AND ($2::text IS NULL OR source_key = $2)
          AND ($3::text IS NULL OR domain = $3)
          AND ($4::text IS NULL OR external_id = $4)
        ORDER BY updated_at DESC
        LIMIT 500`,
      [businessId, filter.sourceKey ?? null, filter.domain ?? null, filter.externalId ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      sourceKey: r.source_key,
      domain: r.domain,
      externalType: r.external_type,
      externalId: r.external_id,
      field: r.field,
      fingerprint: r.fingerprint,
      reason: r.reason,
      rejectedByName: r.rejected_by_name,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
  });
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
  parent_item_id?: string | null;
  variant_options?: Record<string, string> | null;
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
    variantOptions: row.variant_options ?? undefined,
    fields: {
      name: row.name,
      sku: row.sku,
      parentItemId: row.parent_item_id ?? null,
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
  const table = await catalogueTableFor(client, run.businessId, run);
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
  const select =
    table === "items"
      ? `SELECT i.id::text AS id, i.location_id::text AS location_id, i.name, i.sku, i.kind, i.unit, i.tracking,
                i.is_active, i.barcode, NULL::text AS price, i.parent_item_id,
                (SELECT jsonb_object_agg(a.name, a.value) FROM item_variant_attributes a WHERE a.item_id=i.id) AS variant_options
           FROM items i`
      : table === "inventory_items"
        ? `SELECT i.id::text AS id, i.location_id::text AS location_id, i.name, i.sku, NULL::text AS kind,
                  i.unit, NULL::text AS tracking, i.is_active, NULL::text AS barcode,
                  NULL::text AS price
             FROM inventory_items i`
        : `SELECT m.id::text AS id, m.location_id::text AS location_id, m.name, m.sku, NULL::text AS kind,
                  NULL::text AS unit, NULL::text AS tracking, m.is_active, NULL::text AS barcode,
                  m.price::text AS price
             FROM menu_items m`;
  const alias = table === "menu_items" ? "m" : "i";

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
  const table = await catalogueTableFor(client, run.businessId, run);
  const timestampCol = table === "inventory_items" ? "created_at" : "updated_at";
  const { rows } = await client.query<{ token: string }>(
    `SELECT md5(
        (SELECT count(*)::text || ':' || COALESCE(max(${timestampCol})::text, '') FROM ${table} WHERE location_id = $1)
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
    const items = planProducts(
      records,
      ctx,
      {
        policy: options.policy ?? DEFAULT_FIELD_AUTHORITY_POLICY,
        readCanonical: (id) => ctx.canonicalById.get(id)?.fields ?? null,
      },
      options.wholeRun ?? records,
    );
    const externalKeys = items.map((i) => i.externalKey);
    const rejected = await loadRejectedEdits(client, businessId, run.sourceKey, "product", externalKeys);
    return suppressRejectedConflicts(items, rejected);
  });
  return stagePlannedItems(businessId, runId, planned);
}

// ---------------------------------------------------------------------------
// Party context, staging, discovery & apply handler
// ---------------------------------------------------------------------------

interface PartyDbRow extends Row {
  id: string;
  name: string;
  phone: string | null;
  phone_e164: string | null;
  email: string | null;
  national_id: string | null;
  economic_code: string | null;
  address: string | null;
  notes: string | null;
  roles: string[] | null;
  role: string | null;
  is_active: boolean;
  merged_into_id: string | null;
  verified_user_phone: string | null;
}

function normalizePartyRoles(row: PartyDbRow): PartyRole[] {
  const raw = Array.isArray(row.roles) && row.roles.length > 0 ? row.roles : row.role ? [row.role] : [];
  return raw.filter((r): r is PartyRole => r === "customer" || r === "supplier" || r === "employee");
}

export async function loadPartyContext(
  client: PoolClient,
  run: ReconciliationRun,
  records: readonly IncomingParty[],
): Promise<Omit<PartyContext, "incomingPhoneCounts">> {
  const externalIds = records.map((r) => r.externalId).filter((id): id is string => id != null);
  const mappings = new Map<string, string>();
  if (externalIds.length > 0) {
    const { rows } = await client.query<{ external_id: string; canonical_id: string }>(
      `SELECT external_id, canonical_id FROM source_identities
        WHERE business_id = $1 AND source_key = $2 AND domain = 'party'
          AND canonical_type = 'parties' AND retired_at IS NULL AND verified
          AND external_id = ANY($3::text[])`,
      [run.businessId, run.sourceKey, externalIds],
    );
    for (const r of rows) mappings.set(r.external_id, r.canonical_id);
    if (run.connectionId) {
      const { rows: connRows } = await client.query<{ remote_id: string; local_id: string }>(
        `SELECT remote_id, local_id::text AS local_id FROM integration_mappings
          WHERE business_id = $1 AND connection_id = $2
            AND entity_type IN ('customer', 'holoo_customer')
            AND remote_id = ANY($3::text[])`,
        [run.businessId, run.connectionId, externalIds],
      );
      for (const r of connRows) if (!mappings.has(r.remote_id)) mappings.set(r.remote_id, r.local_id);
    }
  }

  const found = new Map<string, PartyDbRow>();
  const selectSql = `SELECT p.id::text AS id, p.name, p.phone, p.phone_e164, p.email,
                            p.national_id, p.economic_code, p.address, p.notes,
                            p.roles, p.role, p.is_active, p.merged_into_id::text AS merged_into_id,
                            CASE WHEN u.phone_verified_at IS NOT NULL THEN u.phone_e164 ELSE NULL END AS verified_user_phone
                       FROM parties p
                       LEFT JOIN users u ON u.id = p.employee_user_id AND u.business_id = p.business_id`;

  const addRows = (rows: PartyDbRow[]) => {
    for (const r of rows) found.set(r.id, r);
  };

  const phones = [...new Set(records.map((r) => normalizePhoneKey(r.phone)).filter((p): p is string => p != null))];
  for (const phone of phones) {
    const keys = await phoneMatchKeys(run.businessId, phone);
    if (!keys) continue;
    const { rows } = await client.query<PartyDbRow>(
      `${selectSql}
        WHERE p.business_id = $1 AND p.merged_into_id IS NULL
          AND ${phoneMatchSql("p", "$2", "$3")}`,
      [run.businessId, keys.bidx, keys.e164],
    );
    addRows(rows);
  }

  const emails = [...new Set(records.map((r) => normalizeEmailKey(r.email)).filter((e): e is string => e != null))];
  if (emails.length > 0) {
    const { rows } = await client.query<PartyDbRow>(
      `${selectSql}
        WHERE p.business_id = $1 AND p.merged_into_id IS NULL
          AND lower(p.email) = ANY($2::text[])`,
      [run.businessId, emails],
    );
    addRows(rows);
  }

  const names = [
    ...new Set(records.map((r) => normalizeNameKey(r.name)).filter((n): n is string => n != null)),
  ];
  if (names.length > 0) {
    const { rows } = await client.query<PartyDbRow>(
      `${selectSql}
        WHERE p.business_id = $1 AND p.merged_into_id IS NULL
          AND lower(btrim(p.name)) = ANY($2::text[])`,
      [run.businessId, names],
    );
    addRows(rows);
  }

  const mappedTargets = [...new Set(mappings.values())].filter((id) => !found.has(id));
  if (mappedTargets.length > 0) {
    const { rows } = await client.query<PartyDbRow>(
      `${selectSql} WHERE p.business_id = $1 AND p.id::text = ANY($2::text[])`,
      [run.businessId, mappedTargets],
    );
    addRows(rows);
  }

  // Confirmed external identities with a normalised phone also attest that phone
  // for this business when no OTP-linked user exists.
  const verifiedByPartyId = new Map<string, Set<string>>();
  if (found.size > 0) {
    const { rows: extVerified } = await client.query<{ party_id: string; phone_e164: string | null }>(
      `SELECT party_id::text AS party_id, remote_phone_e164 AS phone_e164
         FROM crm_external_profiles
        WHERE business_id = $1 AND party_id::text = ANY($2::text[])
          AND status = 'confirmed' AND remote_phone_e164 IS NOT NULL`,
      [run.businessId, [...found.keys()]],
    );
    for (const r of extVerified) {
      if (!r.phone_e164) continue;
      const set = verifiedByPartyId.get(r.party_id) ?? new Set<string>();
      set.add(r.phone_e164);
      verifiedByPartyId.set(r.party_id, set);
    }
  }

  const canonicalById = new Map<string, CanonicalParty & { fields: Record<string, unknown> }>();
  const candidatesByPhone = new Map<string, CanonicalParty[]>();
  const candidatesByEmail = new Map<string, CanonicalParty[]>();
  const candidatesByName = new Map<string, CanonicalParty[]>();
  const push = (map: Map<string, CanonicalParty[]>, key: string | null, party: CanonicalParty) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    if (!list.some((p) => p.id === party.id)) list.push(party);
    map.set(key, list);
  };

  for (const row of found.values()) {
    const normPhone = normalizePhoneKey(row.phone_e164 ?? row.phone);
    const normEmail = normalizeEmailKey(row.email);
    const verifiedSet = new Set(verifiedByPartyId.get(row.id) ?? []);
    if (row.verified_user_phone) {
      const userPhone = normalizePhoneKey(row.verified_user_phone);
      if (userPhone) verifiedSet.add(userPhone);
    }
    const party: CanonicalParty & { fields: Record<string, unknown> } = {
      id: row.id,
      name: row.name,
      phones: normPhone ? [normPhone] : [],
      verifiedPhones: normPhone && verifiedSet.has(normPhone) ? [normPhone] : [],
      emails: normEmail ? [normEmail] : [],
      roles: normalizePartyRoles(row),
      isGuest: false,
      isArchived: !row.is_active || row.merged_into_id != null,
      fields: {
        name: row.name,
        phone: normPhone ?? row.phone ?? null,
        email: row.email ?? null,
        national_id: row.national_id ?? null,
        economic_code: row.economic_code ?? null,
        address: row.address ?? null,
        notes: row.notes ?? null,
      },
    };
    canonicalById.set(party.id, party);
    if (normPhone) push(candidatesByPhone, normPhone, party);
    if (normEmail) push(candidatesByEmail, normEmail, party);
    push(candidatesByName, normalizeNameKey(row.name), party);
  }

  return { mappings, canonicalById, candidatesByPhone, candidatesByEmail, candidatesByName };
}

export async function partyCanonicalToken(client: PoolClient, run: ReconciliationRun): Promise<string> {
  const { rows } = await client.query<{ token: string }>(
    `SELECT md5(
        (SELECT count(*)::text || ':' || COALESCE(max(updated_at)::text, '') FROM parties WHERE business_id = $1 AND merged_into_id IS NULL)
        || '|' ||
        (SELECT count(*)::text || ':' || COALESCE(max(updated_at)::text, '') FROM source_identities
          WHERE business_id = $1 AND domain = 'party')
     ) AS token`,
    [run.businessId],
  );
  return rows[0].token;
}

export interface StagePartiesOptions {
  policy?: FieldAuthorityPolicy;
  wholeRun?: readonly IncomingParty[];
}

export async function stageParties(
  businessId: string,
  runId: string,
  records: readonly IncomingParty[],
  options: StagePartiesOptions = {},
): Promise<StageResult> {
  const planned = await withTenantTransaction(businessId, async (client) => {
    const run = await loadRun(client, businessId, runId);
    if (run.domain !== "party") throw new ReconciliationError("domain_mismatch");
    const ctx = await loadPartyContext(client, run, records);
    const items = planParties(
      records,
      ctx,
      {
        policy: options.policy ?? DEFAULT_FIELD_AUTHORITY_POLICY,
        readCanonical: (id) => (ctx.canonicalById.get(id) as (CanonicalParty & { fields?: Record<string, unknown> }) | undefined)?.fields ?? null,
      },
      options.wholeRun ?? records,
    );
    const rejected = await loadRejectedEdits(client, businessId, run.sourceKey, "party", items.map((i) => i.externalKey));
    return suppressRejectedConflicts(items, rejected);
  });
  return stagePlannedItems(businessId, runId, planned);
}

export async function completePartyDiscovery(businessId: string, runId: string, actor: Actor): Promise<DiscoveryResult> {
  const { canonicalCount, canonicalToken } = await withTenantTransaction(businessId, async (client) => {
    const run = await loadRun(client, businessId, runId);
    if (run.domain !== "party") throw new ReconciliationError("domain_mismatch");
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM parties WHERE business_id = $1 AND merged_into_id IS NULL AND is_active`,
      [businessId],
    );
    return { canonicalCount: Number(rows[0].n), canonicalToken: await partyCanonicalToken(client, run) };
  });
  return completeDiscovery({ businessId, runId, canonicalCount, canonicalToken, actor });
}

export interface PartyHandlerOptions {
  mappingEntityType?: "customer" | "holoo_customer";
  onLink?: (ctx: ApplyContext) => Promise<void>;
  create?: ApplyHandler["create"];
}

export function createPartyApplyHandler(options: PartyHandlerOptions = {}): ApplyHandler {
  const mappingType = options.mappingEntityType ?? "customer";
  async function recordIdentity(ctx: ApplyContext, canonicalId: string): Promise<void> {
    if (ctx.item.externalKey.startsWith("row:")) return;
    await linkSourceIdentity(ctx.client, {
      businessId: ctx.run.businessId,
      domain: "party",
      sourceKey: ctx.run.sourceKey,
      provider: ctx.run.provider,
      externalType: ctx.item.externalType,
      externalId: ctx.item.externalKey,
      canonicalType: "parties",
      canonicalId,
      runId: ctx.run.id,
      linkedBy: ctx.actor.userId,
    });
    if (!ctx.run.connectionId) return;
    const { rows: existing } = await ctx.client.query<{ local_id: string }>(
      `SELECT local_id::text AS local_id FROM integration_mappings
        WHERE business_id = $1 AND connection_id = $2 AND entity_type = $3 AND remote_id = $4`,
      [ctx.run.businessId, ctx.run.connectionId, mappingType, ctx.item.externalKey],
    );
    if (existing[0] && existing[0].local_id !== canonicalId) {
      throw new ReconciliationError("identity_already_linked", { linkedTo: existing[0].local_id });
    }
    if (!existing[0]) {
      await upsertMappingOnClient(ctx.client, ctx.run.businessId, ctx.run.connectionId, mappingType, ctx.item.externalKey, canonicalId, null, false);
    }
  }

  return {
    domain: "party",
    async link(ctx) {
      const canonicalId = ctx.canonicalId as string;
      const { rows } = await ctx.client.query(
        `SELECT 1 FROM parties WHERE id::text = $1 AND business_id = $2 AND merged_into_id IS NULL`,
        [canonicalId, ctx.run.businessId],
      );
      if (!rows[0]) throw new ReconciliationError("link_target_not_found", { canonicalId });
      if (options.onLink) await options.onLink(ctx);
      await recordIdentity(ctx, canonicalId);
      return { canonicalId };
    },
    async create(ctx) {
      if (!options.create) throw new ReconciliationError("create_not_supported");
      const created = await options.create(ctx);
      await recordIdentity(ctx, created.canonicalId);
      return created;
    },
  };
}

// ---------------------------------------------------------------------------
// Financial document context, staging, discovery & apply handler
// ---------------------------------------------------------------------------

export async function loadFinancialDocumentContext(
  client: PoolClient,
  run: ReconciliationRun,
  records: readonly IncomingFinancialDocument[],
  options: { bookCurrency?: string } = {},
): Promise<FinancialDocumentContext> {
  const externalIds = records.map((r) => r.externalId).filter((id): id is string => id != null);
  const mappings = new Map<string, string>();
  if (externalIds.length > 0) {
    const { rows } = await client.query<{ external_id: string; canonical_id: string }>(
      `SELECT external_id, canonical_id FROM source_identities
        WHERE business_id = $1 AND source_key = $2 AND domain = 'financial_document'
          AND retired_at IS NULL AND verified AND external_id = ANY($3::text[])`,
      [run.businessId, run.sourceKey, externalIds],
    );
    for (const r of rows) mappings.set(r.external_id, r.canonical_id);
    if (run.connectionId) {
      const { rows: connRows } = await client.query<{ remote_id: string; local_id: string }>(
        `SELECT remote_id, local_id::text AS local_id FROM integration_mappings
          WHERE business_id = $1 AND connection_id = $2
            AND entity_type IN ('order', 'holoo_invoice', 'holoo_journal', 'holoo_purchase')
            AND remote_id = ANY($3::text[])`,
        [run.businessId, run.connectionId, externalIds],
      );
      for (const r of connRows) if (!mappings.has(r.remote_id)) mappings.set(r.remote_id, r.local_id);
    }
  }

  const canonicalById = new Map<string, CanonicalFinancialDocument>();
  const candidatesByReference = new Map<string, CanonicalFinancialDocument[]>();
  const candidatesByAmountDate = new Map<string, CanonicalFinancialDocument[]>();
  const registerDoc = (doc: CanonicalFinancialDocument) => {
    canonicalById.set(doc.id, doc);
    for (const ref of doc.references) {
      const key = normalizeReferenceKey(ref);
      if (!key) continue;
      const list = candidatesByReference.get(key) ?? [];
      if (!list.some((d) => d.id === doc.id)) list.push(doc);
      candidatesByReference.set(key, list);
    }
    const adKey = amountDateKey(doc.kind, doc.totalRial, doc.date);
    const list = candidatesByAmountDate.get(adKey) ?? [];
    if (!list.some((d) => d.id === doc.id)) list.push(doc);
    candidatesByAmountDate.set(adKey, list);
  };

  const refs = [
    ...new Set(records.flatMap((r) => r.references ?? []).map(normalizeReferenceKey).filter((k): k is string => k != null)),
  ];
  const dates = [...new Set(records.map((r) => r.date).filter((d): d is string => Boolean(d)))];
  const mappedIds = [...new Set(mappings.values())];
  const bookCurrency = options.bookCurrency ?? "IRR";

  // 1. Orders (+ online_order_documents when online)
  const { rows: orderRows } = await client.query<{
    id: string;
    order_number: string;
    total: string;
    date: string;
    remote_id: string | null;
    remote_number: string | null;
    source_type: string | null;
  }>(
    `SELECT o.id::text AS id, o.order_number::text AS order_number, o.total::text AS total,
            to_char((o.opened_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date,
            d.remote_id, d.remote_number, d.source_type
       FROM orders o
       JOIN locations l ON l.id = o.location_id
       LEFT JOIN online_order_documents d ON d.order_id = o.id
      WHERE l.business_id = $1
        AND ($2::uuid IS NULL OR o.location_id = $2::uuid)
        AND (
          o.id::text = ANY($3::text[])
          OR o.order_number::text = ANY($4::text[])
          OR d.remote_id = ANY($4::text[])
          OR d.remote_number = ANY($4::text[])
          OR to_char((o.opened_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') = ANY($5::text[])
        )
      LIMIT 500`,
    [run.businessId, run.locationId, mappedIds, refs, dates],
  );
  for (const r of orderRows) {
    registerDoc({
      id: r.id,
      kind: r.source_type ? "order" : "invoice",
      totalRial: r.total,
      currency: bookCurrency,
      date: r.date,
      references: [r.order_number, r.remote_id, r.remote_number].filter((v): v is string => Boolean(v)),
      origin: r.source_type ? "online" : "pos",
    });
  }

  // 2. Historical sales invoices
  const { rows: histRows } = await client.query<{
    id: string;
    external_id: string;
    invoice_number: string;
    total_rial: string;
    date: string;
  }>(
    `SELECT id::text AS id, external_id, invoice_number, total_rial::text AS total_rial,
            to_char(invoice_date, 'YYYY-MM-DD') AS date
       FROM historical_sales_invoices
      WHERE business_id = $1
        AND ($2::uuid IS NULL OR location_id = $2::uuid)
        AND (
          id::text = ANY($3::text[])
          OR external_id = ANY($4::text[])
          OR invoice_number = ANY($4::text[])
          OR to_char(invoice_date, 'YYYY-MM-DD') = ANY($5::text[])
        )
      LIMIT 500`,
    [run.businessId, run.locationId, mappedIds, refs, dates],
  );
  for (const r of histRows) {
    registerDoc({
      id: r.id,
      kind: "invoice",
      totalRial: r.total_rial,
      currency: bookCurrency,
      date: r.date,
      references: [r.external_id, r.invoice_number].filter(Boolean),
      origin: "imported",
    });
  }

  // 3. Journal entries (including manual entries!)
  const { rows: jeRows } = await client.query<{
    id: string;
    date: string;
    source_type: string | null;
    voucher_number: string | null;
    voucher_reference: string | null;
    total_debit: string;
  }>(
    `SELECT je.id::text AS id, to_char(je.entry_date, 'YYYY-MM-DD') AS date,
            je.source_type, je.voucher_number, je.voucher_reference,
            COALESCE(SUM(jl.debit), 0)::text AS total_debit
       FROM journal_entries je
       LEFT JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE je.business_id = $1
        AND (
          je.id::text = ANY($2::text[])
          OR je.voucher_number = ANY($3::text[])
          OR je.voucher_reference = ANY($3::text[])
          OR to_char(je.entry_date, 'YYYY-MM-DD') = ANY($4::text[])
        )
      GROUP BY je.id
      LIMIT 500`,
    [run.businessId, mappedIds, refs, dates],
  );
  for (const r of jeRows) {
    registerDoc({
      id: r.id,
      kind: "journal",
      totalRial: r.total_debit,
      currency: bookCurrency,
      date: r.date,
      references: [r.voucher_number, r.voucher_reference].filter((v): v is string => Boolean(v)),
      origin: r.source_type === "manual" ? "manual" : r.source_type === "holoo_import" ? "imported" : "pos",
    });
  }

  return { mappings, canonicalById, candidatesByReference, candidatesByAmountDate, bookCurrency };
}

export async function financialDocumentCanonicalToken(client: PoolClient, run: ReconciliationRun): Promise<string> {
  const { rows } = await client.query<{ token: string }>(
    `SELECT md5(
        (SELECT count(*)::text || ':' || COALESCE(max(o.opened_at)::text, '')
           FROM orders o JOIN locations l ON l.id = o.location_id
          WHERE l.business_id = $1 AND ($2::uuid IS NULL OR o.location_id = $2::uuid))
        || '|' ||
        (SELECT count(*)::text || ':' || COALESCE(max(posted_at)::text, '')
           FROM journal_entries WHERE business_id = $1)
        || '|' ||
        (SELECT count(*)::text || ':' || COALESCE(max(updated_at)::text, '')
           FROM source_identities WHERE business_id = $1 AND domain = 'financial_document')
     ) AS token`,
    [run.businessId, run.locationId],
  );
  return rows[0].token;
}

export async function stageFinancialDocuments(
  businessId: string,
  runId: string,
  records: readonly IncomingFinancialDocument[],
  options: { bookCurrency?: string } = {},
): Promise<StageResult> {
  const planned = await withTenantTransaction(businessId, async (client) => {
    const run = await loadRun(client, businessId, runId);
    if (run.domain !== "financial_document") throw new ReconciliationError("domain_mismatch");
    const ctx = await loadFinancialDocumentContext(client, run, records, options);
    return planFinancialDocuments(records, ctx);
  });
  return stagePlannedItems(businessId, runId, planned);
}

export async function completeFinancialDocumentDiscovery(
  businessId: string,
  runId: string,
  actor: Actor,
): Promise<DiscoveryResult> {
  const { canonicalCount, canonicalToken } = await withTenantTransaction(businessId, async (client) => {
    const run = await loadRun(client, businessId, runId);
    if (run.domain !== "financial_document") throw new ReconciliationError("domain_mismatch");
    const { rows } = await client.query<{ n: string }>(
      `SELECT (
          (SELECT count(*) FROM orders o JOIN locations l ON l.id = o.location_id
            WHERE l.business_id = $1 AND ($2::uuid IS NULL OR o.location_id = $2::uuid))
          + (SELECT count(*) FROM historical_sales_invoices WHERE business_id = $1)
          + (SELECT count(*) FROM journal_entries WHERE business_id = $1)
        )::text AS n`,
      [businessId, run.locationId],
    );
    return { canonicalCount: Number(rows[0].n), canonicalToken: await financialDocumentCanonicalToken(client, run) };
  });
  return completeDiscovery({ businessId, runId, canonicalCount, canonicalToken, actor });
}

export interface FinancialDocumentHandlerOptions {
  canonicalType?: "orders" | "historical_sales_invoices" | "journal_entries";
  mappingEntityType?: "order" | "holoo_invoice" | "holoo_journal" | "holoo_purchase";
  create?: ApplyHandler["create"];
}

export function createFinancialDocumentApplyHandler(
  options: FinancialDocumentHandlerOptions = {},
): ApplyHandler {
  const canonicalType = options.canonicalType ?? "orders";
  async function recordIdentity(ctx: ApplyContext, targetTable: string, canonicalId: string): Promise<void> {
    if (ctx.item.externalKey.startsWith("row:")) return;
    await linkSourceIdentity(ctx.client, {
      businessId: ctx.run.businessId,
      domain: "financial_document",
      sourceKey: ctx.run.sourceKey,
      provider: ctx.run.provider,
      externalType: ctx.item.externalType,
      externalId: ctx.item.externalKey,
      canonicalType: targetTable,
      canonicalId,
      runId: ctx.run.id,
      linkedBy: ctx.actor.userId,
    });
    if (!ctx.run.connectionId || !options.mappingEntityType) return;
    const { rows: existing } = await ctx.client.query<{ local_id: string }>(
      `SELECT local_id::text AS local_id FROM integration_mappings
        WHERE business_id = $1 AND connection_id = $2 AND entity_type = $3 AND remote_id = $4`,
      [ctx.run.businessId, ctx.run.connectionId, options.mappingEntityType, ctx.item.externalKey],
    );
    if (existing[0] && existing[0].local_id !== canonicalId) {
      throw new ReconciliationError("identity_already_linked", { linkedTo: existing[0].local_id });
    }
    if (!existing[0]) {
      await upsertMappingOnClient(ctx.client, ctx.run.businessId, ctx.run.connectionId, options.mappingEntityType, ctx.item.externalKey, canonicalId, null, false);
    }
  }

  return {
    domain: "financial_document",
    async link(ctx) {
      const canonicalId = ctx.canonicalId as string;
      const { rows: found } = await ctx.client.query<{ tbl: string }>(
        `SELECT 'orders' AS tbl FROM orders o JOIN locations l ON l.id = o.location_id
          WHERE o.id::text = $1 AND l.business_id = $2
         UNION ALL
         SELECT 'historical_sales_invoices' AS tbl FROM historical_sales_invoices
          WHERE id::text = $1 AND business_id = $2
         UNION ALL
         SELECT 'journal_entries' AS tbl FROM journal_entries
          WHERE id::text = $1 AND business_id = $2
         LIMIT 1`,
        [canonicalId, ctx.run.businessId],
      );
      if (!found[0]) throw new ReconciliationError("link_target_not_found", { canonicalId });
      await recordIdentity(ctx, found[0].tbl, canonicalId);
      return { canonicalId };
    },
    async create(ctx) {
      if (!options.create) throw new ReconciliationError("create_not_supported");
      const created = await options.create(ctx);
      await recordIdentity(ctx, canonicalType, created.canonicalId);
      return created;
    },
  };
}

// ---------------------------------------------------------------------------
// Inventory context, staging, discovery & apply handler
// ---------------------------------------------------------------------------

export async function loadInventoryContext(
  client: PoolClient,
  run: ReconciliationRun,
  records: readonly IncomingInventory[],
): Promise<Omit<InventoryContext, "incomingSnapshotCounts">> {
  if (!run.locationId) throw new ReconciliationError("location_required");
  const productExternalIds = [...new Set(records.map((r) => r.productExternalId).filter((id): id is string => Boolean(id)))];
  const productLinks = new Map<string, string>();
  if (productExternalIds.length > 0) {
    const relatedSourceKeys = run.connectionId
      ? [run.sourceKey, `holoo:${run.connectionId}:goods`, run.connectionId]
      : [run.sourceKey];
    const { rows } = await client.query<{ external_id: string; canonical_id: string }>(
      `SELECT external_id, canonical_id FROM source_identities
        WHERE business_id = $1 AND source_key = ANY($2::text[]) AND domain = 'product'
          AND retired_at IS NULL AND verified AND external_id = ANY($3::text[])`,
      [run.businessId, relatedSourceKeys, productExternalIds],
    );
    for (const r of rows) productLinks.set(r.external_id, r.canonical_id);
    if (run.connectionId) {
      const { rows: connRows } = await client.query<{ remote_id: string; local_id: string }>(
        `SELECT remote_id, local_id::text AS local_id FROM integration_mappings
          WHERE business_id = $1 AND connection_id = $2
            AND entity_type IN ('product', 'holoo_goods')
            AND remote_id = ANY($3::text[])`,
        [run.businessId, run.connectionId, productExternalIds],
      );
      for (const r of connRows) if (!productLinks.has(r.remote_id)) productLinks.set(r.remote_id, r.local_id);
    }
  }

  const productIds = [...new Set(productLinks.values())];
  const stockByProduct = new Map<string, CanonicalStock>();
  if (productIds.length > 0) {
    const { rows: bizRows } = await client.query<{ industry: string }>(`SELECT industry FROM businesses WHERE id = $1`, [run.businessId]);
    const industry = bizRows[0]?.industry;
    if (isRetailCatalogueIndustry(industry)) {
      const { rows } = await client.query<{
        id: string;
        kind: string;
        tracking: CanonicalStock["tracking"];
        quantity: string | null;
      }>(
        `SELECT i.id::text AS id, i.kind, i.tracking, s.quantity::text AS quantity
           FROM items i
           LEFT JOIN item_stock s ON s.item_id = i.id
          WHERE i.location_id = $1 AND i.id::text = ANY($2::text[])`,
        [run.locationId, productIds],
      );
      for (const r of rows) {
        stockByProduct.set(r.id, {
          productId: r.id,
          managed: r.kind !== "variant_parent",
          quantity: r.quantity,
          tracking: r.tracking ?? "none",
        });
      }
    } else if (industry === "food_service") {
      const { rows } = await client.query<{ id: string; quantity: string | null }>(
        `SELECT ii.id::text AS id,
                (SELECT COALESCE(SUM(sm.quantity), 0)::text FROM stock_movements sm
                  WHERE sm.inventory_item_id = ii.id AND sm.location_id = $1) AS quantity
           FROM inventory_items ii
          WHERE ii.location_id = $1 AND ii.id::text = ANY($2::text[])`,
        [run.locationId, productIds],
      );
      for (const r of rows) {
        stockByProduct.set(r.id, {
          productId: r.id,
          managed: true,
          quantity: r.quantity,
          tracking: "none",
        });
      }
    }
  }

  const movementIds = records.filter((r) => r.kind === "movement" && r.externalId).map((r) => r.externalId as string);
  const appliedMovementIds = new Set<string>();
  if (movementIds.length > 0) {
    const { rows } = await client.query<{ external_id: string }>(
      `SELECT external_id FROM source_identities
        WHERE business_id = $1 AND source_key = $2 AND domain = 'inventory'
          AND external_type = 'movement' AND retired_at IS NULL AND external_id = ANY($3::text[])`,
      [run.businessId, run.sourceKey, movementIds],
    );
    for (const r of rows) appliedMovementIds.add(r.external_id);
  }

  return { productLinks, stockByProduct, appliedMovementIds };
}

export async function inventoryCanonicalToken(client: PoolClient, run: ReconciliationRun): Promise<string> {
  const { rows: bizRows } = await client.query<{ industry: string }>(`SELECT industry FROM businesses WHERE id = $1`, [run.businessId]);
  const industry = bizRows[0]?.industry;
  if (isRetailCatalogueIndustry(industry)) {
    const { rows } = await client.query<{ token: string }>(
      `SELECT md5(
          (SELECT count(*)::text || ':' || COALESCE(max(s.updated_at)::text, '')
             FROM item_stock s JOIN items i ON i.id = s.item_id WHERE i.location_id = $1)
          || '|' ||
          (SELECT count(*)::text || ':' || COALESCE(max(updated_at)::text, '')
             FROM source_identities WHERE business_id = $2 AND domain = 'inventory')
       ) AS token`,
      [run.locationId, run.businessId],
    );
    return rows[0].token;
  }
  const { rows } = await client.query<{ token: string }>(
    `SELECT md5(
        (SELECT count(*)::text || ':' || COALESCE(max(occurred_at)::text, '')
           FROM stock_movements WHERE location_id = $1)
        || '|' ||
        (SELECT count(*)::text || ':' || COALESCE(max(updated_at)::text, '')
           FROM source_identities WHERE business_id = $2 AND domain = 'inventory')
     ) AS token`,
    [run.locationId, run.businessId],
  );
  return rows[0].token;
}

export async function stageInventory(
  businessId: string,
  runId: string,
  records: readonly IncomingInventory[],
  options: { wholeRun?: readonly IncomingInventory[] } = {},
): Promise<StageResult> {
  const planned = await withTenantTransaction(businessId, async (client) => {
    const run = await loadRun(client, businessId, runId);
    if (run.domain !== "inventory") throw new ReconciliationError("domain_mismatch");
    const ctx = await loadInventoryContext(client, run, records);
    return planInventory(records, ctx, undefined, options.wholeRun ?? records);
  });
  return stagePlannedItems(businessId, runId, planned);
}

export async function completeInventoryDiscovery(
  businessId: string,
  runId: string,
  actor: Actor,
): Promise<DiscoveryResult> {
  const { canonicalCount, canonicalToken } = await withTenantTransaction(businessId, async (client) => {
    const run = await loadRun(client, businessId, runId);
    if (run.domain !== "inventory") throw new ReconciliationError("domain_mismatch");
    const { rows: bizRows } = await client.query<{ industry: string }>(`SELECT industry FROM businesses WHERE id = $1`, [businessId]);
    const isRetail = isRetailCatalogueIndustry(bizRows[0]?.industry);
    const { rows } = isRetail
      ? await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM item_stock s JOIN items i ON i.id = s.item_id
            WHERE i.location_id = $1 AND s.quantity <> 0`,
          [run.locationId],
        )
      : await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM stock_movements WHERE location_id = $1`,
          [run.locationId],
        );
    return { canonicalCount: Number(rows[0].n), canonicalToken: await inventoryCanonicalToken(client, run) };
  });
  return completeDiscovery({ businessId, runId, canonicalCount, canonicalToken, actor });
}

export function createInventoryApplyHandler(options: {
  canonicalType?: "items" | "inventory_items";
  link?: ApplyHandler["link"];
  create?: ApplyHandler["create"];
} = {}): ApplyHandler {
  async function resolveCanonicalType(ctx: ApplyContext): Promise<"items" | "inventory_items"> {
    if (options.canonicalType) return options.canonicalType;
    const { rows } = await ctx.client.query<{ industry: string }>(
      `SELECT industry FROM businesses WHERE id = $1`,
      [ctx.run.businessId],
    );
    return rows[0]?.industry === "food_service" ? "inventory_items" : "items";
  }

  return {
    domain: "inventory",
    async link(ctx) {
      if (options.link) return options.link(ctx);
      if (!ctx.canonicalId) throw new ReconciliationError("link_target_missing");
      const canonicalType = await resolveCanonicalType(ctx);
      if (!ctx.item.externalKey.startsWith("row:")) {
        await linkSourceIdentity(ctx.client, {
          businessId: ctx.run.businessId,
          domain: "inventory",
          sourceKey: ctx.run.sourceKey,
          provider: ctx.run.provider,
          externalType: ctx.item.externalType,
          externalId: ctx.item.externalKey,
          canonicalType,
          canonicalId: ctx.canonicalId,
          runId: ctx.run.id,
          linkedBy: ctx.actor.userId,
        });
      }
      return { canonicalId: ctx.canonicalId };
    },
    async create(ctx) {
      if (!options.create) throw new ReconciliationError("create_not_supported");
      const created = await options.create(ctx);
      const canonicalType = await resolveCanonicalType(ctx);
      if (!ctx.item.externalKey.startsWith("row:")) {
        await linkSourceIdentity(ctx.client, {
          businessId: ctx.run.businessId,
          domain: "inventory",
          sourceKey: ctx.run.sourceKey,
          provider: ctx.run.provider,
          externalType: ctx.item.externalType,
          externalId: ctx.item.externalKey,
          canonicalType,
          canonicalId: created.canonicalId,
          runId: ctx.run.id,
          linkedBy: ctx.actor.userId,
        });
      }
      return created;
    },
  };
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
    const table = await catalogueTableFor(client, businessId, run);
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

export interface ListRunsFilter {
  domain?: ReconciliationDomain;
  connectionId?: string;
  sourceKey?: string;
  activeOnly?: boolean;
  limit?: number;
}

export async function listRuns(businessId: string, filter: ListRunsFilter = {}): Promise<ReconciliationRun[]> {
  return withTenantTransaction(businessId, async (client) => {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const { rows } = await client.query(
      `SELECT * FROM import_reconciliation_runs
        WHERE business_id = $1
          AND ($2::text IS NULL OR domain = $2)
          AND ($3::uuid IS NULL OR connection_id = $3::uuid)
          AND ($4::text IS NULL OR source_key = $4)
          AND (NOT $5::boolean OR status IN ('discovering', 'staged', 'in_review', 'applying', 'stale'))
        ORDER BY created_at DESC
        LIMIT $6`,
      [
        businessId,
        filter.domain ?? null,
        filter.connectionId ?? null,
        filter.sourceKey ?? null,
        filter.activeOnly ?? false,
        limit,
      ],
    );
    return rows.map(mapRun);
  });
}

export async function setRunCutoverPolicy(
  businessId: string,
  runId: string,
  input: {
    cutoverAuthority: CutoverAuthority;
    cutoverAt?: string | null;
    policySnapshot?: Record<string, unknown>;
  },
  actor: Actor,
): Promise<ReconciliationRun> {
  return withTenantTransaction(businessId, async (client) => {
    const run = await loadRun(client, businessId, runId, true);
    if (run.status === "applied" || run.status === "cancelled") {
      throw new ReconciliationError("run_closed", { status: run.status });
    }
    await client.query(
      `UPDATE import_reconciliation_runs
          SET cutover_authority = $3,
              cutover_at = $4::timestamptz,
              policy_snapshot = COALESCE($5::jsonb, policy_snapshot),
              updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [
        runId,
        businessId,
        input.cutoverAuthority,
        input.cutoverAt ?? new Date().toISOString(),
        input.policySnapshot ? JSON.stringify(input.policySnapshot) : null,
      ],
    );
    await audit(client, businessId, actor, "reconciliation.cutover.updated", runId, {
      cutoverAuthority: input.cutoverAuthority,
      cutoverAt: input.cutoverAt ?? null,
    });
    return loadRun(client, businessId, runId);
  });
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
    if (input.decision === "choose_authority" && input.authorityOverrides) {
      const conflicts = item.conflicts as FieldConflict[];
      for (const [field, owner] of Object.entries(input.authorityOverrides)) {
        if (owner !== "canonical") continue;
        const conflict = conflicts.find((c) => c.field === field);
        await recordRejectedRemoteEdit(client, {
          businessId: input.businessId,
          sourceKey: run.sourceKey,
          domain: run.domain,
          externalType: item.externalType,
          externalId: item.externalKey,
          field,
          value: conflict?.incoming ?? null,
          reason,
          actor: input.actor,
        });
      }
    }
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
  /** Per-record field authority overrides from the latest decision, if any. */
  authorityOverrides: FieldAuthorityOverrides;
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
  maxPreviewAgeMs?: number;
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
  const check = await revalidateRun(businessId, runId, options.current, { maxAgeMs: options.maxPreviewAgeMs });
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
        let authorityOverrides: FieldAuthorityOverrides = {};
        if (row.last_decision_id) {
          const { rows: dRows } = await client.query<{ authority_overrides: FieldAuthorityOverrides | null }>(
            `SELECT authority_overrides FROM import_reconciliation_decisions WHERE id = $1::uuid AND business_id = $2`,
            [row.last_decision_id, businessId],
          );
          authorityOverrides = dRows[0]?.authority_overrides ?? {};
        }
        await client.query("SAVEPOINT reconciliation_item");
        try {
          const ctx: ApplyContext = {
            client,
            run,
            item,
            canonicalId: item.canonicalId,
            authorityOverrides,
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
      const table = await catalogueTableFor(ctx.client, ctx.run.businessId, ctx.run);
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
      await recordIdentity(ctx, await catalogueTableFor(ctx.client, ctx.run.businessId, ctx.run), created.canonicalId);
      return created;
    },
  };
}

export type { Resolution };
