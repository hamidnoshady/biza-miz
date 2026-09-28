/**
 * Phase 31 — the tenant-scoped half of autopilot: settings, the per-category
 * background run, the guardrail gate, and the undo path.
 *
 * There is deliberately no new tick in server.ts and no new business
 * enumeration: the proactive tick already discovers businesses under the one
 * justified platform bypass and re-enters each with withTenant(...), and
 * autopilot has no separate reason to open a second hole in that boundary. It
 * hangs off runBusinessProactiveJobs, so every read and write below already
 * runs inside the calling business's own tenant scope.
 */
import { query } from "./db";
import { ACTION_CATALOG, type ActionType, type ProposedAction } from "./ai";
import {
  AUTOPILOT_CATEGORIES,
  AUTOPILOT_CEILINGS,
  AUTOPILOT_DEFAULTS,
  actionTypesForCategory,
  clampAutopilotSetting,
  evaluateAutopilotProposal,
  type AutopilotAmountContext,
  type AutopilotCategory,
  type AutopilotCategorySetting,
} from "./ai-autopilot";
import { AUTOPILOT_EXECUTORS, AUTOPILOT_REVERTERS } from "./ai-autopilot-executors";
import { autopilotAmountContext } from "./ai-amount-context";
import { createAiActionAudit } from "./ai-action-audit";
import { runAgentTurn } from "./ai-service";
import { runSystemReadTool } from "./ai-system-read";
import { compactProactiveFacts, type LocalBusinessClock } from "./ai-proactive";
import {
  AiWalletInsufficientError,
  gateAiTurn,
  newAiRequestId,
  settleAiTurn,
} from "./ai-wallet-billing";
import type { PlatformAiConfig } from "./ai-config";

export type AutopilotSettingsMap = Record<AutopilotCategory, AutopilotCategorySetting>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface SettingsRow extends Record<string, unknown> {
  category: string;
  enabled: boolean;
  max_amount_rial: string | null;
  max_percent: number | null;
  max_items_per_run: number;
  daily_action_limit: number;
  authorized_by: string | null;
}

export async function getAutopilotSettings(businessId: string): Promise<AutopilotSettingsMap> {
  const { rows } = await query<SettingsRow>(
    `SELECT category, enabled, max_amount_rial::text, max_percent, max_items_per_run,
            daily_action_limit, authorized_by
       FROM ai_autopilot_settings WHERE business_id = $1`,
    [businessId],
  );
  const stored = new Map(rows.map((row) => [row.category, row]));
  const result = {} as AutopilotSettingsMap;
  for (const category of AUTOPILOT_CATEGORIES) {
    const row = stored.get(category);
    // A missing row means disabled, never a default-on — autopilot must not
    // turn itself on for a business that never asked for it. Clamped on read
    // as well as write, so lowering a ceiling narrows stored rows immediately.
    result[category] = row
      ? clampAutopilotSetting(category, {
          enabled: row.enabled,
          maxAmountRial: row.max_amount_rial === null ? null : Number(row.max_amount_rial),
          maxPercent: row.max_percent,
          maxItemsPerRun: row.max_items_per_run,
          dailyActionLimit: row.daily_action_limit,
        })
      : { ...AUTOPILOT_DEFAULTS[category], enabled: false };
  }
  return result;
}

async function authorizingUser(businessId: string, category: AutopilotCategory): Promise<string | null> {
  const { rows } = await query<{ authorized_by: string | null }>(
    `SELECT authorized_by FROM ai_autopilot_settings WHERE business_id = $1 AND category = $2`,
    [businessId, category],
  );
  return rows[0]?.authorized_by ?? null;
}

export async function setAutopilotCategory(
  businessId: string,
  category: AutopilotCategory,
  input: Partial<AutopilotCategorySetting>,
  actorUserId: string,
): Promise<AutopilotCategorySetting> {
  const clamped = clampAutopilotSetting(category, input);
  await query(
    `INSERT INTO ai_autopilot_settings
       (business_id, category, enabled, max_amount_rial, max_percent, max_items_per_run,
        daily_action_limit, authorized_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (business_id, category) DO UPDATE
        SET enabled = EXCLUDED.enabled,
            max_amount_rial = EXCLUDED.max_amount_rial,
            max_percent = EXCLUDED.max_percent,
            max_items_per_run = EXCLUDED.max_items_per_run,
            daily_action_limit = EXCLUDED.daily_action_limit,
            authorized_by = EXCLUDED.authorized_by,
            updated_at = now()`,
    [
      businessId,
      category,
      clamped.enabled,
      clamped.maxAmountRial,
      clamped.maxPercent,
      clamped.maxItemsPerRun,
      clamped.dailyActionLimit,
      actorUserId,
    ],
  );
  return clamped;
}

export const AUTOPILOT_LIMITS = { ceilings: AUTOPILOT_CEILINGS, defaults: AUTOPILOT_DEFAULTS };

// ---------------------------------------------------------------------------
// Activity + undo
// ---------------------------------------------------------------------------

export interface AutopilotActivityEntry extends Record<string, unknown> {
  id: string;
  actionType: string;
  actionTitle: string;
  actionSummary: string;
  category: string | null;
  status: string;
  deferredReason: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  createdAt: string;
  appliedAt: string | null;
  revertedAt: string | null;
}

export async function listAutopilotActivity(
  businessId: string,
  limit = 30,
): Promise<{ entries: AutopilotActivityEntry[] }> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const { rows } = await query<AutopilotActivityEntry>(
    `SELECT id, action_type AS "actionType", action_title AS "actionTitle",
            action_summary AS "actionSummary", autopilot_category AS category,
            status, deferred_reason AS "deferredReason", proposal_payload AS payload,
            result, created_at AS "createdAt", applied_at AS "appliedAt",
            reverted_at AS "revertedAt"
       FROM ai_action_audit
      WHERE business_id = $1 AND source = 'autopilot'
      ORDER BY created_at DESC
      LIMIT $2`,
    [businessId, safeLimit],
  );
  return { entries: rows };
}

/** Unseen is per user: a manager clearing their badge must not hide a run from the owner. */
export async function countUnseenAutopilotActivity(businessId: string, userId: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM ai_action_audit a
      WHERE a.business_id = $1
        AND a.source = 'autopilot'
        AND a.created_at > COALESCE(
              (SELECT s.seen_at FROM ai_autopilot_activity_seen s
                WHERE s.business_id = $1 AND s.user_id = $2::uuid),
              'epoch'::timestamptz)`,
    [businessId, userId],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function markAutopilotActivitySeen(businessId: string, userId: string): Promise<void> {
  await query(
    `INSERT INTO ai_autopilot_activity_seen (business_id, user_id, seen_at)
     VALUES ($1, $2, now())
     ON CONFLICT (business_id, user_id) DO UPDATE SET seen_at = now()`,
    [businessId, userId],
  );
}

export type RevertResult = { ok: true } | { ok: false; error: string };

/**
 * Undo one applied autopilot action.
 *
 * Deliberately a separate function from finishAiActionAudit, which only ever
 * transitions *from* 'proposed'. This is the applied → reverted transition and
 * the `AND status = 'applied'` predicate is what makes a double-revert a no-op.
 */
export async function revertAutopilotAction(input: {
  businessId: string;
  auditId: string;
  actorName: string;
}): Promise<RevertResult> {
  const { rows } = await query<{
    action_type: string;
    status: string;
    payload: Record<string, unknown>;
    prior_state: Record<string, unknown> | null;
    result: Record<string, unknown> | null;
    autopilot_category: string | null;
  }>(
    `SELECT action_type, status, proposal_payload AS payload, prior_state, result, autopilot_category
       FROM ai_action_audit WHERE id = $1 AND business_id = $2 AND source = 'autopilot'`,
    [input.auditId, input.businessId],
  );
  const row = rows[0];
  if (!row) return { ok: false, error: "not_found" };
  if (row.status !== "applied") return { ok: false, error: "not_revertible_status" };

  const meta = ACTION_CATALOG[row.action_type as ActionType];
  if (!meta?.executor || !meta.revertible) return { ok: false, error: "not_revertible" };
  const reverter = AUTOPILOT_REVERTERS[meta.executor];
  if (!reverter) return { ok: false, error: "not_revertible" };

  const category = (row.autopilot_category ?? meta.autopilotCategory) as AutopilotCategory | null;
  const outcome = await reverter({
    businessId: input.businessId,
    authorizedByUserId: category ? await authorizingUser(input.businessId, category) : null,
    payload: row.payload ?? {},
    priorState: row.prior_state,
    result: row.result,
  });
  if (!outcome.ok) return { ok: false, error: outcome.errorCode ?? "revert_failed" };

  await query(
    `UPDATE ai_action_audit
        SET status = 'reverted', reverted_at = now(), reverted_by = $3, reversal_ref = $4::jsonb
      WHERE id = $1 AND business_id = $2 AND status = 'applied'`,
    [input.auditId, input.businessId, input.actorName.slice(0, 200), JSON.stringify(outcome.result)],
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function appliedTodayInCategory(businessId: string, category: AutopilotCategory): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM ai_action_audit
      WHERE business_id = $1 AND source = 'autopilot' AND autopilot_category = $2
        AND status IN ('applied', 'reverted')
        AND created_at >= now() - interval '24 hours'`,
    [businessId, category],
  );
  return Number(rows[0]?.count ?? 0);
}

const NO_ROWS = Promise.resolve({ rows: [] as unknown[] });

/**
 * Category-scoped facts, all from existing read tools and services — autopilot
 * adds no new query surface. Returning an empty-ish set is the signal that
 * this run has nothing to think about, so it never reaches the provider.
 */
async function collectCategoryFacts(
  businessId: string,
  category: AutopilotCategory,
  clock: LocalBusinessClock,
): Promise<{ facts: unknown; interesting: boolean }> {
  switch (category) {
    case "inventory": {
      const [lowStock, valuation] = await Promise.all([
        query<{ id: string; name: string; unit: string; stock_qty: string; reorder_level: string }>(
          `WITH stock AS (
             SELECT i.id, i.name, i.unit, i.reorder_level,
                    coalesce(sum(m.quantity), 0) AS stock_qty
               FROM inventory_items i
               LEFT JOIN stock_movements m ON m.inventory_item_id = i.id
               JOIN locations l ON l.id = i.location_id
              WHERE l.business_id = $1 AND i.is_active AND i.reorder_level IS NOT NULL
              GROUP BY i.id, i.name, i.unit, i.reorder_level
           )
           SELECT id, name, unit, stock_qty::text, reorder_level::text
             FROM stock WHERE stock_qty <= reorder_level ORDER BY name LIMIT 20`,
          [businessId],
        ),
        runSystemReadTool("get_stock_valuation", {}, businessId),
      ]);
      return {
        facts: { lowStock: lowStock.rows, valuation: valuation.data },
        interesting: lowStock.rows.length > 0,
      };
    }

    case "pricing": {
      const [performance, drift] = await Promise.all([
        runSystemReadTool("get_menu_performance", { dateTo: clock.dateKey }, businessId),
        // Only ever proposes a price move where recorded ingredient cost moved.
        query<{ menu_item_id: string; name: string; price: string; recipe_cost: string }>(
          `SELECT m.id AS menu_item_id, m.name, m.price::text AS price,
                  COALESCE(SUM(r.quantity * i.avg_cost), 0)::text AS recipe_cost
             FROM menu_items m
             JOIN locations l ON l.id = m.location_id
             JOIN menu_item_ingredients r ON r.menu_item_id = m.id
             JOIN inventory_items i ON i.id = r.inventory_item_id
            WHERE l.business_id = $1 AND m.is_active
            GROUP BY m.id, m.name, m.price
           HAVING COALESCE(SUM(r.quantity * i.avg_cost), 0) > m.price * 0.6
            ORDER BY m.name LIMIT 20`,
          [businessId],
        ),
      ]);
      return {
        facts: { menuPerformance: performance.data, costPressure: drift.rows },
        interesting: drift.rows.length > 0,
      };
    }

    case "money": {
      const [bankLines, aging] = await Promise.all([
        runSystemReadTool("get_unreconciled_bank_lines", {}, businessId),
        runSystemReadTool("get_ar_aging", {}, businessId),
      ]);
      const lines = Array.isArray((bankLines.data as { rows?: unknown[] })?.rows)
        ? ((bankLines.data as { rows: unknown[] }).rows as unknown[])
        : [];
      return {
        facts: { unreconciledBankLines: bankLines.data, arAging: aging.data },
        interesting: lines.length > 0,
      };
    }

    case "customer": {
      const atRisk = await runSystemReadTool("get_at_risk_customers", {}, businessId);
      const rows = Array.isArray((atRisk.data as { rows?: unknown[] })?.rows)
        ? ((atRisk.data as { rows: unknown[] }).rows as unknown[])
        : [];
      return { facts: { atRiskCustomers: atRisk.data }, interesting: rows.length > 0 };
    }

    case "waste": {
      // F&B only, the same way the service-reminder job is watch-only. Waste
      // is detected and flagged here; a real discrepancy may surface as an
      // inventory adjustment, judged under the inventory category's own cap.
      const { rows: industry } = await query<{ industry: string }>(
        `SELECT industry FROM businesses WHERE id = $1`,
        [businessId],
      );
      if (industry[0]?.industry !== "food_service") {
        return { facts: { skipped: "not_food_service" }, interesting: false };
      }
      const waste = await query<{ reason: string; quantity: string; cost: string }>(
        `SELECT COALESCE(sm.waste_reason, 'other') AS reason,
                SUM(-sm.quantity)::text AS quantity,
                SUM(-sm.quantity * sm.unit_cost)::text AS cost
           FROM stock_movements sm
           JOIN locations l ON l.id = sm.location_id
          WHERE l.business_id = $1 AND sm.type = 'waste'
            AND sm.occurred_at >= now() - interval '30 days'
          GROUP BY 1 ORDER BY 3 DESC`,
        [businessId],
      );
      return { facts: { waste: waste.rows }, interesting: waste.rows.length > 0 };
    }

    default:
      await NO_ROWS;
      return { facts: {}, interesting: false };
  }
}

function autopilotPrompt(category: AutopilotCategory, clock: LocalBusinessClock, facts: unknown): string {
  return [
    `اجرای خودکار روزانه برای دستهٔ «${category}». تاریخ محلی کسب‌وکار: ${clock.dateKey}.`,
    "فقط بر پایهٔ دادهٔ JSON زیر تصمیم بگیر. اگر داده‌ها اقدام روشنی را توجیه نمی‌کنند، هیچ پیشنهادی نساز.",
    "داده‌های ورودی:\n" + JSON.stringify(compactProactiveFacts(facts)).slice(0, 42_000),
  ].join("\n\n");
}

async function claimAutopilotRun(businessId: string, periodKey: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO ai_proactive_runs (business_id, kind, period_key, status)
     VALUES ($1, 'autopilot', $2, 'running')
     ON CONFLICT (business_id, kind, period_key) DO NOTHING
     RETURNING id`,
    [businessId, periodKey],
  );
  return rows[0]?.id ?? null;
}

async function finishAutopilotRun(input: {
  businessId: string;
  runId: string;
  status: "completed" | "skipped" | "failed";
  content?: string | null;
  facts?: unknown;
  creditRequestId?: string | null;
  error?: string | null;
}): Promise<void> {
  await query(
    `UPDATE ai_proactive_runs
        SET status = $3, content = $4, facts = COALESCE($5::jsonb, facts),
            credit_request_id = COALESCE($6, credit_request_id), error = $7, finished_at = now()
      WHERE id = $1 AND business_id = $2`,
    [
      input.runId,
      input.businessId,
      input.status,
      input.content?.slice(0, 12_000) ?? null,
      input.facts === undefined ? null : JSON.stringify(compactProactiveFacts(input.facts)),
      input.creditRequestId ?? null,
      input.error?.slice(0, 1000) ?? null,
    ],
  );
}

async function recordProposal(input: {
  businessId: string;
  category: AutopilotCategory;
  proposal: ProposedAction;
  prompt: string;
  authorizedBy: string | null;
  authorizedByName: string;
}): Promise<string> {
  const auditId = await createAiActionAudit({
    businessId: input.businessId,
    actorUserId: input.authorizedBy ?? "autopilot",
    actorName: `اجرای خودکار (مجوز: ${input.authorizedByName})`,
    prompt: input.prompt,
    proposal: input.proposal,
  });
  await query(
    `UPDATE ai_action_audit SET source = 'autopilot', autopilot_category = $3
      WHERE id = $1 AND business_id = $2`,
    [auditId, input.businessId, input.category],
  );
  return auditId;
}

export type AutopilotProposalOutcome =
  | { outcome: "applied"; auditId: string; result: Record<string, unknown> }
  | { outcome: "failed"; auditId: string; errorCode: string }
  | { outcome: "deferred"; auditId: string; reasonCode: string; reasonFa: string };

/**
 * The gate between a model's proposal and an unattended write, and the whole
 * safety-critical half of this feature. Split out of the run so it can be
 * driven with a synthetic proposal in an integration test, with no provider
 * involved — the guardrails are exactly what must be proven against a real
 * database, not the plumbing that fetched the proposal.
 */
export async function applyOrDeferProposal(input: {
  businessId: string;
  category: AutopilotCategory;
  setting: AutopilotCategorySetting;
  proposal: ProposedAction;
  authorizedBy: string | null;
}): Promise<AutopilotProposalOutcome> {
  const { businessId, category, setting, proposal, authorizedBy } = input;
  const meta = ACTION_CATALOG[proposal.type];
  const auditId = await recordProposal({
    businessId,
    category,
    proposal,
    prompt: `اجرای خودکار — ${category}`,
    authorizedBy,
    authorizedByName: authorizedBy ? await userName(businessId, authorizedBy) : "نامشخص",
  });

  const verdict = evaluateAutopilotProposal({
    meta,
    payload: proposal.payload,
    setting,
    appliedTodayInCategory: await appliedTodayInCategory(businessId, category),
    // Read from the database, never taken from the model's own payload: a
    // proposal cannot talk its way under a cap by misreporting the price it
    // is changing or the bill it is discounting.
    context: await autopilotAmountContext(businessId, proposal),
  });

  if (verdict.decision === "needs_confirmation") {
    // Not dropped and not forced through: the row stays 'proposed' and shows
    // in the hub as an ordinary clickable proposal, with the reason attached.
    await query(
      `UPDATE ai_action_audit SET deferred_reason = $3 WHERE id = $1 AND business_id = $2 AND status = 'proposed'`,
      [auditId, businessId, verdict.reasonCode],
    );
    return { outcome: "deferred", auditId, reasonCode: verdict.reasonCode, reasonFa: verdict.reasonFa };
  }

  const executor = meta.executor ? AUTOPILOT_EXECUTORS[meta.executor] : null;
  if (!executor) throw new Error("autopilot_executor_missing");
  const result = await executor({ businessId, authorizedByUserId: authorizedBy, payload: proposal.payload });

  await query(
    `UPDATE ai_action_audit
        SET status = $3, result = $4::jsonb, prior_state = $5::jsonb,
            applied_at = CASE WHEN $3 = 'applied' THEN now() ELSE applied_at END
      WHERE id = $1 AND business_id = $2 AND status = 'proposed'`,
    [
      auditId,
      businessId,
      result.ok ? "applied" : "failed",
      JSON.stringify(compactProactiveFacts(result.result)),
      result.priorState === undefined ? null : JSON.stringify(compactProactiveFacts(result.priorState)),
    ],
  );
  return result.ok
    ? { outcome: "applied", auditId, result: result.result }
    : { outcome: "failed", auditId, errorCode: result.errorCode ?? "execution_failed" };
}

/**
 * One category's unattended run: claim, collect, decide, and either apply
 * through the executor or leave the proposal for a human. Returns whether it
 * did any work.
 */
async function runCategory(input: {
  businessId: string;
  category: AutopilotCategory;
  setting: AutopilotCategorySetting;
  clock: LocalBusinessClock;
  config: PlatformAiConfig;
}): Promise<boolean> {
  const { businessId, category, setting, clock, config } = input;
  const actionTypes = actionTypesForCategory(category);
  if (actionTypes.length === 0) return false;

  const runId = await claimAutopilotRun(businessId, `${clock.dateKey}:${category}`);
  if (!runId) return false;

  const requestId = newAiRequestId();
  let facts: unknown;
  try {
    const collected = await collectCategoryFacts(businessId, category, clock);
    facts = collected.facts;
    if (!collected.interesting) {
      // Nothing worth acting on: finish without ever reaching the provider, so
      // a quiet day costs the business no credit at all.
      await finishAutopilotRun({ businessId, runId, status: "skipped", facts, error: "nothing_to_do" });
      return false;
    }

    const authorizedBy = await authorizingUser(businessId, category);
    // Phase B — gate on the wallet; an unaffordable business is skipped, not
    // reserved against.
    try {
      await gateAiTurn(businessId, config);
    } catch (error) {
      if (error instanceof AiWalletInsufficientError) {
        await finishAutopilotRun({ businessId, runId, status: "skipped", facts, error: "ai_credit_required" });
        return false;
      }
      throw error;
    }

    const prompt = autopilotPrompt(category, clock, facts);
    const reply = await runAgentTurn({
      config,
      mode: "autopilot",
      businessId,
      actionTypes,
      promptContext: { mode: "autopilot", autopilotCategory: category, allowedActionTypes: actionTypes },
      messages: [{ role: "user", content: prompt }],
    });

    // Phase B — settle the real cost against the wallet (gateway-priced when
    // reported, token rates otherwise).
    await settleAiTurn({
      businessId,
      requestId,
      config,
      usage: reply.usage,
      costUsd: reply.costUsd,
      attribution: {
        requestType: "autopilot",
        model: config.model,
        userId: authorizedBy,
        metadata: { source: "autopilot", kind: category, periodKey: `${clock.dateKey}:${category}` },
      },
    });

    if (!reply.proposedAction) {
      await finishAutopilotRun({
        businessId,
        runId,
        status: "completed",
        content: reply.content,
        facts,
        creditRequestId: requestId,
      });
      return true;
    }

    const decision = await applyOrDeferProposal({
      businessId,
      category,
      setting,
      proposal: reply.proposedAction,
      authorizedBy,
    });
    await finishAutopilotRun({
      businessId,
      runId,
      status: "completed",
      content:
        decision.outcome === "deferred"
          ? `${reply.content}\n\n[برای تأیید شما نگه داشته شد: ${decision.reasonFa}]`
          : reply.content,
      facts,
      creditRequestId: requestId,
    });
    return true;
  } catch (error) {
    // Phase B — no reservation to cancel.
    await finishAutopilotRun({ businessId, runId, status: "failed", facts, error: errorText(error) }).catch(
      (finishError) => console.error("autopilot run could not be marked failed", finishError),
    );
    throw error;
  }
}

async function userName(businessId: string, userId: string): Promise<string> {
  const { rows } = await query<{ full_name: string }>(
    `SELECT full_name FROM users WHERE id = $1 AND business_id = $2`,
    [userId, businessId],
  );
  return rows[0]?.full_name ?? "نامشخص";
}

/**
 * Isolates the per-category loop from DB plumbing, mirroring
 * runTenantScopedProactiveJobs, so a test can prove one failing category does
 * not stop the ones after it.
 */
export async function runAutopilotCategories(
  categories: AutopilotCategory[],
  runOne: (category: AutopilotCategory) => Promise<void>,
): Promise<{ completed: number; failed: number }> {
  let completed = 0;
  let failed = 0;
  for (const category of categories) {
    try {
      await runOne(category);
      completed += 1;
    } catch (error) {
      failed += 1;
      console.error(`autopilot category ${category} failed:`, errorText(error));
    }
  }
  return { completed, failed };
}

/**
 * Entry point called from runBusinessProactiveJobs, already inside
 * withTenant(businessId, ...). Autopilot is gated by three switches and all
 * three must be on: the ai_assistant feature (checked by the caller), the
 * proactive credit opt-in (also the caller's), and this category's own switch.
 */
export async function runBusinessAutopilot(
  businessId: string,
  clock: LocalBusinessClock,
  config: PlatformAiConfig | null,
): Promise<number> {
  if (!config) return 0;
  const settings = await getAutopilotSettings(businessId);
  const enabled = AUTOPILOT_CATEGORIES.filter((category) => settings[category].enabled);
  if (enabled.length === 0) return 0;

  let completed = 0;
  await runAutopilotCategories(enabled, async (category) => {
    if (await runCategory({ businessId, category, setting: settings[category], clock, config })) completed += 1;
  });
  return completed;
}
