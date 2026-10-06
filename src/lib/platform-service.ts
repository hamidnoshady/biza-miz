/**
 * Phase 15 — the read/write operations behind the super-admin console.
 *
 * Everything here runs from a platform request, whose `getPlatformSession`
 * already stood tenant isolation down (bypass scope). These functions are the
 * cross-tenant queries that would be impossible — and are meant to be
 * impossible — from a tenant session: listing every business, reading any
 * business's usage, minting an impersonation session into a business the
 * operator is not a member of.
 *
 * DB-touching, so no direct unit test per repo convention; the pure decisions
 * they lean on (capability presets, impersonation clamping) live in
 * `platform-admin.ts` and are tested there, and the guard/isolation behaviour
 * is exercised by the platform integration test.
 */
import { getPool, query, withoutTenantScope, withTenant } from "./db";
import { getPlatformBackupHealth } from "./platform-backup-service";
import type { PoolClient } from "pg";
import { disableFeatures, seedChartOfAccounts } from "./business-provisioning";
import type { Industry } from "./industries";
import { industryProfile } from "./industry-profile";
import { clampImpersonationMinutes, platformCan } from "./platform-admin";
import type { PlatformAdminRole } from "./platform-auth-edge";
import { platformAudit, revokeAllPlatformAdminSessions } from "./platform-auth";
import { issuePasswordResetToken } from "./password-reset";
import { markMfaGracePeriod } from "./mfa-service";
import { MFA_GRACE_DAYS_PLATFORM } from "./mfa";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { isTicketCategory, isTicketPriority, isTicketStatus, statusAfterAdminReply } from "./support-tickets";
import {
  generateImpersonationHandoffToken,
  hashImpersonationHandoffToken,
  IMPERSONATION_HANDOFF_TTL_MINUTES,
} from "./impersonation-handoff";
import { validSupportReason } from "./support-session";
import { isUuid } from "./uuid";

// ---------------------------------------------------------------------------
// Business lifecycle
// ---------------------------------------------------------------------------

export type BusinessStatus = "active" | "suspended" | "archived";

export interface BusinessSummary {
  id: string;
  name: string;
  slug: string;
  /** Phase 23 — the public host label; mutable, unlike slug. */
  subdomain: string;
  status: BusinessStatus;
  plan: string;
  timezone: string;
  /** Phase 21's `businesses.industry` — which module set, labels and sales model this tenant gets. */
  industry: Industry;
  ownershipKind: "customer" | "platform_internal";
  createdAt: string;
  suspendedAt: string | null;
  archivedAt: string | null;
  locationCount: number;
  memberCount: number;
  /** Denormalized-at-read counters for the console list — order volume and the
   * newest order timestamp answer "is this tenant alive?" without a click. */
  orderCount: number;
  lastActivityAt: string | null;
}

interface BusinessRow extends Record<string, unknown> {
  id: string;
  name: string;
  slug: string;
  subdomain: string;
  status: BusinessStatus;
  plan: string;
  timezone: string;
  industry: Industry;
  ownership_kind: "customer" | "platform_internal";
  created_at: string;
  suspended_at: string | null;
  archived_at: string | null;
  location_count: string;
  member_count: string;
  order_count: string;
  last_activity_at: string | null;
}

function toSummary(row: BusinessRow): BusinessSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    subdomain: row.subdomain,
    status: row.status,
    plan: row.plan,
    timezone: row.timezone,
    industry: row.industry,
    ownershipKind: row.ownership_kind,
    createdAt: row.created_at,
    suspendedAt: row.suspended_at,
    archivedAt: row.archived_at,
    locationCount: Number(row.location_count),
    memberCount: Number(row.member_count),
    orderCount: Number(row.order_count),
    lastActivityAt: row.last_activity_at,
  };
}

/** Every business on the deployment, newest first — the console's landing list. */
export async function listBusinesses(): Promise<BusinessSummary[]> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<BusinessRow>(
      `SELECT b.id, b.name, b.slug::text AS slug, b.subdomain::text AS subdomain,
              b.status::text AS status, b.plan,
              b.timezone, b.industry, b.ownership_kind, b.created_at, b.suspended_at, b.archived_at,
              (SELECT count(*) FROM locations l WHERE l.business_id = b.id) AS location_count,
              (SELECT count(*) FROM users u WHERE u.business_id = b.id AND u.is_active) AS member_count,
              (SELECT count(*) FROM orders o JOIN locations l ON l.id = o.location_id
                WHERE l.business_id = b.id) AS order_count,
              (SELECT max(o.opened_at) FROM orders o JOIN locations l ON l.id = o.location_id
                WHERE l.business_id = b.id) AS last_activity_at
         FROM businesses b
        WHERE b.ownership_kind = 'customer'
        ORDER BY b.created_at DESC`,
    );
    return rows.map(toSummary);
  });
}

/** Filters/sort/pagination for the console's server-backed business directory. */
export interface BusinessQuery {
  /** Free-text over name, slug and subdomain. */
  search?: string;
  status?: BusinessStatus;
  plan?: string;
  industry?: Industry;
  /** ISO date (inclusive) lower bound on created_at. */
  createdFrom?: string;
  /** ISO date (inclusive) upper bound on created_at. */
  createdTo?: string;
  /** "active" = has any orders; "idle" = none. */
  activity?: "active" | "idle";
  sort?: "newest" | "oldest" | "name" | "orders" | "members" | "activity";
  page?: number;
  pageSize?: number;
}

export interface BusinessListResult {
  businesses: BusinessSummary[];
  total: number;
  page: number;
  pageSize: number;
  /**
   * Server-side aggregates for the directory's summary cards, computed over the
   * same filter context as the page (see `queryBusinesses`). The page used to
   * count its own 20 rows and label that "فعال"/"معلق"/"بایگانی", which is a
   * different number from the one an operator reads it as.
   */
  statusCounts: BusinessStatusCounts;
}

export interface BusinessStatusCounts {
  total: number;
  active: number;
  suspended: number;
  archived: number;
}

const BUSINESS_SORT_SQL: Record<NonNullable<BusinessQuery["sort"]>, string> = {
  newest: "b.created_at DESC",
  oldest: "b.created_at ASC",
  name: "b.name ASC",
  orders: "order_count DESC",
  members: "member_count DESC",
  activity: "last_activity_at DESC NULLS LAST",
};

/**
 * The console's business directory — filtered, sorted and paginated in the
 * database rather than fetched whole and sliced in the browser (task section
 * 6). Every filter is an optional WHERE clause; the counters used for the
 * `orders`/`members`/`activity` sorts are computed as sub-selects so a big
 * deployment stays a single indexed round-trip. `pageSize` is clamped so a
 * caller can never ask for an unbounded page.
 */
export async function queryBusinesses(q: BusinessQuery = {}): Promise<BusinessListResult> {
  const page = Math.max(1, Math.floor(q.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(q.pageSize ?? 20)));
  const offset = (page - 1) * pageSize;
  const sort = BUSINESS_SORT_SQL[q.sort ?? "newest"] ?? BUSINESS_SORT_SQL.newest;

  return withoutTenantScope("platform", async () => {
    /** Bound values plus the WHERE clauses that reference them. */
    interface FilterBuilder {
      where: string[];
      params: unknown[];
    }
    const builder = (): FilterBuilder => ({ where: ["b.ownership_kind = 'customer'"], params: [] });
    /** Push a bound value and return its `$n` placeholder. */
    const bind = (b: FilterBuilder, value: unknown): string => {
      b.params.push(value);
      return `$${b.params.length}`;
    };

    /**
     * Every filter except `status`, applied to a fresh builder. The status
     * filter is deliberately *not* here: the summary counts must describe the
     * current search/plan/industry/activity context across all statuses, or a
     * single "معلق" filter would report «فعال: ۰» as if nothing were active.
     */
    const applyFilters = (b: FilterBuilder): void => {
      if (q.search && q.search.trim()) {
        const p = bind(b, `%${q.search.trim()}%`);
        b.where.push(
          `(b.name ILIKE ${p} OR b.slug::text ILIKE ${p} OR b.subdomain::text ILIKE ${p})`,
        );
      }
      if (q.plan) b.where.push(`b.plan = ${bind(b, q.plan)}`);
      if (q.industry) b.where.push(`b.industry = ${bind(b, q.industry)}`);
      if (q.createdFrom) b.where.push(`b.created_at >= ${bind(b, q.createdFrom)}`);
      if (q.createdTo) b.where.push(`b.created_at <= ${bind(b, `${q.createdTo}T23:59:59.999Z`)}`);

      // Activity filter needs the correlated existence of an order.
      if (q.activity === "active") {
        b.where.push(
          "EXISTS (SELECT 1 FROM orders o JOIN locations l ON l.id = o.location_id WHERE l.business_id = b.id)",
        );
      } else if (q.activity === "idle") {
        b.where.push(
          "NOT EXISTS (SELECT 1 FROM orders o JOIN locations l ON l.id = o.location_id WHERE l.business_id = b.id)",
        );
      }
    };

    const filtered = builder();
    applyFilters(filtered);
    const all = builder();
    applyFilters(all);
    if (q.status) all.where.push(`b.status = ${bind(all, q.status)}`);

    const whereSql = all.where.length ? `WHERE ${all.where.join(" AND ")}` : "";
    const filteredWhereSql = filtered.where.length
      ? `WHERE ${filtered.where.join(" AND ")}`
      : "";

    const { rows: countRows } = await query<{ total: string }>(
      `SELECT count(*)::text AS total FROM businesses b ${whereSql}`,
      all.params,
    );
    const total = Number(countRows[0]?.total ?? 0);

    // One grouped round trip for all three statuses, over the filter context
    // without the status clause — never a count of the current page.
    const { rows: statusRows } = await query<{ status: BusinessStatus; count: string }>(
      `SELECT b.status::text AS status, count(*)::text AS count
         FROM businesses b ${filteredWhereSql}
        GROUP BY b.status`,
      filtered.params,
    );
    const statusCounts: BusinessStatusCounts = { total: 0, active: 0, suspended: 0, archived: 0 };
    for (const row of statusRows) {
      const value = Number(row.count);
      statusCounts[row.status] = value;
      statusCounts.total += value;
    }

    const { rows } = await query<BusinessRow>(
      `SELECT b.id, b.name, b.slug::text AS slug, b.subdomain::text AS subdomain,
              b.status::text AS status, b.plan,
              b.timezone, b.industry, b.ownership_kind, b.created_at, b.suspended_at, b.archived_at,
              (SELECT count(*) FROM locations l WHERE l.business_id = b.id) AS location_count,
              (SELECT count(*) FROM users u WHERE u.business_id = b.id AND u.is_active) AS member_count,
              (SELECT count(*) FROM orders o JOIN locations l ON l.id = o.location_id
                WHERE l.business_id = b.id) AS order_count,
              (SELECT max(o.opened_at) FROM orders o JOIN locations l ON l.id = o.location_id
                WHERE l.business_id = b.id) AS last_activity_at
         FROM businesses b
        ${whereSql}
        ORDER BY ${sort}
        LIMIT ${pageSize} OFFSET ${offset}`,
      all.params,
    );

    return { businesses: rows.map(toSummary), total, page, pageSize, statusCounts };
  });
}

/**
 * The distinct plan keys actually in use, for the directory's plan filter.
 *
 * Read from the businesses themselves rather than the plan catalogue: the
 * useful question is "which plans exist on this deployment?", and a support
 * operator without `plans.manage` must still be able to filter by one.
 */
export async function listBusinessPlanKeys(): Promise<string[]> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{ plan: string }>(
      `SELECT DISTINCT b.plan FROM businesses b WHERE b.ownership_kind = 'customer'
          AND b.plan IS NOT NULL AND b.plan <> ''
        ORDER BY b.plan`,
    );
    return rows.map((row) => row.plan);
  });
}

/**
 * Just who a business is — the shell's sidebar title, its host and its status.
 *
 * Deliberately not `getBusiness`: that read costs four correlated sub-selects
 * (locations, active members, orders, newest order), the alias list and the
 * industry data counts. The console layout needs one string to draw the
 * workspace's name, and it used to pay for all of it — on every navigation
 * into the workspace, twice, because the workspace's own provider reads the
 * full summary too (issue #755 §11).
 */
export interface BusinessIdentity {
  id: string;
  name: string;
  slug: string;
  subdomain: string;
  status: BusinessStatus;
}

interface BusinessIdentityRow extends Record<string, unknown>, BusinessIdentity {}

export async function getBusinessIdentity(businessId: string): Promise<BusinessIdentity | null> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<BusinessIdentityRow>(
      `SELECT id, name, slug::text AS slug, subdomain::text AS subdomain,
              status::text AS status
         FROM businesses
        WHERE id = $1`,
      [businessId],
    );
    return rows[0] ?? null;
  });
}

/** One business by id, or null. */
export async function getBusiness(businessId: string): Promise<BusinessSummary | null> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<BusinessRow>(
      `SELECT b.id, b.name, b.slug::text AS slug, b.subdomain::text AS subdomain,
              b.status::text AS status, b.plan,
              b.timezone, b.industry, b.ownership_kind, b.created_at, b.suspended_at, b.archived_at,
              (SELECT count(*) FROM locations l WHERE l.business_id = b.id) AS location_count,
              (SELECT count(*) FROM users u WHERE u.business_id = b.id AND u.is_active) AS member_count,
              (SELECT count(*) FROM orders o JOIN locations l ON l.id = o.location_id
                WHERE l.business_id = b.id) AS order_count,
              (SELECT max(o.opened_at) FROM orders o JOIN locations l ON l.id = o.location_id
                WHERE l.business_id = b.id) AS last_activity_at
         FROM businesses b
        WHERE b.id = $1`,
      [businessId],
    );
    return rows[0] ? toSummary(rows[0]) : null;
  });
}

/**
 * Move a business between lifecycle states.
 *
 * Suspend/reactivate flip `status` and stamp `suspended_at`; the actual
 * blocking happens at login (`membershipBlockedReason`) and at the API guard
 * (`requirePermission` returns `business_suspended`), so no data is touched —
 * the exit criterion is "blocks members without deleting anything". Archiving
 * additionally stamps `archived_at`, which starts the hard-delete grace clock.
 */
export async function setBusinessStatus(
  businessId: string,
  status: BusinessStatus,
  options: { expectFrom?: BusinessStatus } = {},
): Promise<BusinessSummary | null> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ id: string }>(
      `UPDATE businesses
          SET status = $2::business_status,
              suspended_at = CASE WHEN $2 = 'suspended' THEN now()
                                  WHEN $2 = 'active' THEN NULL
                                  ELSE suspended_at END,
              archived_at  = CASE WHEN $2 = 'archived' THEN now()
                                  WHEN $2 = 'active' THEN NULL
                                  ELSE archived_at END,
              updated_at = now()
        WHERE id = $1
          AND ($3::text IS NULL OR status::text = $3)
        RETURNING id`,
      [businessId, status, options.expectFrom ?? null],
    ),
  );
  return rows[0] ? getBusiness(businessId) : null;
}

/**
 * Editable business metadata. Slug deliberately stays immutable here: it is the
 * stable support identifier shown by the platform console, while name and
 * timezone are ordinary business preferences. The *subdomain* is mutable but
 * not through this function — renaming an origin has consequences (an alias to
 * write, sessions to invalidate) that a generic field setter would hide, so it
 * has its own operation below.
 */
export interface BusinessUpdate {
  name?: string;
  timezone?: string;
}

export type RenameSubdomainResult =
  | { ok: true; business: BusinessSummary; previous: string }
  | { ok: false; error: "not_found" | "subdomain_taken" | "unchanged" };

/**
 * Move a business to a new public host, keeping the old one working.
 *
 * Three things have to happen together or not at all, which is why this is one
 * transaction rather than a column update:
 *
 *  1. the new subdomain is claimed (the unique index is what makes the race
 *     safe — two admins renaming onto the same label cannot both win);
 *  2. the old subdomain becomes an alias, so bookmarks and printed URLs
 *     pointing at it still resolve — `src/app/page.tsx` redirects them to the
 *     current host;
 *  3. any alias equal to the *new* name is dropped, because a label cannot be
 *     both a live subdomain and an alias — the resolver checks businesses
 *     first, so a leftover row would simply be dead weight, and the unique
 *     index would block a future rename back.
 *
 * Existing sessions on the old host are not migrated and cannot be: the JWT
 * carries the old `businessSubdomain`, so middleware sees a mismatch and sends
 * those browsers back to log in. That is the correct outcome — it is the same
 * check that keeps one tenant's cookie off another tenant's origin — and the
 * console warns about it before the rename.
 */
export async function renameBusinessSubdomain(
  businessId: string,
  subdomain: string,
): Promise<RenameSubdomainResult> {
  return withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query<{ subdomain: string }>(
        `SELECT subdomain::text AS subdomain FROM businesses WHERE id = $1 FOR UPDATE`,
        [businessId],
      );
      const previous = rows[0]?.subdomain;
      if (!previous) {
        await client.query("ROLLBACK");
        return { ok: false, error: "not_found" as const };
      }
      if (previous.toLowerCase() === subdomain.toLowerCase()) {
        await client.query("ROLLBACK");
        return { ok: false, error: "unchanged" as const };
      }

      const taken = await client.query(
        `SELECT 1 FROM businesses WHERE subdomain = $1 AND id <> $2
          UNION ALL
         SELECT 1 FROM business_subdomain_aliases WHERE alias = $1 AND business_id <> $2`,
        [subdomain, businessId],
      );
      if (taken.rowCount) {
        await client.query("ROLLBACK");
        return { ok: false, error: "subdomain_taken" as const };
      }

      await client.query(`DELETE FROM business_subdomain_aliases WHERE alias = $1`, [subdomain]);
      await client.query(
        `UPDATE businesses SET subdomain = $2, updated_at = now() WHERE id = $1`,
        [businessId, subdomain],
      );
      await client.query(
        `INSERT INTO business_subdomain_aliases (business_id, alias) VALUES ($1, $2)
         ON CONFLICT (alias) DO NOTHING`,
        [businessId, previous],
      );

      await client.query("COMMIT");
      const business = await getBusiness(businessId);
      return business ? { ok: true as const, business, previous } : { ok: false as const, error: "not_found" as const };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

/** Update the editable metadata for one business and return its fresh summary. */
export async function updateBusiness(
  businessId: string,
  values: BusinessUpdate,
): Promise<BusinessSummary | null> {
  const assignments: string[] = [];
  const params: unknown[] = [businessId];

  if (values.name !== undefined) {
    params.push(values.name);
    assignments.push(`name = $${params.length}`);
  }
  if (values.timezone !== undefined) {
    params.push(values.timezone);
    assignments.push(`timezone = $${params.length}`);
  }
  if (assignments.length === 0) return getBusiness(businessId);

  assignments.push("updated_at = now()");
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ id: string }>(
      `UPDATE businesses
          SET ${assignments.join(", ")}
        WHERE id = $1
        RETURNING id`,
      params,
    ),
  );
  return rows[0] ? getBusiness(businessId) : null;
}

/**
 * How much industry-shaped data a business already holds — what the console
 * shows an admin *before* they change its industry, so the warning is a fact
 * rather than a generic scare. Cheap counts, all cross-tenant reads a platform
 * session is entitled to.
 */
export interface IndustryDataCounts {
  /** F&B catalogue rows (`menu_items`), meaningless to a retail industry. */
  menuItems: number;
  /** Phase 21 generic items (`items`), meaningless to F&B. */
  industryItems: number;
  /** Sales already recorded as orders. */
  orders: number;
  /** Journal entries already posted against this business's chart of accounts. */
  journalEntries: number;
}

export async function industryDataCounts(businessId: string): Promise<IndustryDataCounts> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{
      menu_items: string;
      industry_items: string;
      orders: string;
      journal_entries: string;
    }>(
      `SELECT (SELECT count(*) FROM menu_items m
                 JOIN locations l ON l.id = m.location_id WHERE l.business_id = $1) AS menu_items,
              (SELECT count(*) FROM items i
                 JOIN locations l ON l.id = i.location_id WHERE l.business_id = $1) AS industry_items,
              (SELECT count(*) FROM orders o
                 JOIN locations l ON l.id = o.location_id WHERE l.business_id = $1) AS orders,
              (SELECT count(*) FROM journal_entries j WHERE j.business_id = $1) AS journal_entries`,
      [businessId],
    );
    const row = rows[0];
    return {
      menuItems: Number(row?.menu_items ?? 0),
      industryItems: Number(row?.industry_items ?? 0),
      orders: Number(row?.orders ?? 0),
      journalEntries: Number(row?.journal_entries ?? 0),
    };
  });
}

/**
 * Change which industry a business operates in, and top up its chart of
 * accounts so the new industry's posting rules have the accounts they need.
 *
 * Migration 0048 originally made `industry` immutable *by omission* — no update
 * route existed — because the chart of accounts is seeded from it at creation
 * and there was no way to reconcile a switch. This is the deliberate reversal
 * of that (Phase 25 Wave 1, issue #234): an operator who mis-provisioned a
 * tenant, or a shop that genuinely changes trade, should not need a factory
 * reset.
 *
 * What it is careful *not* to do is rewrite history. Seeding is additive —
 * `seedChartOfAccounts` skips every code the business already has — so existing
 * accounts, their names, and every journal entry posted against them survive
 * untouched. Data belonging to the old industry's model (`menu_items` for an
 * ex-F&B business, `items` for an ex-retail one) is likewise left alone: it
 * simply stops being reachable from the new industry's UI. Reconciling it is
 * the operator's call, which is why `industryDataCounts` exists to tell them
 * what they are leaving behind before they confirm.
 */
export async function changeBusinessIndustry(
  businessId: string,
  industry: Industry,
): Promise<{ business: BusinessSummary; seededAccountCodes: string[] } | null> {
  const seededAccountCodes = await withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const { rows: previous } = await client.query<{ industry: Industry }>(
        `SELECT industry FROM businesses WHERE id = $1 FOR UPDATE`,
        [businessId],
      );
      if (!previous[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        `UPDATE businesses SET industry = $2, updated_at = now() WHERE id = $1`,
        [businessId, industry],
      );
      const seeded = await seedChartOfAccounts(client, businessId, industry);

      // Move the feature overrides across too, in both directions. Seeding the
      // new industry's defaults alone would leave a business switched *to*
      // food_service with no tables and no menu, because the overrides its old
      // trade seeded would still be sitting there switched off — so first clear
      // the ones the old industry turned off and the new one has no opinion
      // about. This can undo an operator's own manual "off" for one of those
      // flags; the console is where they turn it back off, and that is a better
      // failure than a café that silently has no floor plan.
      const stale = industryProfile(previous[0].industry).defaultDisabledFeatures.filter(
        (flag) => !industryProfile(industry).defaultDisabledFeatures.includes(flag),
      );
      if (stale.length > 0) {
        await client.query(
          `DELETE FROM business_features WHERE business_id = $1 AND flag_key = ANY($2)`,
          [businessId, stale],
        );
      }
      await disableFeatures(client, businessId, industryProfile(industry).defaultDisabledFeatures);

      await client.query("COMMIT");
      return seeded;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
  if (seededAccountCodes === null) return null;

  const business = await getBusiness(businessId);
  return business ? { business, seededAccountCodes } : null;
}

/**
 * A reset preserves the tenant's stable identity (id, slug, plan and timezone)
 * plus one active owner identity, but removes every tenant-owned row by
 * deleting and recreating the business in one transaction. Cascade handles
 * ordinary tenant records; the deliberately restrictive accounting and inventory
 * records are cleared first in one auditable, transaction-scoped helper.
 *
 * The recreated tenant begins with exactly one blank primary branch and owner
 * membership. It has no settings, chart of accounts, users, feature overrides
 * or operational data, so the owner returns to the initial setup wizard.
 */
export class ResetBusinessNotPossibleError extends Error {
  constructor() {
    super("reset_not_possible");
  }
}

const RESET_DEFAULT_LOCATION_NAME = "شعبه مرکزی";

/**
 * Removes the rows that intentionally use RESTRICT or immutable delete guards
 * before deleting a business root. The caller has already confirmed the
 * destructive action and opened a transaction; every statement is scoped to
 * the one locked business and the transaction rolls back as a unit on error.
 */
async function clearBusinessDeleteBlockers(client: PoolClient, businessId: string): Promise<void> {
  // The migration-only escape hatch is transaction-local. It lets the
  // explicitly confirmed factory reset pass accounting immutability guards,
  // while ordinary edits and deletes keep their existing protections.
  await client.query("SELECT set_config('app.factory_reset', 'true', true)");

  // Child writes take a key-share lock on their location. Lock the current
  // branch set before collecting/deleting data so a concurrent tenant request
  // cannot add a row halfway through this reset.
  await client.query("SELECT id FROM locations WHERE business_id = $1 FOR UPDATE", [businessId]);

  const statements = [
    // Dependent rows first: their foreign keys are deliberately restrictive
    // during normal operation to protect accounting provenance.
    `DELETE FROM inventory_transfer_allocations
       WHERE transfer_line_id IN (
         SELECT line.id
           FROM inventory_transfer_lines line
           JOIN inventory_transfers transfer_row ON transfer_row.id = line.transfer_id
          WHERE transfer_row.business_id = $1
       )`,
    `DELETE FROM inventory_transfer_lines
       WHERE transfer_id IN (SELECT id FROM inventory_transfers WHERE business_id = $1)`,
    `DELETE FROM customer_return_inventory_allocations
       WHERE customer_return_line_id IN (
         SELECT line.id
           FROM customer_return_lines line
           JOIN customer_returns return_row ON return_row.id = line.customer_return_id
          WHERE return_row.business_id = $1
       )`,
    `DELETE FROM customer_return_lines
       WHERE customer_return_id IN (SELECT id FROM customer_returns WHERE business_id = $1)`,
    `DELETE FROM supplier_return_lines
       WHERE supplier_return_id IN (SELECT id FROM supplier_returns WHERE business_id = $1)`,
    `DELETE FROM inventory_write_down_lines
       WHERE write_down_id IN (SELECT id FROM inventory_write_downs WHERE business_id = $1)`,
    `DELETE FROM inventory_cutover_lines
       WHERE cutover_id IN (SELECT id FROM inventory_cutovers WHERE business_id = $1)`,
    `DELETE FROM inventory_history_coverage
       WHERE cutover_id IN (SELECT id FROM inventory_cutovers WHERE business_id = $1)`,
    `DELETE FROM purchase_receipt_cost_allocations
       WHERE inventory_event_id IN (SELECT id FROM inventory_events WHERE business_id = $1)
          OR purchase_item_id IN (
            SELECT item.id
              FROM purchase_items item
              JOIN purchases purchase_row ON purchase_row.id = item.purchase_id
             WHERE purchase_row.location_id IN (SELECT id FROM locations WHERE business_id = $1)
          )`,
    `DELETE FROM inventory_negative_layer_settlements
       WHERE inventory_event_id IN (SELECT id FROM inventory_events WHERE business_id = $1)
          OR purchase_item_id IN (
            SELECT item.id
              FROM purchase_items item
              JOIN purchases purchase_row ON purchase_row.id = item.purchase_id
             WHERE purchase_row.location_id IN (SELECT id FROM locations WHERE business_id = $1)
          )`,
    `DELETE FROM order_item_inventory_snapshots
       WHERE order_item_id IN (
         SELECT item.id
           FROM order_items item
           JOIN orders order_row ON order_row.id = item.order_id
           JOIN locations location_row ON location_row.id = order_row.location_id
          WHERE location_row.business_id = $1
       )`,

    // Remove records that otherwise restrict customers, suppliers, accounts,
    // journal lines, inventory items, or the business root itself.
    "DELETE FROM bank_reconciliations WHERE business_id = $1",
    "DELETE FROM journal_entry_drafts WHERE business_id = $1",
    "DELETE FROM ar_receipts WHERE business_id = $1",
    "DELETE FROM ap_payments WHERE business_id = $1",
    "DELETE FROM expenses WHERE business_id = $1",
    "UPDATE inventory_write_downs SET reversal_of = NULL WHERE business_id = $1",
    "UPDATE inventory_events SET reversal_of = NULL WHERE business_id = $1",
    // Issue #795 — the serialized watch workflows pin their provenance with
    // RESTRICT onto orders and item_serials; a confirmed reset removes the
    // claims/holds before the sales and units they point at.
    "DELETE FROM serial_returns WHERE business_id = $1",
    "DELETE FROM serial_reservations WHERE business_id = $1",
    "DELETE FROM serial_preowned_intakes WHERE business_id = $1",
    "DELETE FROM customer_returns WHERE business_id = $1",
    "DELETE FROM supplier_returns WHERE business_id = $1",
    "DELETE FROM inventory_transfers WHERE business_id = $1",
    "DELETE FROM inventory_write_downs WHERE business_id = $1",
    "DELETE FROM inventory_cutovers WHERE business_id = $1",
    "DELETE FROM inventory_negative_layers WHERE business_id = $1",
    "DELETE FROM orders WHERE location_id IN (SELECT id FROM locations WHERE business_id = $1)",
    "DELETE FROM purchases WHERE location_id IN (SELECT id FROM locations WHERE business_id = $1)",
    "DELETE FROM stock_counts WHERE location_id IN (SELECT id FROM locations WHERE business_id = $1)",
    "DELETE FROM journal_entries WHERE business_id = $1",
    "DELETE FROM stock_movements WHERE location_id IN (SELECT id FROM locations WHERE business_id = $1)",
    "DELETE FROM inventory_lots WHERE location_id IN (SELECT id FROM locations WHERE business_id = $1)",
    "DELETE FROM inventory_events WHERE business_id = $1",
  ];

  for (const statement of statements) {
    await client.query(statement, [businessId]);
  }
}

export async function resetBusiness(businessId: string): Promise<void> {
  await withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      // Refuse before touching anything, inside the same transaction that
      // would have done the damage, so a concurrent call cannot slip between
      // the check and the first DELETE.
      const { rows: guardRows } = await client.query<{ ownership_kind: string }>(
        `SELECT ownership_kind FROM businesses WHERE id = $1 FOR UPDATE`,
        [businessId],
      );
      if (guardRows[0]?.ownership_kind === "platform_internal") {
        await client.query("ROLLBACK");
        throw new ProtectedInternalBusinessError();
      }

      const { rows: businessRows } = await client.query<{
        id: string;
        name: string;
        slug: string;
        plan: string;
        timezone: string;
        industry: string;
        subdomain: string;
      }>(
        // `subdomain` is as load-bearing here as `slug`: since Phase 23 it *is*
        // the tenant's origin, and the column defaults to a random
        // 'biz-<random>' (migration 0066). Re-inserting without it therefore
        // does not keep the old host — it silently mints a new one, and because
        // middleware compares the host's label against the session's
        // businessSubdomain claim and fails closed, everyone is locked out of
        // the address they had bookmarked with nothing to explain why.
        `SELECT id, name, slug::text AS slug, plan, timezone, industry,
                subdomain::text AS subdomain
           FROM businesses
          WHERE id = $1
          FOR UPDATE`,
        [businessId],
      );
      const business = businessRows[0];
      if (!business) throw new ResetBusinessNotPossibleError();

      // A reset must leave someone who can log in and finish setup. The
      // platform identity is intentionally retained because it may also hold
      // memberships in other businesses; all other memberships are deleted.
      const { rows: ownerRows } = await client.query<{
        platform_user_id: string;
        full_name: string;
        email: string;
      }>(
        `SELECT u.platform_user_id, u.full_name, p.email::text AS email
           FROM users u
           JOIN platform_users p ON p.id = u.platform_user_id
          WHERE u.business_id = $1
            AND u.role = 'owner'
            AND u.is_active
            AND p.is_active
          ORDER BY u.created_at
          LIMIT 1`,
        [businessId],
      );
      const owner = ownerRows[0];
      if (!owner) throw new ResetBusinessNotPossibleError();

      // Most tenant tables cascade from the business root. A small set of
      // accounting/inventory records deliberately uses RESTRICT and immutable
      // delete guards, so clear those reset-only blockers first.
      await clearBusinessDeleteBlockers(client, business.id);
      await client.query(`DELETE FROM businesses WHERE id = $1`, [businessId]);

      await client.query(
        `INSERT INTO businesses
           (id, name, slug, subdomain, status, plan, timezone, industry, suspended_at, archived_at)
         VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, NULL, NULL)`,
        [
          business.id,
          business.name,
          business.slug,
          business.subdomain,
          business.plan,
          business.timezone,
          business.industry,
        ],
      );

      const { rows: locationRows } = await client.query<{ id: string }>(
        `INSERT INTO locations (business_id, name, timezone)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [business.id, RESET_DEFAULT_LOCATION_NAME, business.timezone],
      );
      const locationId = locationRows[0].id;

      const { rows: ownerMembershipRows } = await client.query<{ id: string }>(
        `INSERT INTO users
           (business_id, platform_user_id, role, full_name, email, location_id)
         VALUES ($1, $2, 'owner', $3, $4, NULL)
         RETURNING id`,
        [business.id, owner.platform_user_id, owner.full_name, owner.email],
      );
      const ownerId = ownerMembershipRows[0].id;

      await client.query(
        `INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)`,
        [ownerId, locationId],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

/** Raised when the target business no longer exists (already deleted, or a bad id). */
export class BusinessNotFoundError extends Error {
  constructor() {
    super("not_found");
  }
}

/**
 * Hard-delete a business, immediately — no archive step, no grace window.
 * The caller must hold `business.delete` (owner-only) and the route requires
 * a fixed confirmation phrase; that pairing is the only safety net left once
 * this is immediate, so both are enforced before this is ever called.
 *
 * Normal tenant records cascade from `businesses(id)`; restrictive
 * accounting/inventory descendants are cleared in the same transaction first.
 * `platform_audit_log.business_id` is `ON DELETE SET NULL`, so the *record
 * that it happened* survives the business it happened to — which is the point.
 *
 * A hard delete is meant to remove *everything*, including the login: any
 * `platform_users` identity whose only membership was in this business is
 * purged along with it, so its email is free to sign up again. An identity
 * still holding a membership in another business is left alone — that's the
 * cross-business-owner case, not an orphan.
 */
export async function hardDeleteBusiness(businessId: string): Promise<void> {
  await withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      // The row is already locked here, so the ownership check rides on the
      // same SELECT rather than adding a second round trip.
      const { rows } = await client.query<{ id: string; ownership_kind: string }>(
        `SELECT id, ownership_kind FROM businesses WHERE id = $1 FOR UPDATE`,
        [businessId],
      );
      if (!rows[0]) throw new BusinessNotFoundError();
      if (rows[0].ownership_kind === "platform_internal") {
        await client.query("ROLLBACK");
        throw new ProtectedInternalBusinessError();
      }

      const { rows: memberIdentities } = await client.query<{ platform_user_id: string }>(
        `SELECT DISTINCT platform_user_id FROM users
          WHERE business_id = $1 AND platform_user_id IS NOT NULL`,
        [businessId],
      );

      await clearBusinessDeleteBlockers(client, businessId);
      await client.query(`DELETE FROM businesses WHERE id = $1`, [businessId]);

      if (memberIdentities.length > 0) {
        await client.query(
          `DELETE FROM platform_users
            WHERE id = ANY($1::uuid[])
              AND NOT EXISTS (SELECT 1 FROM users WHERE users.platform_user_id = platform_users.id)`,
          [memberIdentities.map((row) => row.platform_user_id)],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

// ---------------------------------------------------------------------------
// Feature flags & entitlements
// ---------------------------------------------------------------------------

export interface FeatureFlag {
  key: string;
  name: string;
  description: string | null;
  defaultEnabled: boolean;
}

export interface BusinessFeature extends FeatureFlag {
  /** The per-business override, or null when the business follows the default. */
  override: boolean | null;
  /** The value actually in force: override if set, else the flag default. */
  effective: boolean;
}

/** The global flag catalogue (feature_flags is not tenant data — see 0021). */
export async function listFeatureFlags(): Promise<FeatureFlag[]> {
  const { rows } = await query<{
    key: string;
    name: string;
    description: string | null;
    default_enabled: boolean;
  }>(`SELECT key, name, description, default_enabled FROM feature_flags ORDER BY key`);
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    defaultEnabled: r.default_enabled,
  }));
}

export interface Plan {
  key: string;
  name: string;
  branchLimit: number | null;
  memberLimit: number | null;
  monthlyOrderLimit: number | null;
}

/**
 * The global plan catalogue (billing_plans is not tenant data, same as
 * feature_flags — see migration 0176, which folded the old 0034 `plans`
 * limits catalogue into it). Only active plans are assignable: a retired
 * plan is a historical record, and a draft is not purchasable yet.
 */
export async function listPlans(): Promise<Plan[]> {
  const { rows } = await query<{
    key: string;
    name: string;
    branch_limit: number | null;
    member_limit: number | null;
    monthly_order_limit: number | null;
  }>(
    `SELECT key, name, branch_limit, member_limit, monthly_order_limit
       FROM billing_plans WHERE status = 'active' ORDER BY sort_order, key`,
  );
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    branchLimit: r.branch_limit,
    memberLimit: r.member_limit,
    monthlyOrderLimit: r.monthly_order_limit,
  }));
}

/** Every flag, with this business's override and the effective value resolved. */
export async function businessFeatures(businessId: string): Promise<BusinessFeature[]> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{
      key: string;
      name: string;
      description: string | null;
      default_enabled: boolean;
      override: boolean | null;
    }>(
      `SELECT f.key, f.name, f.description, f.default_enabled, bf.enabled AS override
         FROM feature_flags f
         LEFT JOIN business_features bf
           ON bf.flag_key = f.key AND bf.business_id = $1
        ORDER BY f.key`,
      [businessId],
    ),
  );
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    defaultEnabled: r.default_enabled,
    override: r.override,
    effective: r.override ?? r.default_enabled,
  }));
}

/**
 * Set or clear a per-business flag override.
 *
 * `enabled: null` deletes the override so the business falls back to the flag
 * default — the write side of the `business_features` table Phase 12 created,
 * and what Phase 17 will read to gate the UI and the API.
 */
export async function setBusinessFeature(
  businessId: string,
  flagKey: string,
  enabled: boolean | null,
): Promise<void> {
  await withoutTenantScope("platform", async () => {
    if (enabled === null) {
      await query(`DELETE FROM business_features WHERE business_id = $1 AND flag_key = $2`, [
        businessId,
        flagKey,
      ]);
      return;
    }
    await query(
      `INSERT INTO business_features (business_id, flag_key, enabled)
       VALUES ($1, $2, $3)
       ON CONFLICT (business_id, flag_key)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [businessId, flagKey, enabled],
    );
  });
}

// Issue #755 §3/§20: `setBusinessPlan` used to live here as a "thin
// compatibility seam" onto `changeBusinessPlan`. Nothing called it — there were
// no "internal callers that only need the column moved" — so it was a second,
// undeclared plan-mutation entry point that existed only to be an alternative
// path to the one authoritative one. Deleted rather than kept as a seam nobody
// crosses: `changeBusinessPlan` in subscription-service.ts is the single path,
// and the console reaches it through POST /api/platform/billing/subscriptions
// (`billing.manage`).

// ---------------------------------------------------------------------------
// Cross-business usage
// ---------------------------------------------------------------------------

export interface BusinessUsage {
  orders: number;
  openOrders: number;
  members: number;
  locations: number;
  menuItems: number;
  journalEntries: number;
  lastActivity: string | null;
}

/**
 * A business's usage snapshot: volume, membership, and last activity.
 *
 * Counts are per business rather than the whole deployment — the console shows
 * one business's numbers on its detail page. `lastActivity` is the most recent
 * of a few high-signal timestamps, which is enough to tell a live business
 * from a dormant one without a heavy scan. This single-business read enters
 * tenant scope even when called by the platform console (#810).
 */
export async function businessUsage(businessId: string): Promise<BusinessUsage> {
  const { rows } = await withTenant(businessId, () =>
    query<{
      orders: string;
      open_orders: string;
      members: string;
      locations: string;
      menu_items: string;
      journal_entries: string;
      last_activity: string | null;
    }>(
      `SELECT
         (SELECT count(*) FROM orders o
            JOIN locations l ON l.id = o.location_id WHERE l.business_id = $1) AS orders,
         (SELECT count(*) FROM orders o
            JOIN locations l ON l.id = o.location_id
           WHERE l.business_id = $1 AND o.status = 'open') AS open_orders,
         (SELECT count(*) FROM users u WHERE u.business_id = $1 AND u.is_active) AS members,
         (SELECT count(*) FROM locations l WHERE l.business_id = $1) AS locations,
         (SELECT count(*) FROM menu_items mi
            JOIN locations l ON l.id = mi.location_id WHERE l.business_id = $1) AS menu_items,
         (SELECT count(*) FROM journal_entries je WHERE je.business_id = $1) AS journal_entries,
         (SELECT max(o.opened_at) FROM orders o
            JOIN locations l ON l.id = o.location_id WHERE l.business_id = $1) AS last_activity`,
      [businessId],
    ),
  );
  const r = rows[0];
  return {
    orders: Number(r?.orders ?? 0),
    openOrders: Number(r?.open_orders ?? 0),
    members: Number(r?.members ?? 0),
    locations: Number(r?.locations ?? 0),
    menuItems: Number(r?.menu_items ?? 0),
    journalEntries: Number(r?.journal_entries ?? 0),
    lastActivity: r?.last_activity ?? null,
  };
}

// ---------------------------------------------------------------------------
// Impersonation grants — the consent-and-time-limit trail
// ---------------------------------------------------------------------------

export type ImpersonationMode = "read_only" | "controlled" | "full" | "emergency";

export interface ImpersonationGrant {
  id: string;
  platformAdminId: string;
  businessId: string;
  userId: string | null;
  mode: ImpersonationMode;
  reason: string | null;
  ticketId: string | null;
  operatorName: string | null;
  operatorRole: string | null;
  businessName: string | null;
  allowedCapabilities: string[];
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
  revokedAt: string | null;
  /**
   * Whether this grant belongs to the admin who is asking. The console's
   * Support page used to pick "the first active grant" and label it «نشست من»
   * whatever it was; ownership has to come from the server, because the browser
   * has no idea which platform admin it is signed in as.
   */
  isMine: boolean;
}

interface GrantRow extends Record<string, unknown> {
  id: string;
  platform_admin_id: string;
  business_id: string;
  user_id: string | null;
  mode: ImpersonationMode;
  reason: string | null;
  ticket_id: string | null;
  operator_name?: string | null;
  operator_role?: string | null;
  business_name?: string | null;
  allowed_capabilities: string[];
  created_at: string;
  expires_at: string;
  ended_at: string | null;
  revoked_at: string | null;
}

function toGrant(row: GrantRow, viewerAdminId?: string | null): ImpersonationGrant {
  return {
    isMine: Boolean(viewerAdminId) && row.platform_admin_id === viewerAdminId,
    id: row.id,
    platformAdminId: row.platform_admin_id,
    businessId: row.business_id,
    userId: row.user_id,
    mode: row.mode,
    reason: row.reason,
    ticketId: row.ticket_id,
    operatorName: row.operator_name ?? null,
    operatorRole: row.operator_role ?? null,
    businessName: row.business_name ?? null,
    allowedCapabilities: row.allowed_capabilities ?? [],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
    revokedAt: row.revoked_at,
  };
}

export class BusinessNotImpersonableError extends Error {
  constructor(reason: string) {
    super(reason);
  }
}

/**
 * The internal company cannot be reset, archived or deleted.
 *
 * The HTTP route already refused these with `protected_internal_business`;
 * this puts the same refusal in the service, because the route is only one
 * caller. A maintenance script, a future job or a new endpoint reaching for
 * `resetBusiness()` straight would otherwise wipe the platform's own books —
 * its ledger, its customer mappings and its billing outbox — and take the
 * correction of every other business's billing with it.
 */
export class ProtectedInternalBusinessError extends Error {
  constructor() {
    super("protected_internal_business");
  }
}

export class SupportSessionConflictError extends Error {
  constructor(public readonly grant: ImpersonationGrant) {
    super("active_support_session_exists");
  }
}

/**
 * Open an impersonation window into a business and return the grant plus the
 * owner membership the admin will act as.
 *
 * The grant row is written FIRST, in the same transaction that resolves the
 * membership, so a tenant session can never be minted without a durable record
 * naming the admin, the business, the mode and the window. That ordering is
 * the whole point: impersonation is impossible without leaving an audit record
 * (an exit criterion).
 *
 * The admin acts as an existing *owner* membership of the business, so every
 * tagged action is attributable to a real seat rather than a synthetic one.
 * An archived business cannot be entered; a suspended one can (support often
 * needs to look precisely because it is suspended).
 */
export async function startImpersonation(params: {
  adminId: string;
  businessId: string;
  mode: ImpersonationMode;
  reason?: string | null;
  minutes?: number;
  ticketId?: string | null;
  allowedCapabilities?: string[];
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<{
  grant: ImpersonationGrant;
  userId: string;
  fullName: string;
  /** The one-time plaintext handoff token — returned exactly once, never stored. */
  handoff: { token: string };
}> {
  const minutes = clampImpersonationMinutes(params.minutes);
  const reason = params.reason?.trim() ?? "";
  if (!validSupportReason(reason)) throw new BusinessNotImpersonableError("reason_too_short");

  return withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${params.adminId}:${params.businessId}`,
      ]);

      const { rows: bizRows } = await client.query<{ status: BusinessStatus; support_access_policy: string }>(
        `SELECT status::text AS status, support_access_policy FROM businesses WHERE id = $1`,
        [params.businessId],
      );
      if (!bizRows[0]) throw new BusinessNotImpersonableError("business_not_found");
      if (bizRows[0].status === "archived") {
        throw new BusinessNotImpersonableError("business_archived");
      }
      const policy = bizRows[0].support_access_policy;
      if (policy === "disabled") throw new BusinessNotImpersonableError("support_access_disabled");
      if (policy === "strict" || (policy === "approval_required" && params.mode !== "read_only")) {
        throw new BusinessNotImpersonableError("support_approval_required");
      }

      const existing = await client.query<GrantRow>(
        `SELECT id, platform_admin_id, business_id, user_id, mode, reason, ticket_id,
                allowed_capabilities, created_at, expires_at, ended_at, revoked_at
           FROM impersonation_grants
          WHERE platform_admin_id = $1 AND business_id = $2
            AND ended_at IS NULL AND revoked_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1`,
        [params.adminId, params.businessId],
      );
      if (existing.rows[0]) throw new SupportSessionConflictError(toGrant(existing.rows[0]));

      if (params.ticketId) {
        const ticket = await client.query(
          `SELECT 1 FROM support_tickets WHERE id = $1 AND business_id = $2`,
          [params.ticketId, params.businessId],
        );
        if (!ticket.rowCount) throw new BusinessNotImpersonableError("ticket_unavailable");
      }

      // Act as the oldest active owner of the business — a real membership, so
      // the acting user_id resolves to someone accountable inside the tenant.
      const { rows: ownerRows } = await client.query<{ id: string; full_name: string }>(
        `SELECT id, full_name FROM users
          WHERE business_id = $1 AND role = 'owner' AND is_active
          ORDER BY created_at LIMIT 1`,
        [params.businessId],
      );
      if (!ownerRows[0]) throw new BusinessNotImpersonableError("no_owner");

      const { rows: grantRows } = await client.query<GrantRow>(
        `INSERT INTO impersonation_grants
           (platform_admin_id, business_id, user_id, mode, reason, ticket_id, allowed_capabilities, emergency, platform_admin_token_version, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $4 = 'emergency', (SELECT token_version FROM platform_admins WHERE id = $1), now() + ($8 || ' minutes')::interval)
         RETURNING id, platform_admin_id, business_id, user_id, mode, reason, ticket_id, allowed_capabilities,
                   created_at, expires_at, ended_at, revoked_at`,
        [
          params.adminId,
          params.businessId,
          ownerRows[0].id,
          params.mode,
          reason,
          params.ticketId ?? null,
          params.allowedCapabilities ?? [],
          String(minutes),
        ],
      );

      // The handoff row is written in the same transaction as the grant, so a
      // browser can never be handed a token whose grant does not exist — the
      // same ordering guarantee the grant itself exists to provide. Only the
      // hash is stored; the plaintext goes back to the caller exactly once.
      const { token, tokenHash } = generateImpersonationHandoffToken();
      await client.query(
        `INSERT INTO impersonation_handoffs (grant_id, token_hash, expires_at)
         VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
        [grantRows[0].id, tokenHash, String(IMPERSONATION_HANDOFF_TTL_MINUTES)],
      );

      await client.query(
        `INSERT INTO notification_events
           (business_id, event_key, severity, title, body, url, payload, dedupe_key)
         VALUES ($1, 'support_session.started', $2, 'نشست پشتیبانی آغاز شد',
                 $3, '/settings/security/support-access', $4::jsonb, $5)
         ON CONFLICT (business_id, dedupe_key) DO NOTHING`,
        [
          params.businessId,
          params.mode === "read_only" ? "important" : "critical",
          `دلیل: ${reason} — سطح دسترسی: ${params.mode} — مدت: ${minutes} دقیقه`,
          JSON.stringify({ grantId: grantRows[0].id, mode: params.mode, ticketId: params.ticketId ?? null }),
          `support-session-started:${grantRows[0].id}`,
        ],
      );

      await client.query(
        `INSERT INTO platform_audit_log
           (platform_admin_id, business_id, action, entity, entity_id, payload, ip_address, user_agent)
         VALUES ($1, $2, 'support_session.started', 'impersonation_grant', $3, $4::jsonb, $5, $6)`,
        [
          params.adminId,
          params.businessId,
          grantRows[0].id,
          JSON.stringify({ grantId: grantRows[0].id, mode: params.mode, ticketId: params.ticketId ?? null, reason, minutes }),
          params.ipAddress ?? null,
          params.userAgent ?? null,
        ],
      );

      await client.query("COMMIT");
      return {
        grant: toGrant(grantRows[0]),
        userId: ownerRows[0].id,
        fullName: ownerRows[0].full_name,
        handoff: { token },
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

export type RedeemImpersonationHandoffResult =
  | {
      ok: true;
      grantId: string;
      adminId: string;
      mode: ImpersonationMode;
      allowedCapabilities: string[];
      userId: string;
      fullName: string;
      businessId: string;
      businessSlug: string;
      businessSubdomain: string;
    }
  | {
      ok: false;
      error: "invalid" | "expired" | "used" | "grant_inactive";
    };

/**
 * Redeem a handoff token — the business-origin half of entering a business.
 *
 * The console mints the token on admin.{root} (inside `startImpersonation`);
 * the browser presents it here, on the business's own origin, where the
 * host-scoped tenant cookie can actually be minted. This runs session-less and
 * bypassed for the same reason accept-invite does: the caller has no session
 * on this origin yet — the token is what creates the first one.
 *
 * Single-use is enforced by the row lock, not by a client check: two
 * concurrent redemptions serialize on `FOR UPDATE`, and the second sees the
 * first's `redeemed_at` stamp. The grant must still be live (not ended,
 * revoked or expired) and its owner membership must still exist, because the
 * token is only ever a pointer to the grant — the grant is what authorises the
 * session, re-checked here exactly as `activeGrant` re-checks it on every
 * subsequent request.
 */
export async function redeemImpersonationHandoff(
  token: string,
  expectedBusinessSubdomain?: string,
): Promise<RedeemImpersonationHandoffResult> {
  const tokenHash = hashImpersonationHandoffToken(token);

  return withoutTenantScope("impersonation-handoff", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query<{
        id: string;
        grant_id: string;
        expires_at: Date;
        redeemed_at: Date | null;
        admin_id: string;
        mode: string;
        user_id: string | null;
        business_id: string;
        business_slug: string;
        business_subdomain: string;
        full_name: string | null;
        allowedCapabilities: string[];
      }>(
        `SELECT h.id, h.grant_id, h.expires_at, h.redeemed_at,
                g.platform_admin_id AS admin_id, g.mode::text AS mode, g.user_id,
                g.allowed_capabilities AS "allowedCapabilities",
                b.id AS business_id, b.slug::text AS business_slug,
                b.subdomain::text AS business_subdomain,
                u.full_name
           FROM impersonation_handoffs h
           JOIN impersonation_grants g ON g.id = h.grant_id
           JOIN businesses b ON b.id = g.business_id
           LEFT JOIN users u ON u.id = g.user_id
          WHERE h.token_hash = $1
          FOR UPDATE OF h`,
        [tokenHash],
      );

      const handoff = rows[0];
      if (!handoff) {
        await client.query("ROLLBACK");
        return { ok: false as const, error: "invalid" as const };
      }
      if (handoff.redeemed_at) {
        await client.query("ROLLBACK");
        return { ok: false as const, error: "used" as const };
      }
      if (handoff.expires_at.getTime() <= Date.now()) {
        await client.query("ROLLBACK");
        return { ok: false as const, error: "expired" as const };
      }
      if (expectedBusinessSubdomain && handoff.business_subdomain !== expectedBusinessSubdomain) {
        await client.query("ROLLBACK");
        return { ok: false as const, error: "invalid" as const };
      }

      // The grant must still be open, and its owner membership must still
      // exist (grant.user_id is nullable precisely because it may be deleted
      // mid-window) — a live grant with no seat to act as mints nothing.
      const grantLive = await client.query<{ live: boolean }>(
        `SELECT (ended_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS live
           FROM impersonation_grants WHERE id = $1`,
        [handoff.grant_id],
      );
      if (!handoff.user_id || !handoff.full_name || !grantLive.rows[0]?.live) {
        await client.query("ROLLBACK");
        return { ok: false as const, error: "grant_inactive" as const };
      }

      await client.query(
        `UPDATE impersonation_handoffs SET redeemed_at = now() WHERE id = $1`,
        [handoff.id],
      );

      await client.query("COMMIT");
      return {
        ok: true as const,
        grantId: handoff.grant_id,
        adminId: handoff.admin_id,
        mode: handoff.mode as ImpersonationMode,
        allowedCapabilities: handoff.allowedCapabilities,
        userId: handoff.user_id,
        fullName: handoff.full_name,
        businessId: handoff.business_id,
        businessSlug: handoff.business_slug,
        businessSubdomain: handoff.business_subdomain,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * The live grant for an (admin, business) pair right now, or null.
 *
 * "Live" = created, not ended, not revoked, not expired. This is the check the
 * impersonation guard runs on every request carrying an impersonation claim:
 * the tenant token alone is never trusted; the grant must still be open in the
 * database, so ending or revoking a window takes effect on the next request.
 */
export async function activeGrant(
  grantId: string,
  adminId: string,
  businessId: string,
): Promise<ImpersonationGrant | null> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<GrantRow & { operator_role: PlatformAdminRole }>(
      `SELECT g.id, g.platform_admin_id, g.business_id, g.user_id, g.mode, g.reason,
              g.ticket_id, g.allowed_capabilities, g.created_at, g.expires_at, g.ended_at, g.revoked_at,
              pa.role::text AS operator_role
         FROM impersonation_grants g
         JOIN platform_admins pa ON pa.id = g.platform_admin_id AND pa.is_active
           AND (g.platform_admin_token_version IS NULL OR g.platform_admin_token_version = pa.token_version)
         JOIN businesses b ON b.id = g.business_id AND b.status <> 'archived' AND b.support_access_policy <> 'disabled'
        WHERE g.id = $1 AND g.platform_admin_id = $2 AND g.business_id = $3
          AND g.ended_at IS NULL AND g.revoked_at IS NULL AND g.expires_at > now()
        LIMIT 1`,
      [grantId, adminId, businessId],
    ),
  );
  const row = rows[0];
  if (!row) return null;
  const capability = row.mode === "full" || row.mode === "emergency"
    ? "impersonate.full"
    : row.mode === "controlled"
      ? "impersonate.controlled"
      : "impersonate.readOnly";
  return platformCan(row.operator_role, capability) ? toGrant(row) : null;
}

export type ResumeImpersonationResult =
  | {
      ok: true;
      grant: ImpersonationGrant;
      userId: string;
      fullName: string;
      /** A fresh one-time handoff token; returned once, never stored plaintext. */
      handoff: { token: string };
    }
  | { ok: false; error: "not_active" };

/**
 * Re-enter a support session that is already open — what «ادامه نشست فعلی»
 * in the console must actually do. It used to open the *create* dialog instead,
 * because no endpoint could re-enter an existing grant.
 *
 * It authorizes with `activeGrant` — the same live re-check every impersonated
 * request already goes through — rather than a second, looser predicate. That
 * one call covers the whole security story: the grant belongs to *this* admin,
 * it was not ended or revoked, it has not expired, the admin is still active
 * and their token version still matches, the business is not archived and has
 * not disabled support access, and the operator's role still holds the
 * capability for the grant's mode. A resumed session is therefore never
 * stronger or longer-lived than the one it continues: the grant's own expiry
 * is unchanged, and only a new short-lived handoff token is minted.
 */
export async function resumeImpersonation(params: {
  grantId: string;
  adminId: string;
  businessId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<ResumeImpersonationResult> {
  const grant = await activeGrant(params.grantId, params.adminId, params.businessId);
  if (!grant || !grant.userId) return { ok: false, error: "not_active" };

  const { token, tokenHash } = generateImpersonationHandoffToken();

  return withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      // The handoff row and its audit entry are written together, so a token
      // can never exist without a record of who re-entered.
      await client.query(
        `INSERT INTO impersonation_handoffs (grant_id, token_hash, expires_at)
         VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
        [params.grantId, tokenHash, String(IMPERSONATION_HANDOFF_TTL_MINUTES)],
      );
      await client.query(
        `INSERT INTO platform_audit_log
           (platform_admin_id, business_id, action, entity, entity_id, payload, ip_address, user_agent)
         VALUES ($1, $2, 'support_session.resumed', 'impersonation_grant', $3, $4::jsonb, $5, $6)`,
        [
          params.adminId,
          params.businessId,
          params.grantId,
          JSON.stringify({ grantId: params.grantId, mode: grant.mode, expiresAt: grant.expiresAt }),
          params.ipAddress ?? null,
          params.userAgent ?? null,
        ],
      );
      const { rows } = await client.query<{ full_name: string }>(
        `SELECT full_name FROM users WHERE id = $1`,
        [grant.userId],
      );
      await client.query("COMMIT");
      return {
        ok: true as const,
        grant,
        userId: grant.userId as string,
        fullName: rows[0]?.full_name ?? "",
        handoff: { token },
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Who is closing a support session, and therefore which grants they may touch:
 *
 *   - `operator` — the admin leaving their *own* session (the tenant banner's
 *     «پایان نشست», or «پایان نشست من» in the console). Scoped to their grant,
 *     and to one business when the caller knows it from a signed token.
 *   - `platform_admin` — the kill switch: any grant, `impersonate.revoke`.
 *   - `tenant_admin` — the business's own owner/admin, only grants on their business.
 */
export type SupportSessionCloser =
  | { type: "operator"; adminId: string; businessId?: string }
  | { type: "platform_admin"; adminId: string }
  | { type: "tenant_admin"; userId: string; businessId: string };

export type SupportSessionCloseResult =
  | {
      status: "ended" | "revoked" | "expired";
      session: { id: string; adminId: string; businessId: string; startedAt: string; endedAt: string };
    }
  | { status: "not_active" };

/**
 * The one way a support session stops: every exit — the operator leaving, a
 * console revoke, the business revoking, and the window running out — goes
 * through this single statement, so there is one lifecycle
 * (active → ended | revoked | expired) and one audit trail for it.
 *
 * Atomic by construction: the UPDATE only matches a grant that is not yet
 * closed, so of two racing closes exactly one changes the row and writes the
 * audit row in the same statement; the other returns `not_active`. A closed
 * grant is never reopened — nothing writes `ended_at`/`revoked_at` back to NULL.
 *
 * A grant whose window already ran out is stamped `ended_by_type = 'system'`
 * with `ended_at = expires_at` and audited as `support_session.expired`,
 * whoever happened to notice, so an expiry is told apart from a manual end.
 * `activeGrant` never needed that stamp to refuse it; the stamp is the record.
 */
export async function closeSupportSession(
  grantId: string,
  closer: SupportSessionCloser,
  meta: { channel: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<SupportSessionCloseResult> {
  if (!isUuid(grantId)) return { status: "not_active" };
  const adminScope = closer.type === "operator" ? closer.adminId : null;
  const businessScope = closer.type === "platform_admin" ? null : (closer.businessId ?? null);
  const actorId = closer.type === "tenant_admin" ? closer.userId : closer.adminId;

  const { rows } = await withoutTenantScope("platform", () =>
    query<{
      id: string;
      platform_admin_id: string;
      business_id: string;
      created_at: Date;
      closed_at: Date;
      ended_by_type: "operator" | "platform_admin" | "tenant_admin" | "system";
    }>(
      `WITH closed AS (
         UPDATE impersonation_grants g
            SET ended_at = CASE WHEN g.expires_at <= now() THEN g.expires_at
                                WHEN $4::text = 'operator' THEN now()
                                ELSE NULL END,
                revoked_at = CASE WHEN g.expires_at > now() AND $4::text <> 'operator' THEN now() ELSE NULL END,
                revoked_by = CASE WHEN g.expires_at > now() AND $4::text = 'platform_admin' THEN $5::uuid ELSE NULL END,
                ended_by_type = CASE WHEN g.expires_at <= now() THEN 'system' ELSE $4::text END,
                ended_by_id = CASE WHEN g.expires_at <= now() THEN NULL ELSE $5::uuid END
          WHERE g.id = $1 AND g.ended_at IS NULL AND g.revoked_at IS NULL
            AND ($2::uuid IS NULL OR g.platform_admin_id = $2::uuid)
            AND ($3::uuid IS NULL OR g.business_id = $3::uuid)
          RETURNING g.id, g.platform_admin_id, g.business_id, g.created_at,
                    COALESCE(g.revoked_at, g.ended_at) AS closed_at, g.ended_by_type
       ), audit AS (
         INSERT INTO platform_audit_log
           (platform_admin_id, business_id, action, entity, entity_id, payload, ip_address, user_agent)
         SELECT CASE WHEN c.ended_by_type = 'platform_admin' THEN $5::uuid ELSE c.platform_admin_id END,
                c.business_id,
                CASE c.ended_by_type
                  WHEN 'system' THEN 'support_session.expired'
                  WHEN 'operator' THEN 'support_session.ended'
                  WHEN 'platform_admin' THEN 'support_session.revoked'
                  ELSE 'support_session.tenant_revoked' END,
                'impersonation_grant', c.id::text,
                jsonb_build_object(
                  'sessionId', c.id,
                  'operatorId', c.platform_admin_id,
                  'businessId', c.business_id,
                  'startedAt', c.created_at,
                  'endedAt', c.closed_at,
                  'durationSeconds', floor(extract(epoch FROM c.closed_at - c.created_at))::int,
                  'source', CASE WHEN c.ended_by_type = 'system' THEN 'expired' ELSE 'manual' END,
                  'endedByType', c.ended_by_type,
                  'endedById', CASE WHEN c.ended_by_type = 'system' THEN NULL ELSE $5::uuid END,
                  'channel', $6::text),
                $7, $8
           FROM closed c
       )
       SELECT id, platform_admin_id, business_id, created_at, closed_at, ended_by_type FROM closed`,
      [grantId, adminScope, businessScope, closer.type, actorId, meta.channel, meta.ipAddress ?? null, meta.userAgent ?? null],
    ),
  );

  const row = rows[0];
  if (!row) return { status: "not_active" };
  return {
    status: row.ended_by_type === "system" ? "expired" : row.ended_by_type === "operator" ? "ended" : "revoked",
    session: {
      id: row.id,
      adminId: row.platform_admin_id,
      businessId: row.business_id,
      startedAt: new Date(row.created_at).toISOString(),
      endedAt: new Date(row.closed_at).toISOString(),
    },
  };
}

export async function getGrant(
  grantId: string,
  businessId: string,
  viewerAdminId?: string | null,
): Promise<ImpersonationGrant | null> {
  const { rows } = await withoutTenantScope("platform", () => query<GrantRow>(
    `SELECT g.id, g.platform_admin_id, g.business_id, g.user_id, g.mode, g.reason,
            g.ticket_id, g.allowed_capabilities, pa.full_name AS operator_name,
            pa.role::text AS operator_role, b.name AS business_name,
            g.created_at, g.expires_at, g.ended_at, g.revoked_at
       FROM impersonation_grants g
       JOIN platform_admins pa ON pa.id = g.platform_admin_id
       JOIN businesses b ON b.id = g.business_id
      WHERE g.id = $1 AND g.business_id = $2`,
    [grantId, businessId],
  ));
  return rows[0] ? toGrant(rows[0], viewerAdminId) : null;
}

/**
 * Recent impersonation grants across the platform, or scoped to one business.
 *
 * `viewerAdminId` is the admin reading the list; each grant comes back with
 * `isMine` so the caller can tell their own session from a colleague's rather
 * than assuming the newest active row is theirs.
 */
export async function listGrants(
  businessId?: string,
  viewerAdminId?: string | null,
): Promise<ImpersonationGrant[]> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<GrantRow>(
      `SELECT g.id, g.platform_admin_id, g.business_id, g.user_id, g.mode, g.reason,
              g.ticket_id, g.allowed_capabilities, pa.full_name AS operator_name,
              pa.role::text AS operator_role, b.name AS business_name,
              g.created_at, g.expires_at, g.ended_at, g.revoked_at
         FROM impersonation_grants g
         JOIN platform_admins pa ON pa.id = g.platform_admin_id
         JOIN businesses b ON b.id = g.business_id
        WHERE ($1::uuid IS NULL OR g.business_id = $1)
        ORDER BY g.created_at DESC LIMIT 100`,
      [businessId ?? null],
    ),
  );
  return rows.map((row) => toGrant(row, viewerAdminId));
}

// ---------------------------------------------------------------------------
// User bug reports
// ---------------------------------------------------------------------------

export interface PlatformBugReportSummary {
  id: string;
  businessId: string;
  businessName: string;
  locationId: string | null;
  locationName: string | null;
  userId: string | null;
  userName: string | null;
  userRole: string | null;
  description: string;
  pageUrl: string | null;
  viewport: string | null;
  hasScreenshot: boolean;
  status: string;
  createdAt: string;
}

export interface PlatformBugReport extends PlatformBugReportSummary {
  screenshot: string | null;
  userAgent: string | null;
}

interface PlatformBugReportRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  business_name: string;
  location_id: string | null;
  location_name: string | null;
  user_id: string | null;
  user_name: string | null;
  user_role: string | null;
  description: string;
  screenshot: string | null;
  has_screenshot: boolean;
  page_url: string | null;
  user_agent: string | null;
  viewport: string | null;
  status: string;
  created_at: string;
}

function toPlatformBugReport(row: PlatformBugReportRow): PlatformBugReport {
  return {
    id: row.id,
    businessId: row.business_id,
    businessName: row.business_name,
    locationId: row.location_id,
    locationName: row.location_name,
    userId: row.user_id,
    userName: row.user_name,
    userRole: row.user_role,
    description: row.description,
    screenshot: row.screenshot,
    pageUrl: row.page_url,
    userAgent: row.user_agent,
    viewport: row.viewport,
    hasScreenshot: row.has_screenshot,
    status: row.status,
    createdAt: row.created_at,
  };
}

export interface BugReportQuery {
  /** Exact lifecycle status (new/in_progress/resolved/closed). */
  status?: string;
  /** Free-text over business name, reporter name, description, page url. */
  search?: string;
  businessId?: string;
  page?: number;
  pageSize?: number;
}

export interface BugReportListResult {
  reports: PlatformBugReportSummary[];
  total: number;
  page: number;
  pageSize: number;
  /** Count by lifecycle status across the *unfiltered* inbox, for headline tiles. */
  statusCounts: Record<string, number>;
}

/**
 * Server-paginated bug-report inbox. Screenshots are never included here (they
 * are multi-megabyte data URLs); the detail endpoint loads one on demand. The
 * status tiles are computed from the whole inbox, not the current page, so the
 * "new" count stays honest while an operator filters.
 */
export async function queryBugReports(q: BugReportQuery = {}): Promise<BugReportListResult> {
  const page = Math.max(1, Math.floor(q.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(q.pageSize ?? 40)));
  const offset = (page - 1) * pageSize;

  return withoutTenantScope("platform", async () => {
    const where: string[] = [];
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (q.status && q.status.trim()) where.push(`br.status = ${bind(q.status.trim().slice(0, 40))}`);
    if (q.businessId) where.push(`br.business_id = ${bind(q.businessId)}::uuid`);
    if (q.search && q.search.trim()) {
      const p = bind(`%${q.search.trim().slice(0, 200)}%`);
      where.push(
        `concat_ws(' ', b.name, u.full_name, br.description, br.page_url) ILIKE ${p}`,
      );
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const joins = `JOIN businesses b ON b.id = br.business_id
                   LEFT JOIN locations l ON l.id = br.location_id
                   LEFT JOIN users u ON u.id = br.user_id`;

    const { rows: countRows } = await query<{ total: string }>(
      `SELECT count(*)::text AS total FROM bug_reports br ${joins} ${whereSql}`,
      params,
    );
    const total = Number(countRows[0]?.total ?? 0);

    const { rows: statusRows } = await query<{ status: string; total: string }>(
      `SELECT status, count(*)::text AS total FROM bug_reports GROUP BY status`,
    );
    const statusCounts: Record<string, number> = {};
    for (const row of statusRows) statusCounts[row.status] = Number(row.total);

    const { rows } = await query<PlatformBugReportRow>(
      `SELECT br.id::text AS id, br.business_id::text AS business_id, b.name AS business_name,
              br.location_id::text AS location_id, l.name AS location_name,
              br.user_id::text AS user_id, u.full_name AS user_name,
              u.role::text AS user_role, br.description, NULL::text AS screenshot,
              (br.screenshot IS NOT NULL) AS has_screenshot,
              br.page_url, NULL::text AS user_agent, br.viewport, br.status, br.created_at
         FROM bug_reports br
         ${joins}
        ${whereSql}
        ORDER BY br.created_at DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params,
    );

    return {
      reports: rows.map((row) => ({ ...toPlatformBugReport(row), screenshot: null, userAgent: null })),
      total,
      page,
      pageSize,
      statusCounts,
    };
  });
}

/** One report, including its optional screenshot and browser context. */
export async function getBugReport(reportId: string): Promise<PlatformBugReport | null> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<PlatformBugReportRow>(
      `SELECT br.id::text AS id, br.business_id::text AS business_id, b.name AS business_name,
              br.location_id::text AS location_id, l.name AS location_name,
              br.user_id::text AS user_id, u.full_name AS user_name,
              u.role::text AS user_role, br.description, br.screenshot,
              (br.screenshot IS NOT NULL) AS has_screenshot,
              br.page_url, br.user_agent, br.viewport, br.status, br.created_at
         FROM bug_reports br
         JOIN businesses b ON b.id = br.business_id
         LEFT JOIN locations l ON l.id = br.location_id
         LEFT JOIN users u ON u.id = br.user_id
        WHERE br.id = $1::uuid`,
      [reportId],
    ),
  );
  return rows[0] ? toPlatformBugReport(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Support ticketing — the platform half (migration 0130)
//
// The member half lives in src/lib/support-service.ts; this is the console's
// cross-tenant view of the same two tables, read and written through the
// documented `withoutTenantScope("platform", …)` bypass, the same shape as
// bug reports. Every write is audited to platform_audit_log.
// ---------------------------------------------------------------------------

export interface PlatformSupportTicketSummary {
  id: string;
  businessId: string;
  businessName: string;
  locationId: string | null;
  locationName: string | null;
  userId: string | null;
  userName: string | null;
  userRole: string | null;
  subject: string;
  category: string;
  priority: string;
  status: string;
  assignedAdminId: string | null;
  assignedAdminName: string | null;
  messageCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PlatformSupportTicketMessage {
  id: string;
  ticketId: string;
  authorType: "member" | "admin";
  userId: string | null;
  userName: string | null;
  adminId: string | null;
  adminName: string | null;
  body: string;
  attachment: string | null;
  createdAt: string;
}

interface PlatformSupportTicketMessageRow extends Record<string, unknown> {
  id: string;
  ticket_id: string;
  author_type: "member" | "admin";
  user_id: string | null;
  user_name: string | null;
  admin_id: string | null;
  admin_name: string | null;
  body: string;
  attachment: string | null;
  created_at: string;
}

function toPlatformSupportTicketMessage(row: PlatformSupportTicketMessageRow): PlatformSupportTicketMessage {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    authorType: row.author_type,
    userId: row.user_id,
    userName: row.user_name,
    adminId: row.admin_id,
    adminName: row.admin_name,
    body: row.body,
    attachment: row.attachment,
    createdAt: row.created_at,
  };
}

export interface PlatformSupportTicketDetail extends PlatformSupportTicketSummary {
  messages: PlatformSupportTicketMessage[];
}

interface PlatformSupportTicketRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  business_name: string;
  location_id: string | null;
  location_name: string | null;
  user_id: string | null;
  user_name: string | null;
  user_role: string | null;
  subject: string;
  category: string;
  priority: string;
  status: string;
  assigned_admin_id: string | null;
  assigned_admin_name: string | null;
  message_count: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

const PLATFORM_TICKET_SELECT = `
  SELECT t.id::text AS id, t.business_id::text AS business_id, b.name AS business_name,
         t.location_id::text AS location_id, l.name AS location_name,
         t.user_id::text AS user_id, u.full_name AS user_name, u.role::text AS user_role,
         t.subject, t.category, t.priority, t.status,
         t.assigned_admin_id::text AS assigned_admin_id, pa.full_name AS assigned_admin_name,
         (SELECT count(*) FROM support_ticket_messages m WHERE m.ticket_id = t.id)::text AS message_count,
         (SELECT max(m.created_at) FROM support_ticket_messages m WHERE m.ticket_id = t.id) AS last_message_at,
         (SELECT left(m.body, 200) FROM support_ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_preview,
         t.created_at, t.updated_at, t.closed_at
    FROM support_tickets t
    JOIN businesses b ON b.id = t.business_id
    LEFT JOIN locations l ON l.id = t.location_id
    LEFT JOIN users u ON u.id = t.user_id
    LEFT JOIN platform_admins pa ON pa.id = t.assigned_admin_id
`;

function toPlatformSupportTicket(row: PlatformSupportTicketRow): PlatformSupportTicketSummary {
  return {
    id: row.id,
    businessId: row.business_id,
    businessName: row.business_name,
    locationId: row.location_id,
    locationName: row.location_name,
    userId: row.user_id,
    userName: row.user_name,
    userRole: row.user_role,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    status: row.status,
    assignedAdminId: row.assigned_admin_id,
    assignedAdminName: row.assigned_admin_name,
    messageCount: Number(row.message_count),
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

export interface SupportTicketQuery {
  status?: string;
  priority?: string;
  category?: string;
  search?: string;
  businessId?: string;
  /** Restrict to tickets assigned to `adminId`. */
  assignedToMe?: boolean;
  adminId?: string;
  page?: number;
  pageSize?: number;
}

export interface SupportTicketListResult {
  tickets: PlatformSupportTicketSummary[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Server-paginated support desk. Same filters as the console's toolbar, but the
 * free-text search — which scans the whole conversation — runs in SQL, and the
 * result is a bounded page rather than the whole (potentially large) queue.
 */
export async function querySupportTickets(q: SupportTicketQuery = {}): Promise<SupportTicketListResult> {
  const page = Math.max(1, Math.floor(q.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(q.pageSize ?? 40)));
  const offset = (page - 1) * pageSize;

  return withoutTenantScope("platform", async () => {
    const where: string[] = [];
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (q.status && q.status.trim()) where.push(`t.status = ${bind(q.status.trim().slice(0, 40))}`);
    if (q.priority && q.priority.trim()) where.push(`t.priority = ${bind(q.priority.trim().slice(0, 20))}`);
    if (q.category && q.category.trim()) where.push(`t.category = ${bind(q.category.trim().slice(0, 20))}`);
    if (q.businessId && q.businessId.trim()) where.push(`t.business_id = ${bind(q.businessId.trim())}::uuid`);
    if (q.assignedToMe && q.adminId) where.push(`t.assigned_admin_id = ${bind(q.adminId)}::uuid`);
    if (q.search && q.search.trim()) {
      const p = bind(`%${q.search.trim().slice(0, 200)}%`);
      where.push(
        `concat_ws(' ', b.name, u.full_name, t.subject,
          (SELECT string_agg(m.body, ' ') FROM support_ticket_messages m WHERE m.ticket_id = t.id)
        ) ILIKE ${p}`,
      );
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const { rows: countRows } = await query<{ total: string }>(
      `SELECT count(*)::text AS total
         FROM support_tickets t
         JOIN businesses b ON b.id = t.business_id
         LEFT JOIN users u ON u.id = t.user_id
        ${whereSql}`,
      params,
    );
    const total = Number(countRows[0]?.total ?? 0);

    const { rows } = await query<PlatformSupportTicketRow>(
      `${PLATFORM_TICKET_SELECT}
        ${whereSql}
       ORDER BY t.updated_at DESC
       LIMIT ${pageSize} OFFSET ${offset}`,
      params,
    );

    return { tickets: rows.map(toPlatformSupportTicket), total, page, pageSize };
  });
}

/** One ticket with its full conversation, for the console. */
export async function getSupportTicket(ticketId: string): Promise<PlatformSupportTicketDetail | null> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<PlatformSupportTicketRow>(`${PLATFORM_TICKET_SELECT} WHERE t.id = $1::uuid`, [ticketId]),
  );
  const row = rows[0];
  if (!row) return null;

  const { rows: messages } = await withoutTenantScope("platform", () =>
    query<PlatformSupportTicketMessageRow>(
      `SELECT m.id::text AS id, m.ticket_id::text AS ticket_id, m.author_type AS author_type,
              m.user_id::text AS user_id, u.full_name AS user_name,
              m.admin_id::text AS admin_id, pa.full_name AS admin_name,
              m.body, m.attachment, m.created_at
         FROM support_ticket_messages m
         LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN platform_admins pa ON pa.id = m.admin_id
        WHERE m.ticket_id = $1::uuid
        ORDER BY m.created_at ASC`,
      [ticketId],
    ),
  );
  return { ...toPlatformSupportTicket(row), messages: messages.map(toPlatformSupportTicketMessage) };
}

/**
 * The console's answer to a ticket. The reply hands the ticket back to the
 * member (`waiting_customer`) unless it is closed, and every reply is audited.
 */
export async function addSupportMessage({
  ticketId,
  adminId,
  body,
  attachment,
  ipAddress,
  userAgent,
}: {
  ticketId: string;
  adminId: string;
  body: string;
  attachment: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<PlatformSupportTicketMessage> {
  return withoutTenantScope("platform", async () => {
    const { rows: ticketRows } = await query<{ id: string; business_id: string; status: string }>(
      `SELECT id::text AS id, business_id::text AS business_id, status FROM support_tickets WHERE id = $1::uuid`,
      [ticketId],
    );
    const ticket = ticketRows[0];
    if (!ticket) throw new SupportTicketNotFoundError();

    const nextStatus = statusAfterAdminReply(ticket.status);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO support_ticket_messages (ticket_id, business_id, author_type, admin_id, body, attachment)
       VALUES ($1::uuid, $2::uuid, 'admin', $3, $4, $5)
       RETURNING id::text AS id`,
      [ticketId, ticket.business_id, adminId, body, attachment],
    );
    await query(
      `UPDATE support_tickets SET status = $2, updated_at = now() WHERE id = $1::uuid`,
      [ticketId, nextStatus],
    );

    await platformAudit({
      adminId,
      businessId: ticket.business_id,
      action: "support.ticket.reply",
      entity: "support_ticket",
      entityId: ticketId,
      payload: { status: nextStatus },
      ipAddress,
      userAgent,
    });

    const { rows: messageRows } = await query<PlatformSupportTicketMessageRow>(
      `SELECT m.id::text AS id, m.ticket_id::text AS ticket_id, m.author_type AS author_type,
              m.user_id::text AS user_id, u.full_name AS user_name,
              m.admin_id::text AS admin_id, pa.full_name AS admin_name,
              m.body, m.attachment, m.created_at
         FROM support_ticket_messages m
         LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN platform_admins pa ON pa.id = m.admin_id
        WHERE m.id = $1::uuid`,
      [rows[0].id],
    );
    return toPlatformSupportTicketMessage(messageRows[0]);
  });
}

/**
 * The console's lifecycle controls: status, priority, category, assignment.
 * Every changed field is audited individually.
 */
export async function updateSupportTicket({
  ticketId,
  adminId,
  status,
  priority,
  category,
  assignedAdminId,
  ipAddress,
  userAgent,
}: {
  ticketId: string;
  adminId: string;
  status?: string;
  priority?: string;
  category?: string;
  assignedAdminId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<PlatformSupportTicketDetail | null> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<PlatformSupportTicketRow>(`${PLATFORM_TICKET_SELECT} WHERE t.id = $1::uuid`, [ticketId]);
    const ticket = rows[0];
    if (!ticket) throw new SupportTicketNotFoundError();

    const changes: Record<string, string | null> = {};
    if (status !== undefined) {
      if (!isTicketStatus(status)) throw new Error("invalid_status");
      if (status !== ticket.status) changes.status = status;
    }
    if (priority !== undefined) {
      if (!isTicketPriority(priority)) throw new Error("invalid_priority");
      if (priority !== ticket.priority) changes.priority = priority;
    }
    if (category !== undefined) {
      if (!isTicketCategory(category)) throw new Error("invalid_category");
      if (category !== ticket.category) changes.category = category;
    }
    if (assignedAdminId !== undefined) {
      const next = assignedAdminId || null;
      if (next !== ticket.assigned_admin_id) changes.assigned_admin_id = next;
    }

    if (Object.keys(changes).length === 0) {
      return getSupportTicket(ticketId);
    }

    if (changes.assigned_admin_id !== undefined && changes.assigned_admin_id !== null) {
      const { rows: admins } = await query<{ id: string }>(
        `SELECT id FROM platform_admins WHERE id = $1::uuid AND is_active`,
        [changes.assigned_admin_id],
      );
      if (!admins[0]) throw new Error("invalid_assignee");
    }

    const sets: string[] = ["updated_at = now()"];
    const values: unknown[] = [ticketId];
    if (changes.status !== undefined) {
      values.push(changes.status);
      sets.push(`status = $${values.length}`);
      // Closing stamps the timestamp; leaving closed clears it. Same parameter,
      // so the two can never disagree.
      sets.push(`closed_at = CASE WHEN $${values.length} = 'closed' THEN now() ELSE NULL END`);
    }
    if (changes.priority !== undefined) {
      values.push(changes.priority);
      sets.push(`priority = $${values.length}`);
    }
    if (changes.category !== undefined) {
      values.push(changes.category);
      sets.push(`category = $${values.length}`);
    }
    if (changes.assigned_admin_id !== undefined) {
      values.push(changes.assigned_admin_id);
      sets.push(`assigned_admin_id = $${values.length}`);
    }
    await query(
      `UPDATE support_tickets t SET ${sets.join(", ")} WHERE t.id = $1::uuid`,
      values,
    );

    await platformAudit({
      adminId,
      businessId: ticket.business_id,
      action: "support.ticket.update",
      entity: "support_ticket",
      entityId: ticketId,
      payload: changes,
      ipAddress,
      userAgent,
    });

    return getSupportTicket(ticketId);
  });
}

/** Counts for the console's stat cards, in one pass. */
export async function supportTicketStats(): Promise<{
  total: number;
  open: number;
  inProgress: number;
  waitingCustomer: number;
  resolved: number;
  closed: number;
  urgentOpen: number;
  unassignedOpen: number;
}> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ total: string; open: string; in_progress: string; waiting_customer: string; resolved: string; closed: string; urgent_open: string; unassigned_open: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE status = 'open')::text AS open,
              count(*) FILTER (WHERE status = 'in_progress')::text AS in_progress,
              count(*) FILTER (WHERE status = 'waiting_customer')::text AS waiting_customer,
              count(*) FILTER (WHERE status = 'resolved')::text AS resolved,
              count(*) FILTER (WHERE status = 'closed')::text AS closed,
              count(*) FILTER (WHERE status IN ('open', 'in_progress', 'waiting_customer') AND priority = 'urgent')::text AS urgent_open,
              count(*) FILTER (WHERE status IN ('open', 'in_progress', 'waiting_customer') AND assigned_admin_id IS NULL)::text AS unassigned_open
         FROM support_tickets`,
    ),
  );
  const row = rows[0];
  return {
    total: Number(row.total),
    open: Number(row.open),
    inProgress: Number(row.in_progress),
    waitingCustomer: Number(row.waiting_customer),
    resolved: Number(row.resolved),
    closed: Number(row.closed),
    urgentOpen: Number(row.urgent_open),
    unassignedOpen: Number(row.unassigned_open),
  };
}

/**
 * The assignee roster for the support desk. Only id + name of *active* admins —
 * a support operator needs to hand a ticket to a colleague without gaining the
 * owner-only admin roster (`admins.manage` keeps the full profile there).
 */
export async function listAssignablePlatformAdmins(): Promise<{ id: string; fullName: string }[]> {
  const { rows } = await query<{ id: string; full_name: string }>(
    `SELECT id::text AS id, full_name FROM platform_admins WHERE is_active ORDER BY full_name`,
  );
  return rows.map((r) => ({ id: r.id, fullName: r.full_name }));
}

/** The ticket is not in this database (or was deleted). */
export class SupportTicketNotFoundError extends Error {
  constructor() {
    super("ticket_not_found");
  }
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  platformAdminId: string | null;
  adminName: string | null;
  businessId: string | null;
  businessName: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  payload: unknown;
  createdAt: string;
}

/** Filters + pagination for the console's audit investigation surface. */
export interface AuditQuery {
  businessId?: string;
  /** Exact platform admin (operator) id. */
  adminId?: string;
  /** Action-family prefix, e.g. "business" matches "business.provision". */
  actionFamily?: string;
  entity?: string;
  /** Free-text over action, admin name, business name, entity id. */
  search?: string;
  createdFrom?: string;
  createdTo?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditListResult {
  entries: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  /** Distinct action families present (for the filter dropdown), unfiltered. */
  actionFamilies?: string[];
}

/**
 * The audit log as an investigation tool (task section 12): filtered, searched
 * and paginated in the database rather than fetched in one 500-row page and
 * sliced in the browser. Read-only; the table is immutable. `pageSize` is
 * clamped server-side so a caller can never pull the whole log at once.
 */
export async function queryAudit(q: AuditQuery = {}): Promise<AuditListResult> {
  const page = Math.max(1, Math.floor(q.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(q.pageSize ?? 40)));
  const offset = (page - 1) * pageSize;

  return withoutTenantScope("platform", async () => {
    const where: string[] = [];
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (q.businessId) where.push(`al.business_id = ${bind(q.businessId)}::uuid`);
    if (q.adminId) where.push(`al.platform_admin_id = ${bind(q.adminId)}::uuid`);
    if (q.actionFamily) where.push(`al.action LIKE ${bind(`${q.actionFamily}%`)}`);
    if (q.entity) where.push(`al.entity = ${bind(q.entity)}`);
    if (q.createdFrom) where.push(`al.created_at >= ${bind(q.createdFrom)}`);
    if (q.createdTo) where.push(`al.created_at <= ${bind(`${q.createdTo}T23:59:59.999Z`)}`);
    if (q.search && q.search.trim()) {
      const p = bind(`%${q.search.trim()}%`);
      where.push(
        `(al.action ILIKE ${p} OR pa.full_name ILIKE ${p} OR b.name ILIKE ${p} OR al.entity_id ILIKE ${p})`,
      );
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const joins = `LEFT JOIN platform_admins pa ON pa.id = al.platform_admin_id
                   LEFT JOIN businesses b ON b.id = al.business_id`;

    const { rows: countRows } = await query<{ total: string }>(
      `SELECT count(*)::text AS total FROM platform_audit_log al ${joins} ${whereSql}`,
      params,
    );
    const total = Number(countRows[0]?.total ?? 0);

    const { rows } = await query<{
      id: string;
      platform_admin_id: string | null;
      admin_name: string | null;
      business_id: string | null;
      business_name: string | null;
      action: string;
      entity: string | null;
      entity_id: string | null;
      payload: unknown;
      created_at: string;
    }>(
      `SELECT al.id::text AS id, al.platform_admin_id, pa.full_name AS admin_name,
              al.business_id, b.name AS business_name, al.action, al.entity,
              al.entity_id, al.payload, al.created_at
         FROM platform_audit_log al
         ${joins}
        ${whereSql}
        ORDER BY al.created_at DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params,
    );

    return {
      entries: rows.map((r) => ({
        id: r.id,
        platformAdminId: r.platform_admin_id,
        adminName: r.admin_name,
        businessId: r.business_id,
        businessName: r.business_name,
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        payload: r.payload,
        createdAt: r.created_at,
      })),
      total,
      page,
      pageSize,
    };
  });
}

// ---------------------------------------------------------------------------
// System management
// ---------------------------------------------------------------------------

export interface SystemStatus {
  migrations: { filename: string; appliedAt: string }[];
  pendingMigrations: number;
  pool: { total: number; idle: number; waiting: number };
  rlsEffective: boolean;
  backups: { businessId: string; businessName: string; status: string; ranAt: string | null }[];
  /**
   * The deployment's own whole-database backup (migration 0132), which belongs
   * to no business and so cannot appear in the per-business list above. Surfaced
   * here because this is where an operator looks when something is wrong, and
   * because the alert line is the difference between "the tenant backups are all
   * green" meaning *we are safe* and meaning *we have nothing but the tenants*.
   */
  platformBackup: PlatformBackupLine | null;
  counts: { businesses: number; platformUsers: number; platformAdmins: number };
}

export interface PlatformBackupLine {
  status: string;
  ranAt: string | null;
  alert: string;
  alertLevel: "ok" | "warning" | "error";
  artifacts: number;
  servingEnabled: boolean;
}

/**
 * A snapshot of platform health for the system page: applied migrations, the
 * connection pool's live figures, whether RLS is actually being enforced, and
 * the most recent backup run per business. Read-only and cheap — this is a
 * dashboard, not a control surface.
 */
export async function systemStatus(pendingMigrations: number): Promise<SystemStatus> {
  const pool = getPool();

  const [migrations, backups, counts, rls, backupHealth] = await withoutTenantScope("platform", () =>
    Promise.all([
      query<{ filename: string; applied_at: string }>(
        `SELECT filename, applied_at FROM schema_migrations ORDER BY filename DESC LIMIT 30`,
      ),
      query<{ business_id: string; business_name: string; status: string; ran_at: string | null }>(
        `SELECT DISTINCT ON (br.business_id)
                br.business_id, b.name AS business_name, br.status, br.started_at AS ran_at
           FROM backup_runs br
           JOIN businesses b ON b.id = br.business_id
          ORDER BY br.business_id, br.started_at DESC`,
      ),
      query<{ businesses: string; platform_users: string; platform_admins: string }>(
        `SELECT (SELECT count(*) FROM businesses) AS businesses,
                (SELECT count(*) FROM platform_users) AS platform_users,
                (SELECT count(*) FROM platform_admins) AS platform_admins`,
      ),
      query<{ privileged: boolean }>(
        `SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = current_user`,
      ),
      // Best-effort by design: the system page is the one screen that must come
      // up even when the backup subsystem cannot answer, so a failure here
      // degrades to "no line" rather than to a red page.
      getPlatformBackupHealth().catch(() => null),
    ]),
  );

  return {
    migrations: migrations.rows.map((m) => ({ filename: m.filename, appliedAt: m.applied_at })),
    pendingMigrations,
    pool: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    },
    rlsEffective: rls.rows[0] ? !rls.rows[0].privileged : false,
    backups: backups.rows.map((b) => ({
      businessId: b.business_id,
      businessName: b.business_name,
      status: b.status,
      ranAt: b.ran_at,
    })),
    platformBackup: backupHealth
      ? {
          status: backupHealth.localLastSuccessAt ? "success" : backupHealth.localLastError ? "failed" : "none",
          ranAt: backupHealth.localLastSuccessAt,
          alert: backupHealth.alert.reason,
          alertLevel: backupHealth.alert.level,
          artifacts: backupHealth.artifactsOnDisk,
          servingEnabled: backupHealth.servingEnabled,
        }
      : null,
    counts: {
      businesses: Number(counts.rows[0]?.businesses ?? 0),
      platformUsers: Number(counts.rows[0]?.platform_users ?? 0),
      platformAdmins: Number(counts.rows[0]?.platform_admins ?? 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Platform admin management (owner-only)
// ---------------------------------------------------------------------------

export interface PlatformAdminSummary {
  id: string;
  email: string;
  fullName: string;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  mfaMethods: ("totp" | "sms_otp")[];
  activeSessionsCount: number;
}

const VALID_PLATFORM_ROLES: readonly PlatformAdminRole[] = ["owner", "support", "engineer"];

export function isValidPlatformAdminRole(value: unknown): value is PlatformAdminRole {
  return typeof value === "string" && (VALID_PLATFORM_ROLES as readonly string[]).includes(value);
}

export async function listPlatformAdmins(): Promise<PlatformAdminSummary[]> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{
      id: string;
      email: string;
      full_name: string;
      role: string;
      is_active: boolean;
      last_login_at: string | null;
      created_at: string;
      mfa_methods: ("totp" | "sms_otp")[] | null;
      active_sessions_count: string;
    }>(
      `SELECT pa.id, pa.email::text AS email, pa.full_name, pa.role::text AS role,
              pa.is_active, pa.last_login_at, pa.created_at,
              COALESCE(
                (SELECT array_agg(me.method ORDER BY me.is_primary DESC, me.method)
                   FROM mfa_enrolments me
                  WHERE me.subject_realm = 'platform_admin'
                    AND me.subject_id = pa.id
                    AND me.confirmed_at IS NOT NULL),
                '{}'
              ) AS mfa_methods,
              (SELECT count(*)
                 FROM auth_admin_sessions s
                WHERE s.admin_id = pa.id
                  AND s.revoked_at IS NULL
                  AND s.expires_at > now()
                  AND s.token_version = pa.token_version) AS active_sessions_count
         FROM platform_admins pa
        ORDER BY pa.created_at`,
    );
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      fullName: r.full_name,
      role: r.role,
      isActive: r.is_active,
      lastLoginAt: r.last_login_at,
      createdAt: r.created_at,
      mfaMethods: r.mfa_methods ?? [],
      activeSessionsCount: Number(r.active_sessions_count ?? 0),
    }));
  });
}

export async function createPlatformAdmin(params: {
  email: string;
  fullName: string;
  role: PlatformAdminRole;
  actorAdminId: string;
}): Promise<
  | {
      ok: true;
      admin: PlatformAdminSummary;
      resetToken: string;
      resetExpiresAt: string;
    }
  | {
      ok: false;
      error: "missing_fields" | "invalid_email" | "invalid_role" | "email_taken";
    }
> {
  const email = params.email.trim().toLowerCase();
  const fullName = params.fullName.trim();
  if (!email || !fullName) return { ok: false, error: "missing_fields" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "invalid_email" };
  if (!isValidPlatformAdminRole(params.role)) return { ok: false, error: "invalid_role" };

  return withoutTenantScope("platform", async () => {
    const existing = await query<{ id: string }>(
      `SELECT id FROM platform_admins WHERE email = $1`,
      [email],
    );
    if (existing.rows.length > 0) {
      return { ok: false, error: "email_taken" };
    }

    // Bootstrap with an unguessable throwaway hash; the invited admin chooses
    // their own permanent password via the one-time activation/reset link.
    const bootstrapSecret = randomBytes(32).toString("hex");
    const passwordHash = await bcrypt.hash(bootstrapSecret, 12);

    const { rows } = await query<{
      id: string;
      email: string;
      full_name: string;
      role: string;
      is_active: boolean;
      last_login_at: string | null;
      created_at: string;
    }>(
      `INSERT INTO platform_admins (email, password_hash, full_name, role, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, email::text AS email, full_name, role::text AS role,
                 is_active, last_login_at, created_at`,
      [email, passwordHash, fullName, params.role],
    );
    const created = rows[0];

    await markMfaGracePeriod("platform_admin", created.id, MFA_GRACE_DAYS_PLATFORM);

    const reset = await issuePasswordResetToken({
      subjectRealm: "platform_admin",
      subjectId: created.id,
      email: created.email,
      createdById: params.actorAdminId,
    });

    await platformAudit({
      adminId: params.actorAdminId,
      action: "platform_admin.created",
      entity: "platform_admin",
      entityId: created.id,
      payload: {
        email: created.email,
        fullName: created.full_name,
        role: created.role,
        resetExpiresAt: reset.expiresAt.toISOString(),
      },
    });

    return {
      ok: true,
      admin: {
        id: created.id,
        email: created.email,
        fullName: created.full_name,
        role: created.role,
        isActive: created.is_active,
        lastLoginAt: created.last_login_at,
        createdAt: created.created_at,
        mfaMethods: [],
        activeSessionsCount: 0,
      },
      resetToken: reset.token,
      resetExpiresAt: reset.expiresAt.toISOString(),
    };
  });
}

export async function updatePlatformAdmin(params: {
  targetAdminId: string;
  fullName?: string;
  role?: PlatformAdminRole;
  isActive?: boolean;
  actorAdminId: string;
}): Promise<
  | { ok: true; admin: PlatformAdminSummary }
  | {
      ok: false;
      error:
        | "not_found"
        | "invalid_role"
        | "missing_fields"
        | "last_platform_owner";
    }
> {
  if (params.role !== undefined && !isValidPlatformAdminRole(params.role)) {
    return { ok: false, error: "invalid_role" };
  }
  if (params.fullName !== undefined && !params.fullName.trim()) {
    return { ok: false, error: "missing_fields" };
  }

  return withoutTenantScope("platform", async () => {
    const { rows: allAdmins } = await query<{
      id: string;
      email: string;
      full_name: string;
      role: PlatformAdminRole;
      is_active: boolean;
    }>(
      `SELECT id, email::text AS email, full_name, role::text AS role, is_active
         FROM platform_admins`,
    );
    const target = allAdmins.find((a) => a.id === params.targetAdminId);
    if (!target) return { ok: false, error: "not_found" };

    const nextRole = params.role ?? target.role;
    const nextActive = params.isActive ?? target.is_active;
    const nextName = params.fullName !== undefined ? params.fullName.trim() : target.full_name;

    // Prevent demoting or deactivating the last active platform owner.
    if (target.role === "owner" && target.is_active && (nextRole !== "owner" || !nextActive)) {
      const otherActiveOwners = allAdmins.filter(
        (a) => a.id !== target.id && a.role === "owner" && a.is_active,
      );
      if (otherActiveOwners.length === 0) {
        return { ok: false, error: "last_platform_owner" };
      }
    }

    const shouldBumpToken = nextRole !== target.role || !nextActive;

    await query(
      `UPDATE platform_admins
          SET full_name = $2,
              role = $3,
              is_active = $4,
              token_version = token_version + CASE WHEN $5::boolean THEN 1 ELSE 0 END,
              updated_at = now()
        WHERE id = $1`,
      [target.id, nextName, nextRole, nextActive, shouldBumpToken],
    );

    if (!nextActive || nextRole !== target.role) {
      await query(
        `UPDATE auth_admin_sessions
            SET revoked_at = now()
          WHERE admin_id = $1 AND revoked_at IS NULL`,
        [target.id],
      );
      await query(
        `UPDATE impersonation_grants
            SET revoked_at = now()
          WHERE platform_admin_id = $1 AND ended_at IS NULL AND revoked_at IS NULL`,
        [target.id],
      );
    }

    await platformAudit({
      adminId: params.actorAdminId,
      action: "platform_admin.updated",
      entity: "platform_admin",
      entityId: target.id,
      payload: {
        before: {
          fullName: target.full_name,
          role: target.role,
          isActive: target.is_active,
        },
        after: {
          fullName: nextName,
          role: nextRole,
          isActive: nextActive,
        },
      },
    });

    const updated = (await listPlatformAdmins()).find((a) => a.id === target.id)!;
    return { ok: true, admin: updated };
  });
}

export async function revokePlatformAdminAccessSessions(params: {
  targetAdminId: string;
  actorAdminId: string;
}): Promise<{ ok: true; revokedSessions: number } | { ok: false; error: "not_found" }> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM platform_admins WHERE id = $1`,
      [params.targetAdminId],
    );
    if (!rows[0]) return { ok: false, error: "not_found" };

    const result = await revokeAllPlatformAdminSessions(params.targetAdminId);

    await platformAudit({
      adminId: params.actorAdminId,
      action: "platform_admin.sessions_revoked",
      entity: "platform_admin",
      entityId: params.targetAdminId,
      payload: { revokedSessions: result.revokedSessions },
    });

    return { ok: true, revokedSessions: result.revokedSessions };
  });
}

export async function initiatePlatformAdminPasswordReset(params: {
  targetAdminId: string;
  actorAdminId: string;
}): Promise<
  | { ok: true; token: string; expiresAt: string; email: string }
  | { ok: false; error: "not_found" }
> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{ id: string; email: string }>(
      `SELECT id, email::text AS email FROM platform_admins WHERE id = $1`,
      [params.targetAdminId],
    );
    const admin = rows[0];
    if (!admin) return { ok: false, error: "not_found" };

    const reset = await issuePasswordResetToken({
      subjectRealm: "platform_admin",
      subjectId: admin.id,
      email: admin.email,
      createdById: params.actorAdminId,
    });

    await platformAudit({
      adminId: params.actorAdminId,
      action: "platform_admin.password_reset_initiated",
      entity: "platform_admin",
      entityId: admin.id,
      payload: { email: admin.email, expiresAt: reset.expiresAt.toISOString() },
    });

    return {
      ok: true,
      token: reset.token,
      expiresAt: reset.expiresAt.toISOString(),
      email: admin.email,
    };
  });
}

/** Suppress unused-import lint: PoolClient is referenced only in a type slot. */
export type { PoolClient };
