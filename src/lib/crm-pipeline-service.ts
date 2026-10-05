/**
 * Configurable sales pipelines and stages.
 *
 * ## What this replaces
 *
 * Stages used to be a `CHECK` constraint listing six strings. That works until
 * the first business says "we have a site-visit stage", at which point the
 * options are a migration per customer or nothing. Stages are now rows.
 *
 * The old `crm_deals.stage` **text column still exists and is still written**.
 * That is deliberate, not laziness: every pre-0157 query reads it, persisted
 * filters and saved reports name it, and dropping it to satisfy tidiness would
 * be a destructive change with no user-visible benefit. `stage_id` is the truth
 * for new code; `stage` is kept in step by `legacyStageKey` below so both
 * readers agree.
 *
 * ## Outcome, not name
 *
 * Reporting keys on `outcome` (`open` / `won` / `lost`), never on a stage's
 * name. A business renaming «برنده» to «قرارداد نهایی شد» keeps its win rate,
 * and a business with three different "lost" stages (lost to price, lost to a
 * competitor, went quiet) gets them all counted as losses.
 *
 * ## Won posts nothing
 *
 * Moving a deal to a `won` stage writes no journal line, no invoice and no
 * order. A pipeline is a *forecast*; revenue exists when there is a sales
 * document. Wiring "won" to the ledger would let anyone with CRM access
 * fabricate revenue by dragging a card, and would double-count the moment the
 * real invoice was issued. The handoff is explicit and separate — see
 * `crm-deal-handoff.ts`.
 */

import { query, withTenant, withTenantTransaction } from "./db";
import { recordCrmAudit } from "./crm-audit-service";
import { runCrmAutomations } from "./crm-automation-service";
import type { CrmAutomationEntity } from "./crm-automation-rules";
import { isUuid } from "./uuid";

export type StageOutcome = "open" | "won" | "lost";

export interface PipelineStage extends Record<string, unknown> {
  id: string;
  pipelineId: string;
  name: string;
  legacyKey: string | null;
  displayOrder: number;
  defaultProbability: number;
  outcome: StageOutcome;
  isActive: boolean;
  requirementNote: string;
}

/**
 * A pipeline without its stages — the row shape as it comes back from SQL.
 * Split out because `Omit<Pipeline, "stages">` over a type carrying an index
 * signature erases the named fields along with the omitted one.
 */
export interface PipelineRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  displayOrder: number;
  archivedAt: string | null;
}

export interface Pipeline extends PipelineRow {
  stages: PipelineStage[];
}

const STAGE_COLUMNS = `id, pipeline_id AS "pipelineId", name, legacy_key AS "legacyKey",
  display_order AS "displayOrder", default_probability AS "defaultProbability",
  outcome, is_active AS "isActive", requirement_note AS "requirementNote"`;

/**
 * Every pipeline with its stages, in one round trip.
 *
 * Two queries rather than a join with a row per stage: the board renders
 * pipelines and stages as separate structures anyway, and a join here would
 * repeat each pipeline's fields once per stage for no benefit.
 */
export async function listPipelines(
  businessId: string,
  options: { includeArchived?: boolean } = {},
): Promise<Pipeline[]> {
  const { rows: pipelines } = await query<PipelineRow>(
    `SELECT id, name, description, is_default AS "isDefault",
            display_order AS "displayOrder", archived_at AS "archivedAt"
       FROM crm_pipelines
      WHERE business_id = $1 ${options.includeArchived ? "" : "AND archived_at IS NULL"}
      ORDER BY is_default DESC, display_order, name`,
    [businessId],
  );
  if (pipelines.length === 0) return [];

  const { rows: stages } = await query<PipelineStage>(
    `SELECT ${STAGE_COLUMNS} FROM crm_pipeline_stages
      WHERE business_id = $1 AND pipeline_id = ANY($2::uuid[])
      ORDER BY display_order, name`,
    [businessId, pipelines.map((pipeline) => pipeline.id)],
  );

  const byPipeline = new Map<string, PipelineStage[]>();
  for (const stage of stages) {
    const list = byPipeline.get(stage.pipelineId) ?? [];
    list.push(stage);
    byPipeline.set(stage.pipelineId, list);
  }
  return pipelines.map((pipeline) => ({ ...pipeline, stages: byPipeline.get(pipeline.id) ?? [] }));
}

/**
 * The stages every business starts with.
 *
 * The same six the pre-0157 `CHECK` constraint allowed, with the same
 * `legacy_key` values, so a freshly provisioned business and an upgraded one
 * have structurally identical pipelines. Anything else would mean two code
 * paths to test and a subtle difference nobody notices until a report
 * disagrees between two tenants.
 */
const SEED_STAGES: readonly {
  name: string;
  legacyKey: string;
  displayOrder: number;
  probability: number;
  outcome: StageOutcome;
}[] = [
  { name: "سرنخ", legacyKey: "lead", displayOrder: 1, probability: 10, outcome: "open" },
  { name: "واجد شرایط", legacyKey: "qualified", displayOrder: 2, probability: 30, outcome: "open" },
  { name: "پیشنهاد", legacyKey: "proposal", displayOrder: 3, probability: 55, outcome: "open" },
  { name: "مذاکره", legacyKey: "negotiation", displayOrder: 4, probability: 75, outcome: "open" },
  { name: "برنده", legacyKey: "won", displayOrder: 5, probability: 100, outcome: "won" },
  { name: "بازنده", legacyKey: "lost", displayOrder: 6, probability: 0, outcome: "lost" },
];

/**
 * The pipeline a new deal lands in, creating the default one if it is missing.
 *
 * ## Why this self-heals rather than trusting provisioning
 *
 * Migration 0157 seeds a pipeline for every business that existed when it ran.
 * Businesses created *afterwards* get one only if every provisioning path
 * remembers to — and there are three of them (`business-provisioning`,
 * `pairing-apply`, `platform-service`), with nothing stopping a fourth. A
 * business with no pipeline cannot open the deals board at all, which is a
 * total failure of the feature caused by an omission nobody would notice until
 * a customer reported it.
 *
 * So the read path creates what it needs. `ON CONFLICT DO NOTHING` against the
 * `(business_id, name)` unique constraint makes it safe under concurrency: two
 * simultaneous first-loads produce one pipeline, not two, and the loser of the
 * race simply reads what the winner wrote.
 */
export async function defaultPipeline(businessId: string): Promise<Pipeline | null> {
  const existing = await listPipelines(businessId);
  const found = existing.find((pipeline) => pipeline.isDefault) ?? existing[0];
  // A pipeline with no stages is as unusable as no pipeline — seed those too,
  // rather than handing the board an empty column list.
  if (found && found.stages.length > 0) return found;

  return withTenant(businessId, async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO crm_pipelines (business_id, name, description, is_default, display_order, created_by)
       VALUES ($1, 'قیف فروش پیش‌فرض', 'مراحل استاندارد فروش', true, 0, 'system')
       ON CONFLICT (business_id, name) DO NOTHING
       RETURNING id`,
      [businessId],
    );
    // No row back means another request won the race (or the pipeline existed
    // but had no stages); either way, read the id rather than failing.
    let pipelineId = rows[0]?.id;
    if (!pipelineId) {
      const { rows: again } = await query<{ id: string }>(
        `SELECT id FROM crm_pipelines
          WHERE business_id = $1 AND archived_at IS NULL
          ORDER BY is_default DESC, display_order LIMIT 1`,
        [businessId],
      );
      pipelineId = again[0]?.id;
      if (!pipelineId) return null;
    }

    for (const stage of SEED_STAGES) {
      await query(
        `INSERT INTO crm_pipeline_stages
           (business_id, pipeline_id, name, legacy_key, display_order, default_probability, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (pipeline_id, name) DO NOTHING`,
        [
          businessId,
          pipelineId,
          stage.name,
          stage.legacyKey,
          stage.displayOrder,
          stage.probability,
          stage.outcome,
        ],
      );
    }

    const seeded = await listPipelines(businessId);
    return seeded.find((pipeline) => pipeline.id === pipelineId) ?? null;
  });
}

export async function getStage(businessId: string, stageId: string): Promise<PipelineStage | null> {
  if (!isUuid(stageId)) return null;
  const { rows } = await query<PipelineStage>(
    `SELECT ${STAGE_COLUMNS} FROM crm_pipeline_stages WHERE business_id = $1 AND id = $2`,
    [businessId, stageId],
  );
  return rows[0] ?? null;
}

/**
 * The value to write into the legacy `crm_deals.stage` text column.
 *
 * A seeded stage carries the exact string the old CHECK allowed. A stage a
 * business invented has no legacy equivalent, so it reports its *outcome* —
 * `open` collapses to `lead`, which is the only honest answer the old
 * vocabulary can give about a custom stage. The alternative, writing the
 * custom name, would break every consumer that still compares against the six
 * known strings.
 */
export function legacyStageKey(stage: Pick<PipelineStage, "legacyKey" | "outcome">): string {
  if (stage.legacyKey) return stage.legacyKey;
  if (stage.outcome === "won") return "won";
  if (stage.outcome === "lost") return "lost";
  return "lead";
}

export interface SaveStageInput {
  id?: string;
  name: string;
  displayOrder?: number;
  defaultProbability?: number;
  outcome?: StageOutcome;
  isActive?: boolean;
  requirementNote?: string;
}

/**
 * Replace a pipeline's stage list in one transaction.
 *
 * Exposed at the service layer only for now — no API route serves it (the
 * stage-configurator UI was never built; the board runs on the seeded six),
 * and the integration suite pins its rules. A route that returns should sit
 * behind `crm.configure` like the configuration it is.
 *
 * Whole-list rather than per-stage, because ordering is a property of the set:
 * saving stages one at a time means the board is briefly in an order nobody
 * chose, and two people reordering at once interleave into nonsense.
 *
 * ## The rules that protect existing deals
 *
 * - A stage that still holds deals **cannot be deleted**. Deleting it would
 *   leave those deals stageless — invisible on every board, excluded from
 *   every forecast, and discoverable only by someone querying SQL. Deactivate
 *   instead: the stage stops being offered but its deals stay where they are.
 * - A pipeline must keep at least one `open` stage and at least one `won`
 *   stage. Without an open stage no deal can be created; without a won stage a
 *   deal can never be closed successfully and the win rate is structurally
 *   zero.
 */
export async function savePipelineStages(
  businessId: string,
  pipelineId: string,
  stages: SaveStageInput[],
  actor: { name: string; userId?: string | null },
): Promise<{ pipeline: Pipeline | null; error?: string; blocking?: string[] }> {
  if (!isUuid(pipelineId)) return { pipeline: null, error: "not_found" };

  const cleaned = stages
    .map((stage, index) => ({
      id: stage.id && isUuid(stage.id) ? stage.id : undefined,
      name: stage.name.trim(),
      displayOrder: Number.isFinite(stage.displayOrder) ? Number(stage.displayOrder) : index + 1,
      defaultProbability: Math.min(Math.max(Math.round(stage.defaultProbability ?? 0), 0), 100),
      outcome: (["open", "won", "lost"] as const).includes(stage.outcome as StageOutcome)
        ? (stage.outcome as StageOutcome)
        : ("open" as StageOutcome),
      isActive: stage.isActive !== false,
      requirementNote: (stage.requirementNote ?? "").trim().slice(0, 300),
    }))
    .filter((stage) => stage.name.length > 0);

  if (cleaned.length === 0) return { pipeline: null, error: "stages_required" };
  if (!cleaned.some((stage) => stage.outcome === "open")) {
    return { pipeline: null, error: "open_stage_required" };
  }
  if (!cleaned.some((stage) => stage.outcome === "won")) {
    return { pipeline: null, error: "won_stage_required" };
  }
  // Two stages with one name make the board ambiguous and the unique index
  // would reject it anyway — catching it here gives a usable error instead of
  // a constraint violation.
  const names = cleaned.map((stage) => stage.name);
  if (new Set(names).size !== names.length) return { pipeline: null, error: "duplicate_stage_name" };

  // Transactional: the stage list is read FOR UPDATE and then rewritten, so
  // two people reordering at once must not interleave into a board neither of
  // them chose.
  const result = await withTenantTransaction(businessId, async () => {
    const { rows: existing } = await query<{ id: string; name: string; legacy_key: string | null }>(
      `SELECT id, name, legacy_key FROM crm_pipeline_stages
        WHERE business_id = $1 AND pipeline_id = $2 FOR UPDATE`,
      [businessId, pipelineId],
    );
    if (existing.length === 0) {
      const { rows: owned } = await query<{ id: string }>(
        `SELECT id FROM crm_pipelines WHERE business_id = $1 AND id = $2`,
        [businessId, pipelineId],
      );
      if (!owned[0]) return { error: "not_found" as const };
    }

    const keptIds = new Set(cleaned.map((stage) => stage.id).filter(Boolean) as string[]);
    const removed = existing.filter((stage) => !keptIds.has(stage.id));

    if (removed.length > 0) {
      const { rows: inUse } = await query<{ stage_id: string; count: string }>(
        `SELECT stage_id, count(*)::text AS count FROM crm_deals
          WHERE business_id = $1 AND stage_id = ANY($2::uuid[])
          GROUP BY stage_id`,
        [businessId, removed.map((stage) => stage.id)],
      );
      if (inUse.length > 0) {
        const blocking = removed
          .filter((stage) => inUse.some((row) => row.stage_id === stage.id))
          .map((stage) => stage.name);
        return { error: "stage_in_use" as const, blocking };
      }
      await query(
        `DELETE FROM crm_pipeline_stages WHERE business_id = $1 AND id = ANY($2::uuid[])`,
        [businessId, removed.map((stage) => stage.id)],
      );
    }

    for (const stage of cleaned) {
      if (stage.id && existing.some((row) => row.id === stage.id)) {
        await query(
          `UPDATE crm_pipeline_stages
              SET name = $3, display_order = $4, default_probability = $5,
                  outcome = $6, is_active = $7, requirement_note = $8, updated_at = now()
            WHERE business_id = $1 AND id = $2`,
          [
            businessId,
            stage.id,
            stage.name,
            stage.displayOrder,
            stage.defaultProbability,
            stage.outcome,
            stage.isActive,
            stage.requirementNote,
          ],
        );
      } else {
        await query(
          `INSERT INTO crm_pipeline_stages
             (business_id, pipeline_id, name, display_order, default_probability,
              outcome, is_active, requirement_note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            businessId,
            pipelineId,
            stage.name,
            stage.displayOrder,
            stage.defaultProbability,
            stage.outcome,
            stage.isActive,
            stage.requirementNote,
          ],
        );
      }
    }
    return { error: undefined };
  });

  if (result.error) return { pipeline: null, error: result.error };

  await recordCrmAudit({
    businessId,
    kind: "pipeline.stages_changed",
    entityType: "pipeline",
    entityId: pipelineId,
    summary: "مراحل قیف فروش تغییر کرد",
    detail: { pipelineId, stages: cleaned.map((stage) => stage.name) },
    actorUserId: actor.userId ?? null,
    actorName: actor.name,
  });

  const pipelines = await listPipelines(businessId, { includeArchived: true });
  return { pipeline: pipelines.find((pipeline) => pipeline.id === pipelineId) ?? null };
}

export interface StageMoveResult {
  ok: boolean;
  error?: "not_found" | "stage_not_found" | "same_stage";
  /** Seconds the deal spent in the stage it just left — null on first entry. */
  secondsInPreviousStage?: number | null;
}

/**
 * Move a deal to a stage, recording the transition.
 *
 * Every move writes a `crm_deal_stage_history` row: from, to, who, when, and
 * how long the deal sat where it was. Recorded rather than derived, because
 * the *sequence* is what velocity reporting needs and a current-state column
 * cannot reconstruct a path. It also answers the question a sales manager
 * actually asks — "where do deals stall?" — which no snapshot can.
 *
 * Stage names are snapshotted onto the history row alongside the ids, so the
 * history stays readable after a stage is renamed or archived.
 *
 * **Writes nothing to the ledger, on any stage, including won.** See the file
 * comment.
 */
export async function moveDealToStage(
  businessId: string,
  dealId: string,
  stageId: string,
  actor: { name: string; userId?: string | null },
  options: { note?: string; lostReason?: string; wonReason?: string } = {},
): Promise<StageMoveResult> {
  if (!isUuid(dealId) || !isUuid(stageId)) return { ok: false, error: "not_found" };

  /**
   * What the move did, handed to the automations that watch stage changes.
   *
   * Captured inside the transaction and used **after** it commits, because the
   * engine writes outside it on purpose: a rule's failure must not roll back
   * the salesperson's drag, and a failed statement in here would poison the
   * transaction for everything after it (`crm-automation-service.ts`).
   */
  let moved: CrmAutomationEntity | null = null;

  // The deal is locked, read, updated and given a history row — all or
  // nothing, and the lock has to survive between those statements.
  const result = await withTenantTransaction(businessId, async () => {
    const { rows: dealRows } = await query<{
      id: string;
      stage_id: string | null;
      stage_entered_at: string | null;
      customer_id: string | null;
      title: string;
      pipeline_id: string | null;
      value_rial: string;
      owner_user: string;
      owner_user_id: string | null;
    }>(
      `SELECT id, stage_id, stage_entered_at, customer_id, title, pipeline_id,
              value_rial, owner_user, owner_user_id
         FROM crm_deals WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [businessId, dealId],
    );
    const deal = dealRows[0];
    if (!deal) return { ok: false, error: "not_found" as const };

    const target = await getStage(businessId, stageId);
    if (!target) return { ok: false, error: "stage_not_found" as const };
    // Moving a deal onto the stage it is already in is a no-op, not an error
    // worth surfacing — but it must not write a history row, or a board that
    // re-saves on every render would bury the real transitions.
    if (deal.stage_id === stageId) return { ok: true, secondsInPreviousStage: null };

    const previous = deal.stage_id ? await getStage(businessId, deal.stage_id) : null;
    const secondsInPrevious = deal.stage_entered_at
      ? Math.max(0, Math.round((Date.now() - new Date(deal.stage_entered_at).getTime()) / 1000))
      : null;

    const terminal = target.outcome !== "open";
    await query(
      `UPDATE crm_deals
          SET stage_id = $3,
              pipeline_id = COALESCE(pipeline_id, $4),
              stage = $5,
              stage_entered_at = now(),
              last_activity_at = now(),
              lost_reason = CASE WHEN $6 = 'lost' THEN $7 ELSE NULL END,
              won_reason = CASE WHEN $6 = 'won' THEN $8 ELSE NULL END,
              closed_at = CASE WHEN $9 THEN COALESCE(closed_at, now()) ELSE NULL END,
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        businessId,
        dealId,
        stageId,
        target.pipelineId,
        // Keep the legacy text column in step — see legacyStageKey.
        legacyStageKey(target),
        target.outcome,
        options.lostReason?.trim() || null,
        options.wonReason?.trim() || null,
        terminal,
      ],
    );

    await query(
      `INSERT INTO crm_deal_stage_history
         (business_id, deal_id, from_stage_id, to_stage_id, from_stage_name, to_stage_name,
          seconds_in_from_stage, changed_by_id, changed_by, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        businessId,
        dealId,
        previous?.id ?? null,
        target.id,
        previous?.name ?? "",
        target.name,
        secondsInPrevious,
        actor.userId ?? null,
        actor.name,
        options.note?.trim() ?? "",
      ],
    );

    await recordCrmAudit({
      businessId,
      kind: "deal.stage_changed",
      entityType: "deal",
      entityId: dealId,
      partyId: deal.customer_id,
      summary: `«${deal.title}» به مرحلهٔ «${target.name}» رفت`,
      detail: {
        from: previous?.name ?? null,
        to: target.name,
        outcome: target.outcome,
        secondsInPreviousStage: secondsInPrevious,
        // Stated explicitly in the audit trail so an auditor reading it can
        // see that winning a deal moved no money.
        postedToLedger: false,
      },
      actorUserId: actor.userId ?? null,
      actorName: actor.name,
    });

    moved = {
      type: "deal",
      id: dealId,
      title: deal.title,
      partyId: deal.customer_id,
      valueRial: Number(deal.value_rial ?? 0),
      stageLabel: target.name,
      ownerUserId: deal.owner_user_id,
      ownerName: deal.owner_user,
    };

    return { ok: true, secondsInPreviousStage: secondsInPrevious };
  });

  // A drag that ended where it started returned before setting `moved` — a
  // no-op is not an event, and a rule must not fire for it.
  if (result.ok && moved) {
    await runCrmAutomations(businessId, { trigger: "deal_stage_changed", entity: moved, actor });
  }
  return result;
}

export interface StageHistoryEntry extends Record<string, unknown> {
  id: string;
  fromStageName: string;
  toStageName: string;
  secondsInFromStage: number | null;
  changedBy: string;
  note: string;
  createdAt: string;
}

/** One deal's stage history, oldest first — it reads as a story. */
export async function dealStageHistory(
  businessId: string,
  dealId: string,
): Promise<StageHistoryEntry[]> {
  if (!isUuid(dealId)) return [];
  const { rows } = await query<StageHistoryEntry>(
    `SELECT id, from_stage_name AS "fromStageName", to_stage_name AS "toStageName",
            seconds_in_from_stage AS "secondsInFromStage", changed_by AS "changedBy",
            note, created_at AS "createdAt"
       FROM crm_deal_stage_history
      WHERE business_id = $1 AND deal_id = $2
      ORDER BY created_at, id`,
    [businessId, dealId],
  );
  return rows.map((row) => ({
    ...row,
    secondsInFromStage: row.secondsInFromStage === null ? null : Number(row.secondsInFromStage),
  }));
}

// ---------------------------------------------------------------------------
// Pipeline configuration — the rows around the stages
// ---------------------------------------------------------------------------

export interface PipelineStageUsage {
  stageId: string;
  /** Deals currently sitting in the stage — the number that forbids deleting it. */
  dealCount: number;
  /** Deals that have ever *left* it, from the history table. */
  departedCount: number;
}

/**
 * How many deals each stage of a pipeline holds.
 *
 * Read before a save so the configurator can warn *before* the request fails:
 * `savePipelineStages` refuses to delete a stage that still holds deals (the
 * deals would become invisible on every board), and a rule a person only
 * discovers by being rejected is a rule they will try to work around. The
 * departed count is what makes "deactivate instead" a real choice rather than
 * advice — a stage 400 deals have passed through is one whose history matters
 * even if nothing sits in it today.
 */
export async function pipelineStageUsage(
  businessId: string,
  pipelineId: string,
): Promise<PipelineStageUsage[]> {
  if (!isUuid(pipelineId)) return [];
  const [{ rows: held }, { rows: departed }] = await Promise.all([
    query<{ stageId: string; count: string }>(
      `SELECT stage_id AS "stageId", count(*)::text AS count
         FROM crm_deals
        WHERE business_id = $1 AND pipeline_id = $2 AND stage_id IS NOT NULL
        GROUP BY stage_id`,
      [businessId, pipelineId],
    ),
    query<{ stageId: string; count: string }>(
      `SELECT to_stage_id AS "stageId", count(*)::text AS count
         FROM crm_deal_stage_history
        WHERE business_id = $1 AND to_stage_id IS NOT NULL
        GROUP BY to_stage_id`,
      [businessId],
    ),
  ]);
  const heldByStage = new Map(held.map((row) => [row.stageId, Number(row.count)]));
  const departedByStage = new Map(departed.map((row) => [row.stageId, Number(row.count)]));
  return [...new Set([...heldByStage.keys(), ...departedByStage.keys()])].map((stageId) => ({
    stageId,
    dealCount: heldByStage.get(stageId) ?? 0,
    departedCount: departedByStage.get(stageId) ?? 0,
  }));
}

export type PipelineSaveResult =
  | { ok: true; pipeline: Pipeline }
  | {
      ok: false;
      error:
        | "not_found"
        | "name_required"
        | "duplicate_name"
        | "default_pipeline_required"
        | "pipeline_in_use"
        | "stages_required"
        | "open_stage_required"
        | "won_stage_required"
        | "duplicate_stage_name"
        | "stage_in_use";
      /** The stage names that blocked a delete, when that is the error. */
      blocking?: string[];
    };

/**
 * Create a pipeline, copying the default one's stages.
 *
 * A new pipeline is not seeded with a fixed list, because the business has
 * already told us what its stages are: it is looking at them. Copying the
 * default means a second board (a tender track, an after-sales track) opens
 * usable and can be edited, instead of presenting an empty column list the way
 * a freshly provisioned business's board did before `defaultPipeline`
 * self-healed.
 *
 * Exactly one pipeline is the default. The first pipeline a business creates is
 * default by definition; a later one is not, whatever the caller asks for —
 * marking a second pipeline default is done by `updatePipeline`, which also
 * clears the previous one, so the two cannot both be true.
 */
export async function createPipeline(
  businessId: string,
  input: { name: string; description?: string; isDefault?: boolean },
  actor: { name: string; userId?: string | null },
): Promise<PipelineSaveResult> {
  const name = input.name.trim().slice(0, 120);
  if (!name) return { ok: false, error: "name_required" };

  const existing = await listPipelines(businessId, { includeArchived: true });
  if (existing.some((pipeline) => pipeline.name === name)) {
    return { ok: false, error: "duplicate_name" };
  }
  const wantsDefault = existing.length === 0 || input.isDefault === true;

  const created = await withTenantTransaction(businessId, async () => {
    if (wantsDefault) {
      await query(
        `UPDATE crm_pipelines SET is_default = false, updated_at = now()
          WHERE business_id = $1 AND is_default`,
        [businessId],
      );
    }
    const { rows } = await query<{ id: string }>(
      `INSERT INTO crm_pipelines (business_id, name, description, is_default, display_order, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        businessId,
        name,
        (input.description ?? "").trim().slice(0, 300),
        wantsDefault,
        existing.length,
        actor.name.slice(0, 120),
      ],
    );
    const pipelineId = rows[0].id;

    // Copy the source pipeline's stages, or the seed list when there is no
    // source yet (the first pipeline a business ever creates).
    const source = existing[0];
    const stages = source?.stages.length
      ? source.stages.map((stage, index) => ({
          name: stage.name,
          displayOrder: index + 1,
          defaultProbability: stage.defaultProbability,
          outcome: stage.outcome,
          requirementNote: stage.requirementNote,
        }))
      : SEED_STAGES.map((stage, index) => ({
          name: stage.name,
          displayOrder: index + 1,
          defaultProbability: stage.probability,
          outcome: stage.outcome,
          requirementNote: "",
        }));
    for (const stage of stages) {
      await query(
        `INSERT INTO crm_pipeline_stages
           (business_id, pipeline_id, name, display_order, default_probability, outcome, requirement_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (pipeline_id, name) DO NOTHING`,
        [
          businessId,
          pipelineId,
          stage.name,
          stage.displayOrder,
          stage.defaultProbability,
          stage.outcome,
          stage.requirementNote,
        ],
      );
    }
    return pipelineId;
  });

  const pipelines = await listPipelines(businessId, { includeArchived: true });
  const pipeline = pipelines.find((entry) => entry.id === created);
  if (!pipeline) return { ok: false, error: "not_found" };

  await recordCrmAudit({
    businessId,
    kind: "pipeline.created",
    entityType: "pipeline",
    entityId: pipeline.id,
    summary: `قیف فروش «${pipeline.name}» ساخته شد`,
    detail: { pipelineId: pipeline.id, default: pipeline.isDefault },
    actorUserId: actor.userId ?? null,
    actorName: actor.name,
  });
  return { ok: true, pipeline };
}

/**
 * Rename, redescribe, promote to default, or archive a pipeline.
 *
 * Three rules, each of which protects something that cannot be recovered:
 *
 * - **The default pipeline cannot be archived.** Every deal created without a
 *   pipeline lands in it and `defaultPipeline()` restores it on read, so
 *   archiving it produces a board that exists, an empty menu, and a "new deal"
 *   button that recreates what was just deleted.
 * - **A pipeline holding open deals cannot be archived.** Same reasoning as a
 *   stage that holds deals: its cards would be off every board while still
 *   being counted nowhere.
 * - **Promoting to default clears the previous default** in the same
 *   transaction, because the partial unique index would otherwise reject it and
 *   the error would be a constraint name rather than a sentence.
 */
export async function updatePipeline(
  businessId: string,
  pipelineId: string,
  input: { name?: string; description?: string; isDefault?: boolean; archived?: boolean },
  actor: { name: string; userId?: string | null },
): Promise<PipelineSaveResult> {
  if (!isUuid(pipelineId)) return { ok: false, error: "not_found" };
  const pipelines = await listPipelines(businessId, { includeArchived: true });
  const current = pipelines.find((pipeline) => pipeline.id === pipelineId);
  if (!current) return { ok: false, error: "not_found" };

  const name = input.name === undefined ? current.name : input.name.trim().slice(0, 120);
  if (!name) return { ok: false, error: "name_required" };
  if (pipelines.some((pipeline) => pipeline.id !== pipelineId && pipeline.name === name)) {
    return { ok: false, error: "duplicate_name" };
  }

  if (input.archived === true) {
    if (current.isDefault) return { ok: false, error: "default_pipeline_required" };
    const { rows } = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM crm_deals
        WHERE business_id = $1 AND pipeline_id = $2 AND closed_at IS NULL`,
      [businessId, pipelineId],
    );
    if (Number(rows[0]?.count ?? 0) > 0) return { ok: false, error: "pipeline_in_use" };
  }

  await withTenantTransaction(businessId, async () => {
    if (input.isDefault === true && !current.isDefault) {
      await query(
        `UPDATE crm_pipelines SET is_default = false, updated_at = now()
          WHERE business_id = $1 AND is_default`,
        [businessId],
      );
    }
    await query(
      `UPDATE crm_pipelines
          SET name = $3,
              description = $4,
              is_default = CASE WHEN $5::boolean THEN true ELSE is_default END,
              archived_at = CASE WHEN $6::boolean THEN now() ELSE archived_at END,
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        businessId,
        pipelineId,
        name,
        (input.description ?? current.description).trim().slice(0, 300),
        input.isDefault === true,
        input.archived === true,
      ],
    );
  });

  const updated = (await listPipelines(businessId, { includeArchived: true })).find(
    (pipeline) => pipeline.id === pipelineId,
  );
  if (!updated) return { ok: false, error: "not_found" };

  await recordCrmAudit({
    businessId,
    kind: "pipeline.updated",
    entityType: "pipeline",
    entityId: pipelineId,
    summary: input.archived === true
      ? `قیف فروش «${updated.name}» بایگانی شد`
      : `قیف فروش «${updated.name}» ویرایش شد`,
    detail: {
      pipelineId,
      name: updated.name,
      isDefault: updated.isDefault,
      archived: updated.archivedAt !== null,
    },
    actorUserId: actor.userId ?? null,
    actorName: actor.name,
  });
  return { ok: true, pipeline: updated };
}
