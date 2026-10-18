/**
 * Issue #984 — the signed repair catalog and ticket repair runs.
 *
 * One canonical catalog: every recipe carries a version, risk tier,
 * compatibility, preconditions, bounded effects, postchecks, backup policy
 * and a sha256 over its canonicalised action. Publishing (a new version or
 * flipping `active`) is owner-only and audited; execution pins the hash at
 * propose time and refuses to run when the catalog entry drifted — a recipe
 * edited after approval is a new recipe, never a silent substitution.
 *
 * Repairs are allowlisted bounded actions only. There is no raw command,
 * SQL, URL or script field anywhere in this module to be smuggled through.
 */
import { createHash } from "node:crypto";
import { query } from "../db";
import {
  isSupportRepairRisk,
  isLegalRepairRunTransition,
  isSupportRepairRunState,
  isTerminalRepairRunState,
  type SupportRepairRisk,
  type SupportRepairRunState,
} from "./types";
import { getInstallation } from "./installations";

export interface RepairRecipe {
  recipeId: string;
  version: number;
  title: string;
  description: string;
  risk: SupportRepairRisk;
  compatibility: Record<string, unknown>;
  preconditions: unknown[];
  effects: unknown[];
  postchecks: unknown[];
  backupPolicy: "none" | "checkpoint" | "verified_backup";
  recipe: Record<string, unknown>;
  recipeHash: string;
  publisherAdminId: string | null;
  publishedAt: string | null;
  active: boolean;
  createdAt: string;
}

interface RecipeRow extends Record<string, unknown> {
  recipe_id: string;
  version: number;
  title: string;
  description: string;
  risk: SupportRepairRisk;
  compatibility: Record<string, unknown>;
  preconditions: unknown[];
  effects: unknown[];
  postchecks: unknown[];
  backup_policy: "none" | "checkpoint" | "verified_backup";
  recipe: Record<string, unknown>;
  recipe_hash: string;
  publisher_admin_id: string | null;
  published_at: string | null;
  active: boolean;
  created_at: string;
}

function toRecipe(row: RecipeRow): RepairRecipe {
  return {
    recipeId: row.recipe_id,
    version: row.version,
    title: row.title,
    description: row.description,
    risk: row.risk,
    compatibility: row.compatibility ?? {},
    preconditions: Array.isArray(row.preconditions) ? row.preconditions : [],
    effects: Array.isArray(row.effects) ? row.effects : [],
    postchecks: Array.isArray(row.postchecks) ? row.postchecks : [],
    backupPolicy: row.backup_policy,
    recipe: (row.recipe ?? {}) as Record<string, unknown>,
    recipeHash: row.recipe_hash,
    publisherAdminId: row.publisher_admin_id,
    publishedAt: row.published_at,
    active: row.active,
    createdAt: row.created_at,
  };
}

/** Canonical JSON: sorted keys, recursive — the bytes `recipe_hash` covers. */
export function canonicalRecipeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRecipeJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalRecipeJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function recipeHashFor(recipe: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalRecipeJson(recipe), "utf8").digest("hex");
}

const RECIPE_SELECT = `
  SELECT recipe_id, version, title, description, risk, compatibility, preconditions,
         effects, postchecks, backup_policy, recipe, recipe_hash,
         publisher_admin_id::text AS publisher_admin_id, published_at, active, created_at
    FROM support_repair_catalog
`;

export type PublishRecipeResult =
  | { ok: true; recipe: RepairRecipe }
  | { ok: false; error: "invalid_recipe" | "version_not_new" };

/**
 * Publishes a new catalog version (route-gated to `support.repair.publish`).
 * Versions only ever grow; publishing never mutates an existing row, so a
 * pinned repair run keeps pointing at the exact bytes it was approved for.
 */
export async function publishRecipe(input: {
  recipeId: string;
  title: string;
  description?: string;
  risk: string;
  compatibility?: Record<string, unknown>;
  preconditions?: unknown[];
  effects?: unknown[];
  postchecks?: unknown[];
  backupPolicy?: string;
  recipe: Record<string, unknown>;
  publisherAdminId: string;
  active?: boolean;
}): Promise<PublishRecipeResult> {
  const recipeId = input.recipeId.trim().slice(0, 120);
  if (!recipeId || !input.title.trim() || !input.recipe || typeof input.recipe !== "object") {
    return { ok: false, error: "invalid_recipe" };
  }
  if (!isSupportRepairRisk(input.risk)) return { ok: false, error: "invalid_recipe" };
  const backupPolicy =
    input.backupPolicy === "checkpoint" || input.backupPolicy === "verified_backup"
      ? input.backupPolicy
      : input.backupPolicy === "none" || input.backupPolicy === undefined
        ? "none"
        : null;
  if (!backupPolicy) return { ok: false, error: "invalid_recipe" };
  // Recipes name a fixed action verb plus bounded parameters — never a shell
  // command, SQL string, URL or script. Anything else is refused at publish.
  if (!isBoundedRecipeAction(input.recipe)) return { ok: false, error: "invalid_recipe" };

  const { rows: latest } = await query<{ version: number }>(
    `SELECT version FROM support_repair_catalog WHERE recipe_id = $1 ORDER BY version DESC LIMIT 1`,
    [recipeId],
  );
  const version = (latest[0]?.version ?? 0) + 1;
  const recipeHash = recipeHashFor(input.recipe);
  try {
    const { rows } = await query<RecipeRow>(
      `INSERT INTO support_repair_catalog
         (recipe_id, version, title, description, risk, compatibility, preconditions,
          effects, postchecks, backup_policy, recipe, recipe_hash, publisher_admin_id,
          published_at, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::uuid, now(), $14)
       RETURNING recipe_id, version, title, description, risk, compatibility, preconditions,
         effects, postchecks, backup_policy, recipe, recipe_hash,
         publisher_admin_id::text AS publisher_admin_id, published_at, active, created_at`,
      [
        recipeId,
        version,
        input.title.trim().slice(0, 200),
        (input.description ?? "").slice(0, 4000),
        input.risk,
        JSON.stringify(input.compatibility ?? {}),
        JSON.stringify(input.preconditions ?? []),
        JSON.stringify(input.effects ?? []),
        JSON.stringify(input.postchecks ?? []),
        backupPolicy,
        JSON.stringify(input.recipe),
        recipeHash,
        input.publisherAdminId,
        input.active ?? false,
      ],
    );
    return { ok: true, recipe: toRecipe(rows[0]) };
  } catch {
    return { ok: false, error: "version_not_new" };
  }
}

const BOUNDED_RECIPE_ACTIONS: ReadonlySet<string> = new Set([
  "companion.clean_temp",
  "companion.rotate_logs",
  "main.restart_backend",
  "main.restart_postgres",
  "main.repair_binaries",
  "main.retry_sync_event",
  "main.renew_gateway_certificate",
  "main.clear_print_queue",
]);

/** The only action verbs a catalog recipe may name. */
export function isBoundedRecipeAction(recipe: Record<string, unknown>): boolean {
  if (typeof recipe.action !== "string" || !BOUNDED_RECIPE_ACTIONS.has(recipe.action)) return false;
  // No escape hatches: these keys must never appear anywhere in the recipe.
  const forbidden = ["command", "sql", "query", "script", "url", "powershell", "shell", "code"];
  const stack: unknown[] = [recipe];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (current !== null && typeof current === "object") {
      for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
        if (forbidden.includes(key.toLowerCase())) return false;
        stack.push(value);
      }
    }
  }
  return true;
}

/** The latest version of every recipe, for the propose picker. */
export async function listActiveCatalog(): Promise<RepairRecipe[]> {
  const { rows } = await query<RecipeRow>(
    `${RECIPE_SELECT} WHERE active ORDER BY recipe_id ASC, version DESC`,
  );
  const seen = new Set<string>();
  const out: RepairRecipe[] = [];
  for (const row of rows) {
    if (seen.has(row.recipe_id)) continue;
    seen.add(row.recipe_id);
    out.push(toRecipe(row));
  }
  return out;
}

export async function getRecipe(recipeId: string, version?: number): Promise<RepairRecipe | null> {
  const { rows } = await query<RecipeRow>(
    version === undefined
      ? `${RECIPE_SELECT} WHERE recipe_id = $1 ORDER BY version DESC LIMIT 1`
      : `${RECIPE_SELECT} WHERE recipe_id = $1 AND version = $2`,
    version === undefined ? [recipeId] : [recipeId, version],
  );
  return rows[0] ? toRecipe(rows[0]) : null;
}

export async function setRecipeActive(
  recipeId: string,
  version: number,
  active: boolean,
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE support_repair_catalog SET active = $3 WHERE recipe_id = $1 AND version = $2`,
    [recipeId, version, active],
  );
  return (rowCount ?? 0) > 0;
}

// ── Repair runs ──────────────────────────────────────────────────────────────

export interface RepairRun {
  id: string;
  businessId: string;
  ticketId: string;
  installationId: string;
  requestId: string | null;
  runId: string | null;
  recipeId: string;
  recipeVersion: number;
  recipeHash: string;
  actor: "operator" | "support_ai";
  operatorAdminId: string | null;
  state: SupportRepairRunState;
  consentRef: Record<string, unknown>;
  preconditionResults: unknown[];
  backupRef: string | null;
  beforeFindings: unknown[];
  afterFindings: unknown[];
  verification: Record<string, unknown>;
  receipt: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface RepairRunRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  ticket_id: string;
  installation_id: string;
  request_id: string | null;
  run_id: string | null;
  recipe_id: string;
  recipe_version: number;
  recipe_hash: string;
  actor: "operator" | "support_ai";
  operator_admin_id: string | null;
  state: SupportRepairRunState;
  consent_ref: Record<string, unknown>;
  precondition_results: unknown[];
  backup_ref: string | null;
  before_findings: unknown[];
  after_findings: unknown[];
  verification: Record<string, unknown>;
  receipt: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

const REPAIR_RUN_SELECT = `
  SELECT id::text AS id, business_id::text AS business_id, ticket_id::text AS ticket_id,
         installation_id::text AS installation_id, request_id::text AS request_id,
         run_id::text AS run_id, recipe_id, recipe_version, recipe_hash, actor,
         operator_admin_id::text AS operator_admin_id, state, consent_ref,
         precondition_results, backup_ref, before_findings, after_findings,
         verification, receipt, created_at, updated_at
    FROM support_repair_runs
`;

function toRepairRun(row: RepairRunRow): RepairRun {
  return {
    id: row.id,
    businessId: row.business_id,
    ticketId: row.ticket_id,
    installationId: row.installation_id,
    requestId: row.request_id,
    runId: row.run_id,
    recipeId: row.recipe_id,
    recipeVersion: row.recipe_version,
    recipeHash: row.recipe_hash,
    actor: row.actor,
    operatorAdminId: row.operator_admin_id,
    state: row.state,
    consentRef: row.consent_ref ?? {},
    preconditionResults: Array.isArray(row.precondition_results) ? row.precondition_results : [],
    backupRef: row.backup_ref,
    beforeFindings: Array.isArray(row.before_findings) ? row.before_findings : [],
    afterFindings: Array.isArray(row.after_findings) ? row.after_findings : [],
    verification: row.verification ?? {},
    receipt: row.receipt ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type ProposeRepairResult =
  | { ok: true; run: RepairRun }
  | {
      ok: false;
      error:
        | "ticket_not_found"
        | "installation_not_found"
        | "installation_not_active"
        | "recipe_not_found"
        | "recipe_not_active";
    };

/**
 * Proposes an exact catalog recipe/version for a ticket. The recipe hash is
 * pinned now; only active catalog entries are proposable.
 */
export async function proposeRepair(input: {
  businessId: string;
  ticketId: string;
  installationId: string;
  requestId?: string | null;
  runId?: string | null;
  recipeId: string;
  recipeVersion?: number;
  actor: "operator" | "support_ai";
  operatorAdminId?: string | null;
}): Promise<ProposeRepairResult> {
  const { rows: tickets } = await query<{ business_id: string }>(
    `SELECT business_id::text AS business_id FROM support_tickets WHERE id = $1::uuid`,
    [input.ticketId],
  );
  if (!tickets[0] || tickets[0].business_id !== input.businessId) {
    return { ok: false, error: "ticket_not_found" };
  }
  const installation = await getInstallation(input.businessId, input.installationId);
  if (!installation) return { ok: false, error: "installation_not_found" };
  if (installation.enrollmentState !== "active") return { ok: false, error: "installation_not_active" };
  const recipe = await getRecipe(input.recipeId, input.recipeVersion);
  if (!recipe) return { ok: false, error: "recipe_not_found" };
  if (!recipe.active) return { ok: false, error: "recipe_not_active" };

  const { rows } = await query<RepairRunRow>(
    `INSERT INTO support_repair_runs
       (business_id, ticket_id, installation_id, request_id, run_id,
        recipe_id, recipe_version, recipe_hash, actor, operator_admin_id)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id::text AS id, business_id::text AS business_id, ticket_id::text AS ticket_id,
       installation_id::text AS installation_id, request_id::text AS request_id,
       run_id::text AS run_id, recipe_id, recipe_version, recipe_hash, actor,
       operator_admin_id::text AS operator_admin_id, state, consent_ref,
       precondition_results, backup_ref, before_findings, after_findings,
       verification, receipt, created_at, updated_at`,
    [
      input.businessId,
      input.ticketId,
      input.installationId,
      input.requestId ?? null,
      input.runId ?? null,
      recipe.recipeId,
      recipe.version,
      recipe.recipeHash,
      input.actor,
      input.operatorAdminId ?? null,
    ],
  );
  return { ok: true, run: toRepairRun(rows[0]) };
}

export async function getRepairRun(businessId: string, runId: string): Promise<RepairRun | null> {
  const { rows } = await query<RepairRunRow>(
    `${REPAIR_RUN_SELECT} WHERE id = $1::uuid AND business_id = $2`,
    [runId, businessId],
  );
  return rows[0] ? toRepairRun(rows[0]) : null;
}

export async function listTicketRepairRuns(businessId: string, ticketId: string): Promise<RepairRun[]> {
  const { rows } = await query<RepairRunRow>(
    `${REPAIR_RUN_SELECT} WHERE business_id = $1 AND ticket_id = $2::uuid ORDER BY created_at DESC`,
    [businessId, ticketId],
  );
  return rows.map(toRepairRun);
}

export type RepairTransitionResult =
  | { ok: true; run: RepairRun }
  | {
      ok: false;
      error:
        | "run_not_found"
        | "terminal_state"
        | "invalid_state"
        | "illegal_transition"
        | "recipe_drifted"
        | "verification_required";
    };

/**
 * Moves a repair run between states. Entering `authorized` re-verifies the
 * pinned hash against the live catalog entry (drift → `blocked`); entering
 * `succeeded` requires recorded postcheck verification (a bare exit code is
 * never success). Terminal states never move.
 */
export async function transitionRepairRun(
  businessId: string,
  runId: string,
  to: string,
  patch: {
    consentRef?: Record<string, unknown>;
    preconditionResults?: unknown[];
    backupRef?: string | null;
    beforeFindings?: unknown[];
    afterFindings?: unknown[];
    verification?: Record<string, unknown>;
    receipt?: Record<string, unknown>;
  } = {},
): Promise<RepairTransitionResult> {
  if (!isSupportRepairRunState(to)) return { ok: false, error: "invalid_state" };
  const current = await getRepairRun(businessId, runId);
  if (!current) return { ok: false, error: "run_not_found" };
  if (isTerminalRepairRunState(current.state)) return { ok: false, error: "terminal_state" };
  if (!isLegalRepairRunTransition(current.state, to)) {
    return { ok: false, error: "illegal_transition" };
  }

  if (to === "authorized" || to === "executing") {
    const live = await getRecipe(current.recipeId, current.recipeVersion);
    if (!live || live.recipeHash !== current.recipeHash || !live.active) {
      await writeRepairRun(businessId, runId, "blocked", patch);
      const blocked = await getRepairRun(businessId, runId);
      void blocked;
      return { ok: false, error: "recipe_drifted" };
    }
  }
  if (to === "succeeded") {
    const verification = patch.verification ?? current.verification;
    if (verification.verified !== true || !Array.isArray(verification.postchecks)) {
      return { ok: false, error: "verification_required" };
    }
  }
  const run = await writeRepairRun(businessId, runId, to, patch);
  return { ok: true, run };
}

async function writeRepairRun(
  businessId: string,
  runId: string,
  to: SupportRepairRunState,
  patch: {
    consentRef?: Record<string, unknown>;
    preconditionResults?: unknown[];
    backupRef?: string | null;
    beforeFindings?: unknown[];
    afterFindings?: unknown[];
    verification?: Record<string, unknown>;
    receipt?: Record<string, unknown>;
  },
): Promise<RepairRun> {
  const sets: string[] = ["state = $3", "updated_at = now()"];
  const values: unknown[] = [runId, businessId, to];
  const columns: Record<string, string> = {
    consentRef: "consent_ref",
    preconditionResults: "precondition_results",
    backupRef: "backup_ref",
    beforeFindings: "before_findings",
    afterFindings: "after_findings",
    verification: "verification",
    receipt: "receipt",
  };
  let index = 4;
  for (const [key, column] of Object.entries(columns)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    sets.push(`${column} = $${index}`);
    values.push(typeof value === "string" || value === null ? value : JSON.stringify(value));
    index += 1;
  }
  const { rows } = await query<RepairRunRow>(
    `UPDATE support_repair_runs SET ${sets.join(", ")}
      WHERE id = $1::uuid AND business_id = $2
      RETURNING id::text AS id, business_id::text AS business_id, ticket_id::text AS ticket_id,
        installation_id::text AS installation_id, request_id::text AS request_id,
        run_id::text AS run_id, recipe_id, recipe_version, recipe_hash, actor,
        operator_admin_id::text AS operator_admin_id, state, consent_ref,
        precondition_results, backup_ref, before_findings, after_findings,
        verification, receipt, created_at, updated_at`,
    values as string[],
  );
  return toRepairRun(rows[0]);
}
