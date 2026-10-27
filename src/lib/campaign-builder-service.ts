/**
 * Issue #901, first slice — the campaign builder's storage and the history
 * the dry run replays. The rules live in `campaign-builder.ts`; this file is
 * the database half, in the shape of `growth-settings-service.ts`.
 *
 * What this slice writes: a campaign, its draft versions and an audit row —
 * nothing else. In particular **no reward, no liability and no journal entry
 * is created here**: `simulateSavedCampaign` only reads `orders` and
 * `payments`. The reward ledger and its posting rule are the next slice, and
 * they need an accountant-approved treatment first (marketing cashback is not
 * a sales return, so `loyalty.store_credit_issued` / account 4400 must not be
 * reused for it — issue #901 §C).
 */
import { createHash } from "node:crypto";
import { query, withTenantTransaction } from "./db";
import {
  CAMPAIGN_SCHEMA_VERSION,
  MAX_CAMPAIGN_BUILDER_NAME_LENGTH,
  parseCampaignDefinition,
  simulateCampaign,
  type CampaignDefinition,
  type CampaignProblem,
  type SimulationOutcome,
  type SimulationResult,
  type SimulationSale,
} from "./campaign-builder";
import { isUuid } from "./uuid";

export class CampaignBuilderError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly problems?: CampaignProblem[],
  ) {
    super(code);
  }
}

export type CampaignStatus = "draft" | "pending_approval" | "approved" | "live" | "paused" | "completed" | "archived";

export interface CampaignRecord {
  id: string;
  name: string;
  status: CampaignStatus;
  createdAt: string;
  updatedAt: string;
  version: {
    number: number;
    definition: CampaignDefinition;
    definitionHash: string;
    locked: boolean;
  };
}

/** Stable JSON (sorted keys) so equal definitions hash equally whatever order jsonb hands them back in. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashCampaignDefinition(definition: CampaignDefinition): string {
  return createHash("sha256").update(canonicalJson(definition)).digest("hex");
}

interface CampaignRow extends Record<string, unknown> {
  id: string;
  name: string;
  status: CampaignStatus;
  created_at: string;
  updated_at: string;
  version_number: number;
  definition: unknown;
  definition_hash: string;
  locked_at: string | null;
}

const CAMPAIGN_SELECT = `
  SELECT c.id, c.name, c.status, c.created_at::text AS created_at, c.updated_at::text AS updated_at,
         v.version_number, v.definition, v.definition_hash, v.locked_at::text AS locked_at
    FROM growth_campaigns c
    JOIN LATERAL (
      SELECT * FROM growth_campaign_versions v
       WHERE v.campaign_id = c.id
       ORDER BY v.version_number DESC
       LIMIT 1
    ) v ON true`;

function toRecord(row: CampaignRow): CampaignRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: {
      number: row.version_number,
      // Re-parsed so a stored document written by an older build is read through
      // today's rules; a document that no longer parses is a data error, not a guess.
      definition: reparse(row.definition),
      definitionHash: row.definition_hash,
      locked: row.locked_at !== null,
    },
  };
}

function reparse(stored: unknown): CampaignDefinition {
  const parsed = parseCampaignDefinition(stored);
  if (!parsed.ok) throw new CampaignBuilderError("stored_definition_invalid", 500, parsed.problems);
  return parsed.definition;
}

function cleanName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name === "" || name.length > MAX_CAMPAIGN_BUILDER_NAME_LENGTH) {
    throw new CampaignBuilderError("campaign_name_invalid", 400);
  }
  return name;
}

function validDefinition(raw: unknown): CampaignDefinition {
  const parsed = parseCampaignDefinition(raw);
  if (!parsed.ok) throw new CampaignBuilderError("campaign_definition_invalid", 400, parsed.problems);
  return parsed.definition;
}

/** Every branch the campaign names must be one of this business's own. */
async function assertBranchesBelongToBusiness(businessId: string, definition: CampaignDefinition): Promise<void> {
  const ids = definition.trigger.locationIds;
  if (ids === null) return;
  if (ids.some((id) => !isUuid(id))) throw new CampaignBuilderError("branch_not_found", 400);
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM locations WHERE business_id = $1 AND id = ANY($2::uuid[])`,
    [businessId, ids],
  );
  if (Number(rows[0]?.n ?? 0) !== ids.length) throw new CampaignBuilderError("branch_not_found", 400);
}

async function audit(
  businessId: string,
  actorId: string | null,
  action: "growth.campaign_created" | "growth.campaign_updated" | "growth.campaign_archived",
  campaignId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'growth_campaign', $4, $5)`,
    [businessId, actorId, action, campaignId, JSON.stringify(payload)],
  );
}

export async function listCampaigns(businessId: string): Promise<CampaignRecord[]> {
  const { rows } = await query<CampaignRow>(
    `${CAMPAIGN_SELECT} WHERE c.business_id = $1 ORDER BY (c.status = 'archived'), c.created_at DESC, c.id`,
    [businessId],
  );
  return rows.map(toRecord);
}

export async function getCampaign(businessId: string, id: string): Promise<CampaignRecord | null> {
  if (!isUuid(id)) return null;
  const { rows } = await query<CampaignRow>(`${CAMPAIGN_SELECT} WHERE c.business_id = $1 AND c.id = $2`, [businessId, id]);
  return rows[0] ? toRecord(rows[0]) : null;
}

/** Creates a campaign with its first draft version. */
export async function createCampaign(
  businessId: string,
  actorId: string | null,
  input: { name: unknown; definition: unknown },
): Promise<CampaignRecord> {
  const name = cleanName(input.name);
  const definition = validDefinition(input.definition);
  return withTenantTransaction(businessId, async () => {
    await assertBranchesBelongToBusiness(businessId, definition);
    const hash = hashCampaignDefinition(definition);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO growth_campaigns (business_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`,
      [businessId, name, actorId],
    );
    const id = rows[0].id;
    await query(
      `INSERT INTO growth_campaign_versions
         (business_id, campaign_id, version_number, schema_version, definition, definition_hash, created_by)
       VALUES ($1, $2, 1, $3, $4, $5, $6)`,
      [businessId, id, CAMPAIGN_SCHEMA_VERSION, JSON.stringify(definition), hash, actorId],
    );
    await audit(businessId, actorId, "growth.campaign_created", id, { name, definitionHash: hash });
    const created = await getCampaign(businessId, id);
    return created!;
  });
}

/**
 * Saves a change to a campaign that has not been launched. An unlocked latest
 * version is updated in place; if the latest is locked (once approval exists),
 * the change becomes the next version — what was approved is never rewritten.
 * Keys the patch does not name keep their stored value.
 */
export async function saveCampaignDraft(
  businessId: string,
  actorId: string | null,
  id: string,
  patch: { name?: unknown; definition?: unknown },
): Promise<CampaignRecord> {
  if (!isUuid(id)) throw new CampaignBuilderError("campaign_not_found", 404);
  const name = patch.name === undefined ? undefined : cleanName(patch.name);
  const definition = patch.definition === undefined ? undefined : validDefinition(patch.definition);
  if (name === undefined && definition === undefined) throw new CampaignBuilderError("nothing_to_update", 400);

  return withTenantTransaction(businessId, async () => {
    const { rows: locked } = await query<{ status: CampaignStatus }>(
      `SELECT status FROM growth_campaigns WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [businessId, id],
    );
    if (!locked[0]) throw new CampaignBuilderError("campaign_not_found", 404);
    if (locked[0].status !== "draft") throw new CampaignBuilderError("campaign_not_editable", 409);

    let versionNumber: number | null = null;
    let hash: string | null = null;
    if (definition) {
      await assertBranchesBelongToBusiness(businessId, definition);
      hash = hashCampaignDefinition(definition);
      const { rows: latest } = await query<{ version_number: number; locked_at: string | null; definition_hash: string }>(
        `SELECT version_number, locked_at::text AS locked_at, definition_hash
           FROM growth_campaign_versions WHERE campaign_id = $1
          ORDER BY version_number DESC LIMIT 1 FOR UPDATE`,
        [id],
      );
      const current = latest[0];
      if (current && current.locked_at === null) {
        if (current.definition_hash !== hash) {
          await query(
            `UPDATE growth_campaign_versions SET definition = $2, definition_hash = $3, schema_version = $4
              WHERE campaign_id = $1 AND version_number = $5`,
            [id, JSON.stringify(definition), hash, CAMPAIGN_SCHEMA_VERSION, current.version_number],
          );
        }
        versionNumber = current.version_number;
      } else {
        versionNumber = (current?.version_number ?? 0) + 1;
        await query(
          `INSERT INTO growth_campaign_versions
             (business_id, campaign_id, version_number, schema_version, definition, definition_hash, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [businessId, id, versionNumber, CAMPAIGN_SCHEMA_VERSION, JSON.stringify(definition), hash, actorId],
        );
      }
    }

    await query(
      `UPDATE growth_campaigns SET name = COALESCE($3, name), updated_at = now() WHERE business_id = $1 AND id = $2`,
      [businessId, id, name ?? null],
    );
    await audit(businessId, actorId, "growth.campaign_updated", id, {
      ...(name !== undefined ? { name } : {}),
      ...(hash ? { definitionHash: hash, version: versionNumber } : {}),
    });
    return (await getCampaign(businessId, id))!;
  });
}

/** Archives a campaign. A live one must be paused first; archiving twice is a no-op. */
export async function archiveCampaign(businessId: string, actorId: string | null, id: string): Promise<CampaignRecord> {
  if (!isUuid(id)) throw new CampaignBuilderError("campaign_not_found", 404);
  return withTenantTransaction(businessId, async () => {
    const { rows } = await query<{ status: CampaignStatus }>(
      `SELECT status FROM growth_campaigns WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [businessId, id],
    );
    if (!rows[0]) throw new CampaignBuilderError("campaign_not_found", 404);
    if (rows[0].status === "live") throw new CampaignBuilderError("campaign_live", 409);
    if (rows[0].status !== "archived") {
      await query(
        `UPDATE growth_campaigns SET status = 'archived', archived_at = now(), updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [businessId, id],
      );
      await audit(businessId, actorId, "growth.campaign_archived", id, { from: rows[0].status });
    }
    return (await getCampaign(businessId, id))!;
  });
}

// ── simulation ────────────────────────────────────────────────────────────────

export const SIMULATION_DEFAULT_WINDOW_DAYS = 30;
export const SIMULATION_MAX_WINDOW_DAYS = 90;
/** More sales than this and the replay says so rather than silently dropping the tail. */
export const SIMULATION_SALE_LIMIT = 20_000;
export const SIMULATION_OUTCOME_SAMPLE = 100;

interface SaleRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  customer_id: string | null;
  status: "completed" | "voided";
  at: string;
  total: string;
  tax: string;
  net_paid: string;
}

/**
 * The branch's completed and voided sales in `[from, to)`, as the dry run sees
 * them. Website-imported orders are left out (the supported trigger is a POS
 * sale). **Net paid** is what was actually received: every payment row (a refund
 * is a negative one) except the on-account («نسیه») tender, which is a promise
 * to pay and not money. Read-only.
 */
export async function loadSimulationSales(
  businessId: string,
  window: { from: Date; to: Date },
  locationIds: readonly string[] | null,
): Promise<{ sales: SimulationSale[]; truncated: boolean }> {
  const { rows } = await query<SaleRow>(
    `SELECT o.id, o.location_id, o.customer_id, o.status::text AS status,
            COALESCE(o.closed_at, o.opened_at) AS at,
            o.total::text AS total, o.tax::text AS tax,
            COALESCE(SUM(p.amount) FILTER (WHERE p.method <> 'credit'), 0)::text AS net_paid
       FROM orders o
       JOIN locations l ON l.id = o.location_id
       LEFT JOIN payments p ON p.order_id = o.id
      WHERE l.business_id = $1
        AND o.status IN ('completed', 'voided')
        -- The trigger is a POS sale: orders imported from a website (WooCommerce / CMS)
        -- are marked by these two tables, the same test shift-orders-service uses.
        AND NOT EXISTS (SELECT 1 FROM online_order_documents d WHERE d.order_id = o.id)
        AND NOT EXISTS (SELECT 1 FROM online_sale_lines s WHERE s.order_id = o.id)
        AND COALESCE(o.closed_at, o.opened_at) >= $2
        AND COALESCE(o.closed_at, o.opened_at) < $3
        AND ($4::uuid[] IS NULL OR o.location_id = ANY($4::uuid[]))
      GROUP BY o.id
      ORDER BY COALESCE(o.closed_at, o.opened_at), o.id
      LIMIT $5`,
    [businessId, window.from.toISOString(), window.to.toISOString(), locationIds ? [...locationIds] : null, SIMULATION_SALE_LIMIT + 1],
  );
  const truncated = rows.length > SIMULATION_SALE_LIMIT;
  const sales = rows.slice(0, SIMULATION_SALE_LIMIT).map(
    (row): SimulationSale => ({
      orderId: row.id,
      locationId: row.location_id,
      customerId: row.customer_id,
      status: row.status,
      closedAt: new Date(row.at).toISOString(),
      totalRial: Number(row.total),
      taxRial: Number(row.tax),
      netPaidRial: Number(row.net_paid),
    }),
  );
  return { sales, truncated };
}

export interface SavedCampaignSimulation {
  campaignId: string;
  version: number;
  definitionHash: string;
  window: { from: string; to: string };
  /** True when the window held more sales than the replay reads; the figures then cover the oldest part. */
  truncated: boolean;
  result: Omit<SimulationResult, "outcomes"> & {
    outcomes: SimulationOutcome[];
    outcomesTotal: number;
  };
}

/**
 * Replays the last `windowDays` of this business's sales through the
 * campaign's current definition. Writes nothing. Customer ids stay inside the
 * replay: the response carries order ids (to drill into) and totals, never who
 * would have been paid.
 */
export async function simulateSavedCampaign(
  businessId: string,
  id: string,
  options: { windowDays?: number; asOf?: Date } = {},
): Promise<SavedCampaignSimulation> {
  const campaign = await getCampaign(businessId, id);
  if (!campaign) throw new CampaignBuilderError("campaign_not_found", 404);

  const windowDays = options.windowDays ?? SIMULATION_DEFAULT_WINDOW_DAYS;
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > SIMULATION_MAX_WINDOW_DAYS) {
    throw new CampaignBuilderError("window_invalid", 400);
  }
  const asOf = options.asOf ?? new Date();
  const from = new Date(asOf.getTime() - windowDays * 86_400_000);

  const { definition } = campaign.version;
  const { sales, truncated } = await loadSimulationSales(businessId, { from, to: asOf }, definition.trigger.locationIds);
  const result = simulateCampaign(definition, sales, asOf);

  return {
    campaignId: campaign.id,
    version: campaign.version.number,
    definitionHash: campaign.version.definitionHash,
    window: { from: from.toISOString(), to: asOf.toISOString() },
    truncated,
    result: { ...result, outcomes: result.outcomes.slice(0, SIMULATION_OUTCOME_SAMPLE), outcomesTotal: result.outcomes.length },
  };
}
