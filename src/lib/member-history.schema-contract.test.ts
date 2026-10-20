/**
 * Issue #1007 — the completeness contract for the hard-delete history sweep.
 *
 * The code review on this branch found that a member whose only business
 * activity was booking a reservation passed the gate: `POST /api/reservations`
 * stores the member in `reservations.created_by` and writes no `audit_log`
 * row, and the FK is `ON DELETE SET NULL` — so the hard delete would have
 * silently erased who booked it. The same shape (author attribution to
 * `users(id)`, `ON DELETE SET NULL`/`CASCADE`, no audit row) exists wherever a
 * business operation records who did it: purchases, stock movements, expenses,
 * returns, transfers, closings, cheques, the vertical modules' documents. The
 * fix gates them from the catalogues in `member-history.ts` (the
 * `reservations` and `records` flags), and this test pins the sweep so it can
 * never silently regress.
 *
 * The rule: every column in `migrations/` that references `users(id)` or
 * `platform_users(id)` must be in exactly one bucket —
 *
 *   1. `FLAGGED_ATTRIBUTIONS` — probed by the six hand-written tests in
 *      `team-service.ts` (`memberHistorySql`);
 *   2. the catalogues — probed by the two generated sweeps in
 *      `member-history.ts`;
 *   3. `UNCHECKED_ATTRIBUTIONS` — deliberately not probed, with a stated
 *      reason (account identity, sign-in security, personal UI, platform
 *      billing, tooling, standing configuration, plain assignments).
 *
 * A migration that adds an attribution column without classifying it fails
 * here — that is the point: the sweep is a decision, and unclassified
 * attribution is where the reservation hole came from.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MEMBER_HISTORY_RECORD_ATTRIBUTIONS,
  MEMBER_HISTORY_RESERVATION_ATTRIBUTIONS,
  type MemberHistoryFlags,
} from "./member-history";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

/**
 * The attribution columns the six hand-written tests in `team-service.ts`
 * (`memberHistorySql`) already probe, and the flag each feeds.
 */
const FLAGGED_ATTRIBUTIONS: Record<string, keyof MemberHistoryFlags> = {

  'orders.opened_by': 'orders',
  'orders.closed_by': 'orders',
  'payments.received_by': 'orders',
  'employee_shifts.closed_by': 'shifts',
  'journal_entries.created_by': 'journal',
  'payroll_runs.created_by': 'payroll',
  'payroll_run_lines.user_id': 'payroll',
  'payroll_payslips.user_id': 'payroll',
  'payroll_run_allocations.user_id': 'payroll',
  'payroll_advances.user_id': 'payroll',
  'payroll_advances.created_by': 'payroll',
  'payroll_advances.voided_by': 'payroll',
  'audit_log.user_id': 'audit',
  'parties.employee_user_id': 'file',

};

/**
 * Deliberately not probed — a member delete must not be blocked by these. The
 * map is a decision record: every entry is a real attribution column, and the
 * value says why it is safe to let its foreign key do its
 * `ON DELETE SET NULL`/`CASCADE` work.
 */
const UNCHECKED_ATTRIBUTIONS: Record<string, string> = {

  'accounting_dimension_settings.updated_by': 'dimension config',
  'aec_project_profiles.project_manager_user_id': 'project staffing assignment',
  'ai_automations.authorized_by': 'AI automation setup',
  'ai_automations.created_by': 'AI automation setup',
  'ai_autopilot_activity_seen.user_id': 'AI read-state',
  'ai_autopilot_settings.authorized_by': 'AI autopilot setup',
  'ai_coworker_jobs.authorized_by': 'AI job setup',
  'ai_coworker_jobs.created_by': 'AI job setup',
  'ai_credit_ledger.created_by_user_id': 'platform AI credits',
  'ai_custom_agents.created_by': 'AI agent setup',
  'ai_project_tasks.assignee_user_id': 'workspace collab module',
  'ai_projects.owner_user_id': 'workspace collab module',
  'ai_wallet_settlements.created_by_user_id': 'platform AI billing',
  'api_keys.created_by': 'platform API credentials',
  'auth_password_resets.membership_id': 'account security lifecycle',
  'billing_payments.created_by_user_id': 'platform billing',
  'business_day_closures.reopened_by': 'business-day window state; the close/reopen itself is in audit_log and shift authorship is flagged on employee_shifts',
  'bug_reports.user_id': 'account support channel',
  'commission_rules.employee_id': 'commission config',
  'crm_activities.assignee_user_id': 'activity assignment',
  'crm_audit_events.actor_user_id': 'module audit log (business audit lives in audit_log)',
  'crm_cases.assignee_user_id': 'case assignment',
  'crm_deals.owner_user_id': 'deal ownership assignment',
  'crm_leads.owner_user_id': 'lead ownership assignment',
  'crm_saved_views.owner_user_id': 'personal UI layout',
  'dashboard_widgets.user_id': 'personal UI layout',
  'data_export_jobs.created_by': 'data-transfer tooling',
  'data_export_templates.created_by': 'data-transfer tooling',
  'data_import_jobs.created_by': 'data-transfer tooling',
  'data_mapping_templates.created_by': 'data-transfer tooling',
  'data_scheduled_exports.created_by': 'data-transfer tooling',
  'desktop_login_codes.user_id': 'sign-in security',
  'employees.id': 'employee identity row is the membership identity (0042)',
  'financial_accounts.archived_by': 'financial account configuration (movement lives in financial_transfers)',
  'financial_accounts.created_by': 'financial account configuration (movement lives in financial_transfers)',
  'financial_accounts.updated_by': 'financial account configuration (movement lives in financial_transfers)',
  'floor_sections.assigned_waiter_id': 'floor assignment config',
  'growth_settings.updated_by': 'feature settings',
  'holoo_connection_settings.direct_sql_armed_by': 'integration setup',
  'holoo_import_runs.created_by': 'integration tooling',
  'iam_commands.actor_user_id': 'IAM control plane log',
  'iam_events.actor_user_id': 'IAM control plane log',
  'impersonation_grants.user_id': 'super-admin impersonation',
  'install_pairing_codes.issued_by': 'installer pairing',
  'integration_connections.created_by': 'integration setup',
  'integration_reconciliations.created_by': 'integration tooling',
  'inventory_item_visual_profiles.created_by': 'inventory view config',
  'invitations.accepted_user_id': 'team invitation lifecycle',
  'invitations.invited_by': 'team invitation lifecycle',
  'mcp_connections.authorized_by': 'integration setup',
  'mcp_connections.created_by': 'integration setup',
  'mcp_grant_events.actor_user_id': 'integration grant log',
  'mcp_oauth_codes.user_id': 'integration OAuth',
  'media_assets.created_by': 'media library tooling',
  'media_collection_items.added_by': 'media library tooling',
  'media_collections.created_by': 'media library tooling',
  'media_folders.created_by': 'media library tooling',
  'message_credit_ledger.created_by_user_id': 'platform messaging credits',
  'native_app_devices.reactivated_by': 'device registry for the account',
  'native_app_devices.revoked_by': 'device registry for the account',
  'native_app_devices.user_id': 'device registry for the account',
  'notification_deliveries.user_id': 'notification delivery log',
  'notification_devices.user_id': 'notification prefs',
  'notification_recipients.user_id': 'notification prefs',
  'notification_rules.user_id': 'notification prefs',
  'owner_activations.platform_user_id': 'owner activation lifecycle',
  'owner_activations.user_id': 'owner activation lifecycle',
  'parties.crm_owner_user_id': 'CRM ownership assignment, not work authorship',
  'payroll_component_changes.changed_by': 'payroll config history',
  'payroll_employee_item_changes.changed_by': 'payroll config history',
  'payroll_employee_items.created_by': 'payroll config (member compensation setup goes with the member)',
  'payroll_employee_items.user_id': 'payroll config (member compensation setup goes with the member)',
  'payroll_employee_profiles.user_id': 'payroll config (goes with the member)',
  'payroll_profile_changes.changed_by': 'payroll config history',
  'payroll_profile_changes.user_id': 'payroll config history',
  'payroll_rule_sets.created_by': 'payroll config',
  'personnel_file_drift.user_id': 'personnel-link housekeeping',
  'platform_company_customers.account_owner_user_id': 'platform company workspace',
  'platform_company_handoffs.user_id': 'platform company workspace',
  'platform_company_members.user_id': 'platform company workspace',
  'platform_company_site_credentials.created_by': 'platform company workspace',
  'pos_devices.paired_by': 'device pairing',
  'production_formulas.created_by': 'production formula config',
  'saved_reports.created_by': 'personal saved reports',
  'shift_cashups.closed_by': 'cash-up authorship mirrors employee_shifts.closed_by, which is flagged against the shifts history',
  'shift_cash_movements.created_by': 'shift cash ledger event; the shift itself is flagged and every movement is audited',
  'shift_cashup_adjustments.created_by': 'cash-up correction event; the shift itself is flagged and every correction is audited',
  'shareholder_ownership_policies.updated_by': 'shareholder policy config',
  'support_diagnostic_requests.member_user_id': 'account support channel',
  'support_ticket_messages.user_id': 'account support channel',
  'support_tickets.user_id': 'account support channel',
  'sync_event_dead_letters.resolved_by': 'sync infra housekeeping',
  'tax_invoice_profiles.updated_by': 'tax profile config',
  'tenant_roles.created_by': 'role configuration',
  'tenant_roles.updated_by': 'role configuration',
  'trusted_devices.user_id': 'sign-in security',
  'user_locations.user_id': 'access grants — removed with the membership',
  'users.platform_user_id': 'identity link the hard delete itself removes',
  'wallet_ledger.created_by_user_id': 'platform billing',
  'workspace_activity.actor_id': 'workspace collab module',
  'workspace_approvals.approver_user_id': 'workspace collab module',
  'workspace_approvals.decided_by': 'workspace collab module',
  'workspace_approvals.requested_by': 'workspace collab module',
  'workspace_comments.author_id': 'workspace collab module',
  'workspace_members.user_id': 'workspace module membership',
  'workspace_project_links.created_by': 'workspace collab module',

};

/** Tables scoped to a business only through a parent row that carries it. */
const PARENT_JOIN: Record<string, { table: string; on: string }> = {
  fixed_asset_depreciation_entries: { table: "fixed_assets", on: "fixed_asset_id" },
  fixed_asset_estimate_changes: { table: "fixed_assets", on: "fixed_asset_id" },
  fixed_asset_transfers: { table: "fixed_assets", on: "fixed_asset_id" },
  payroll_run_lines: { table: "payroll_runs", on: "run_id" },
};

// ---------------------------------------------------------------------------
// Deliberately minimal migration parser: it only needs to find attribution
// columns and know which columns each table declares. It mirrors this repo's
// DDL shapes: `CREATE TABLE`/`ALTER TABLE` blocks, column-level
// `uuid REFERENCES users(id)`, table-level `FOREIGN KEY (…) REFERENCES
// users(id)`, and multi-line `ADD COLUMN` statements.

const TYPE_WORD = "(?:uuid|text|timestamptz|bigint|integer|boolean|jsonb|numeric|date)";
const CREATE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/i;
const ALTER_RE = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?"?(\w+)"?/i;
const COLUMN_FK_RE = new RegExp(
  String.raw`^\s*(?:ADD\s+(?:COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?)?)?"?(\w+)"?\s+${TYPE_WORD}\b[^;\n]*?\bREFERENCES\s+(?:users|platform_users)\s*\(\s*id\s*\)`,
  "gi",
);
const PLAIN_COLUMN_RE = new RegExp(
  String.raw`^\s*(?:ADD\s+(?:COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?)?)?"?(\w+)"?\s+${TYPE_WORD}\b`,
  "gi",
);
const TABLE_FK_RE = /FOREIGN\s+KEY\s*\(\s*"?(\w+)"?\s*\)\s*REFERENCES\s+(?:users|platform_users)\s*\(\s*id\s*\)/gi;

interface ParsedMigrations {
  /** Every "table.column" attribution, de-duplicated. */
  attributionKeys: string[];
  /** Each table's declared columns (for business-scope resolution). */
  tableColumns: Map<string, Set<string>>;
}

function parseMigrations(): ParsedMigrations {
  const keys = new Set<string>();
  const tableColumns = new Map<string, Set<string>>();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    let current: string | null = null;
    for (const line of readFileSync(join(MIGRATIONS_DIR, file), "utf8").split("\n")) {
      const tableMatch = line.match(CREATE_RE) ?? line.match(ALTER_RE);
      if (tableMatch) current = tableMatch[1];
      if (current === null) continue;
      for (const fk of line.matchAll(COLUMN_FK_RE)) keys.add(`${current}.${fk[1]}`);
      for (const fk of line.matchAll(TABLE_FK_RE)) keys.add(`${current}.${fk[1]}`);
      for (const col of line.matchAll(PLAIN_COLUMN_RE)) {
        if (!tableColumns.has(current)) tableColumns.set(current, new Set());
        tableColumns.get(current)!.add(col[1]);
      }
    }
  }
  return { attributionKeys: [...keys].sort(), tableColumns };
}

function catalogKeys(): Set<string> {
  const keys = new Set<string>();
  for (const attribution of [
    ...MEMBER_HISTORY_RESERVATION_ATTRIBUTIONS,
    ...MEMBER_HISTORY_RECORD_ATTRIBUTIONS,
  ]) {
    for (const column of attribution.columns) keys.add(`${attribution.table}.${column}`);
  }
  return keys;
}

describe("attribution sweep completeness (issue #1007, code-review P1)", () => {
  const parsed = parseMigrations();

  it("finds the attribution columns, so the sweep is not vacuous", () => {
    expect(parsed.attributionKeys.length).toBeGreaterThanOrEqual(200);
  });

  it("classifies every users/platform_users attribution column", () => {
    const catalog = catalogKeys();
    const unclassified = parsed.attributionKeys.filter(
      (key) =>
        !(key in FLAGGED_ATTRIBUTIONS) &&
        !catalog.has(key) &&
        !(key in UNCHECKED_ATTRIBUTIONS),
    );
    expect(unclassified, "every attribution column must be flagged, catalogued, or excused").toEqual([]);
  });

  it("catalogues only real attribution columns, each with a resolvable business scope", () => {
    for (const attribution of [
      ...MEMBER_HISTORY_RESERVATION_ATTRIBUTIONS,
      ...MEMBER_HISTORY_RECORD_ATTRIBUTIONS,
    ]) {
      for (const column of attribution.columns) {
        expect(
          parsed.attributionKeys,
          `catalog entry ${attribution.table}.${column} must be a real users/platform_users FK`,
        ).toContain(`${attribution.table}.${column}`);
      }
      const columns = parsed.tableColumns.get(attribution.table);
      if (attribution.scope?.kind === "join") {
        const parent = PARENT_JOIN[attribution.table];
        expect(parent, `join scope for ${attribution.table} must be registered in PARENT_JOIN`).toBeDefined();
        expect(parsed.tableColumns.get(parent.table)?.has("business_id"), `${parent.table} must carry business_id`).toBe(true);
        expect(columns?.has(parent.on), `${attribution.table} must have the ${parent.on} join column`).toBe(true);
      } else if (attribution.scope?.kind === "location") {
        expect(columns?.has("location_id"), `${attribution.table} must be branch-scoped (location_id)`).toBe(true);
      } else {
        expect(columns?.has("business_id"), `${attribution.table} must carry business_id`).toBe(true);
      }
    }
  });

  it("the six hand-written flags only cover real attribution columns", () => {
    for (const key of Object.keys(FLAGGED_ATTRIBUTIONS)) {
      expect(parsed.attributionKeys, key).toContain(key);
    }
  });

  it("every UNCHECKED entry is a real attribution column with a reason", () => {
    for (const [key, reason] of Object.entries(UNCHECKED_ATTRIBUTIONS)) {
      expect(parsed.attributionKeys, key).toContain(key);
      expect(reason.trim(), `${key} needs a reason`).not.toBe("");
    }
  });

  it("pins the code-review P1: reservations.created_by is gated", () => {
    const reservations = MEMBER_HISTORY_RESERVATION_ATTRIBUTIONS.find((a) => a.table === "reservations");
    expect(reservations?.columns).toContain("created_by");
  });
});
