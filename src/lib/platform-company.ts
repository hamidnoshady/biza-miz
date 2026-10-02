/**
 * Central boundary between platform administration and the platform company's
 * tenant data. It resolves the one database-enforced internal business and a
 * real tenant membership, then replaces the platform bypass with tenant scope.
 *
 * This adapter is the ONLY place that answers "may this platform identity work
 * inside the internal company, as whom, with which permissions". Routes never
 * re-derive it, never accept a business id from the browser, and never branch
 * on a platform-administrator role to decide a company question.
 */
import { randomBytes, createHash } from "node:crypto";
import { getPool, query, withTenant, withoutTenantScope } from "./db";
import { provisionBusiness } from "./business-provisioning";
import { requirePlatformAdmin } from "./platform-auth";
import { platformCan } from "./platform-admin";
import { PERMISSIONS, type Permission } from "./permissions";
import type { MoneyUnit } from "./money";
import type { PlatformSessionPayload } from "./platform-auth-edge";
import { APP_KEYS } from "./apps";
import { deploymentRole } from "./deployment-role";
import bcrypt from "bcryptjs";
import {
  COMPANY_ACCESS_PRESET_KEYS,
  type CompanyAccessPreset,
  type PlatformCompanyState,
  type PlatformCompanyStatus,
  type PlatformCompanyMemberSummary,
} from "./platform-company-types";

export { COMPANY_ACCESS_PRESET_KEYS };

export type { CompanyAccessPreset };

const PRESET_PERMISSIONS: Record<CompanyAccessPreset, readonly Permission[]> = {
  company_owner: Object.values(PERMISSIONS),
  finance: [
    PERMISSIONS.ledgerView, PERMISSIONS.ledgerPost, PERMISSIONS.ledgerPropose,
    PERMISSIONS.ledgerApprove, PERMISSIONS.accountsEdit, PERMISSIONS.reportsView,
    PERMISSIONS.reportsExport, PERMISSIONS.partiesView,
    PERMISSIONS.financeExpensesManage, PERMISSIONS.financeReceivablesManage,
    PERMISSIONS.financePayablesManage, PERMISSIONS.financeReconciliationManage,
    PERMISSIONS.workspaceView,
  ],
  sales_success: [
    PERMISSIONS.crmView, PERMISSIONS.crmManage, PERMISSIONS.partiesView,
    PERMISSIONS.partiesManage, PERMISSIONS.workspaceView, PERMISSIONS.workspaceManage,
  ],
  marketing: [
    PERMISSIONS.crmView, PERMISSIONS.growthView, PERMISSIONS.workspaceView,
    PERMISSIONS.workspaceManage,
  ],
  website_editor: [
    PERMISSIONS.websiteView, PERMISSIONS.websiteManage, PERMISSIONS.workspaceView,
  ],
  project_manager: [
    PERMISSIONS.workspaceView, PERMISSIONS.workspaceManage,
    PERMISSIONS.workspaceContractsManage, PERMISSIONS.partiesView, PERMISSIONS.crmView,
  ],
};

/** The one place that says which capabilities the internal company's apps map to. */
export const COMPANY_CAPABILITIES = [...APP_KEYS, "workspace"] as const;

export interface PlatformCompanyActor {
  platformAdminId: string;
  businessId: string;
  userId: string;
  fullName: string;
  preset: CompanyAccessPreset;
  permissions: ReadonlySet<Permission>;
  revision: number;
}

export function companyPresetAllows(preset: CompanyAccessPreset, permission: Permission): boolean {
  return PRESET_PERMISSIONS[preset].includes(permission);
}

export function isCompanyAccessPreset(value: unknown): value is CompanyAccessPreset {
  return typeof value === "string" && (COMPANY_ACCESS_PRESET_KEYS as readonly string[]).includes(value);
}

/**
 * Structured, secret-free operational logging.
 *
 * The Platform Business worker and handoff paths are the ones an operator has
 * to debug from logs alone, so they log in one shape. Nothing here may ever
 * receive a token, a credential, a password or a customer's private data.
 */
export function platformCompanyLog(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), scope: "platform_company", event, ...fields }));
}

type MappedRow = {
  business_id: string;
  user_id: string;
  access_preset: CompanyAccessPreset;
  revision: string;
  full_name: string;
  member_active: boolean;
  user_active: boolean;
  business_status: string;
};

/**
 * Resolve the caller's *current* company membership, from the database, every
 * time.
 *
 * Nothing in the caller's token, route parameter or browser storage is trusted:
 * a preset demoted in the console takes effect on the very next company API
 * call, before the platform token has expired.
 */
async function mappedActor(session: PlatformSessionPayload): Promise<PlatformCompanyActor | null> {
  const { rows } = await query<MappedRow>(
    `SELECT m.business_id, m.user_id, m.access_preset, m.revision::text,
            u.full_name, u.is_active AS user_active, m.is_active AS member_active,
            b.status AS business_status
       FROM platform_company_members m
       JOIN businesses b ON b.id = m.business_id AND b.ownership_kind = 'platform_internal'
       JOIN users u ON u.id = m.user_id AND u.business_id = m.business_id
      WHERE m.platform_admin_id = $1`,
    [session.padmin],
  );
  const row = rows[0];
  if (!row) return null;
  // A deactivated membership or a deactivated tenant user ends access now.
  if (!row.member_active || !row.user_active) return null;
  if (row.business_status !== "active") return null;
  if (!isCompanyAccessPreset(row.access_preset)) return null;
  return {
    platformAdminId: session.padmin,
    businessId: row.business_id,
    userId: row.user_id,
    fullName: row.full_name,
    preset: row.access_preset,
    permissions: new Set(PRESET_PERMISSIONS[row.access_preset]),
    revision: Number(row.revision),
  };
}

export interface PlatformCompanyResult<T> {
  ok: boolean;
  status: 200 | 401 | 403 | 404 | 409;
  value?: T;
  actor?: PlatformCompanyActor;
  error?: string;
}

/**
 * Authorize from current identity state and execute under the internal tenant.
 * No client-supplied business id is accepted anywhere in this contract.
 *
 * The platform RLS bypass is in force while this runs (the route is wrapped in
 * `withPlatformScope`); `withTenant` replaces it with the internal company's
 * scope for the operation, which is the documented sequence:
 *
 *   platform session → active platform identity → company membership →
 *   company permission → replace platform bypass with internal tenant scope →
 *   execute app operation
 */
export async function withPlatformCompany<T>(
  permission: Permission,
  operation: (actor: PlatformCompanyActor) => Promise<T>,
): Promise<PlatformCompanyResult<T>> {
  const guard = await requirePlatformAdmin();
  if (guard.error) return { ok: false, status: 401, error: "unauthorized" };
  const actor = await mappedActor(guard.session);
  if (!actor) return { ok: false, status: 404, error: "platform_company_not_provisioned_or_not_member" };
  if (!actor.permissions.has(permission)) return { ok: false, status: 403, error: "company_permission_denied" };
  const value = await withTenant(actor.businessId, () => operation(actor), { userId: actor.userId });
  return { ok: true, status: 200, value, actor };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

type CompanyRow = {
  business_id: string;
  name: string;
  subdomain: string;
  status: string;
  /** Raw `settings('business.prefs')->currencyDisplay`; `MoneyUnit` is derived. */
  currency_display: string | null;
  access_preset: CompanyAccessPreset | null;
  is_active: boolean | null;
  revision: string | null;
  user_active: boolean | null;
};

async function internalCompanyRow(platformAdminId: string): Promise<CompanyRow | null> {
  const { rows } = await query<CompanyRow>(
    `SELECT b.id AS business_id, b.name, b.subdomain::text, b.status,
            prefs.value ->> 'currencyDisplay' AS currency_display,
            m.access_preset, m.is_active, m.revision::text, u.is_active AS user_active
       FROM businesses b
       LEFT JOIN platform_company_members m
         ON m.business_id = b.id AND m.platform_admin_id = $1
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN settings prefs
         ON prefs.business_id = b.id AND prefs.location_id IS NULL AND prefs.key = 'business.prefs'
      WHERE b.ownership_kind = 'platform_internal'`,
    [platformAdminId],
  );
  return rows[0] ?? null;
}

/**
 * The money unit is a per-business *setting*, not a column — it lives in
 * `settings('business.prefs')->currencyDisplay`, written by the setup wizard
 * and business settings, and read by `GetSetting`-based callers everywhere
 * else. Reading it here keeps the company console displaying the same unit the
 * company's own dashboard does, instead of hard-coding Toman.
 */
function moneyUnitOf(currencyDisplay: string | null): MoneyUnit {
  return currencyDisplay === "rial" ? "rial" : "toman";
}

/**
 * The full state a Platform Business screen needs, including WHY the caller
 * cannot work yet. The console distinguishes every state; collapsing them into
 * one «راه‌اندازی نشده» message is what left staff staring at a button they
 * were never allowed to press.
 */
export async function platformCompanyStatusFor(
  session: PlatformSessionPayload,
): Promise<PlatformCompanyStatus> {
  const row = await withoutTenantScope("platform", () => internalCompanyRow(session.padmin));
  const canProvision = platformCan(session.role, "business.provision");
  const provisioningSupported = deploymentRole() === "central";

  if (!row) {
    return {
      state: "not_provisioned",
      company: null,
      membership: null,
      entitlements: [],
      moneyUnit: "toman",
      canProvision,
      canAdministerMembers: false,
      provisioningSupported,
    };
  }

  const { rows: entitlementRows } = await withoutTenantScope("platform", () =>
    query<{ capability: string }>(
      `SELECT capability FROM platform_company_entitlements
        WHERE business_id = $1 AND enabled ORDER BY capability`,
      [row.business_id],
    ),
  );

  let state: PlatformCompanyState;
  if (row.status !== "active") state = "company_unavailable";
  else if (!row.access_preset) state = "company_exists_not_member";
  else if (row.is_active !== true) state = "member_inactive";
  else if (row.user_active === false) state = "tenant_user_inactive";
  else state = "ready";

  return {
    state,
    company: {
      businessId: row.business_id,
      name: row.name,
      subdomain: row.subdomain,
      status: row.status,
    },
    membership: row.access_preset
      ? {
          preset: row.access_preset,
          active: row.is_active === true && row.user_active !== false,
          revision: Number(row.revision ?? 0),
        }
      : null,
    entitlements: entitlementRows.map((r) => r.capability),
    moneyUnit: moneyUnitOf(row.currency_display),
    canProvision,
    // Administering company staff is a company permission (team.manage), not an
    // infrastructure capability: a company owner with no platform role beyond a
    // login can still run their own staff list.
    canAdministerMembers:
      state === "ready" &&
      !!row.access_preset &&
      companyPresetAllows(row.access_preset, PERMISSIONS.teamManage),
    provisioningSupported,
  };
}

/** Backwards-compatible shape kept for the console's older call sites. */
export async function platformCompanyStatus(platformAdminId: string) {
  const row = await withoutTenantScope("platform", () => internalCompanyRow(platformAdminId));
  if (!row) return null;
  return {
    business_id: row.business_id,
    name: row.name,
    subdomain: row.subdomain,
    access_preset: row.access_preset,
    is_active: row.is_active,
  };
}

export async function internalCompanyId(): Promise<string | null> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ id: string }>(`SELECT id FROM businesses WHERE ownership_kind = 'platform_internal'`),
  );
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Provisioning and repair
// ---------------------------------------------------------------------------

export interface EnsureCompanyOptions {
  /**
   * Re-activate a membership row that exists but is inactive. This is an
   * explicit, audited administrative act — never a side effect of "setup".
   */
  repairInactiveMembership?: boolean;
}

type CompanyRowLike = Awaited<ReturnType<typeof platformCompanyStatus>>;

/**
 * Idempotent initializer and repairer.
 *
 *   * company missing          → provision it (central cloud, business.provision)
 *   * company present          → never provision a second one; repair only the
 *                                missing, safe infrastructure around it
 *   * membership missing       → create it when the caller may administer access
 *   * membership inactive      → leave it alone unless `repairInactiveMembership`
 *
 * It never reruns opening balances, never recreates the chart of accounts for
 * an existing company, never resets user data and never deletes a subscription
 * that a real lifecycle path created.
 */
export async function ensurePlatformCompany(
  session: PlatformSessionPayload,
  options: EnsureCompanyOptions = {},
): Promise<CompanyRowLike> {
  const existing = await platformCompanyStatus(session.padmin);
  const mayAdminister =
    platformCan(session.role, "business.provision") ||
    (existing?.access_preset != null && companyPresetAllows(existing.access_preset, PERMISSIONS.teamManage));

  if (!existing) {
    if (!platformCan(session.role, "business.provision")) throw new Error("forbidden");
    if (deploymentRole() !== "central") throw new Error("central_cloud_only");
    await provisionInternalCompany(session);
  }

  const status = await platformCompanyStatus(session.padmin);
  if (!status) throw new Error("platform_company_provision_failed");

  await repairCompanyInfrastructure(status.business_id, session.padmin);

  if (!status.access_preset) {
    if (!mayAdminister) throw new Error("company_membership_required");
    await mapCompanyMember(session.padmin, status.business_id, "company_owner", true);
  } else if (status.is_active === false && options.repairInactiveMembership) {
    if (!mayAdminister) throw new Error("company_membership_inactive");
    const { rows } = await withoutTenantScope("platform", () =>
      query<{ user_id: string }>(
        `UPDATE platform_company_members
            SET is_active = true, revision = revision + 1, updated_at = now()
          WHERE platform_admin_id = $1 AND business_id = $2
          RETURNING user_id`,
        [session.padmin, status.business_id],
      ),
    );
    if (rows[0]) {
      await withoutTenantScope("platform", () =>
        query(`UPDATE users SET is_active = true, updated_at = now() WHERE id = $1`, [rows[0].user_id]),
      );
      platformCompanyLog("membership.repaired", {
        businessId: status.business_id,
        platformAdminId: session.padmin,
      });
    }
  }
  return (await platformCompanyStatus(session.padmin))!;
}

async function provisionInternalCompany(session: PlatformSessionPayload) {
  const { rows: adminRows } = await query<{ email: string; full_name: string }>(
    `SELECT email::text, full_name FROM platform_admins WHERE id = $1 AND is_active`,
    [session.padmin],
  );
  const admin = adminRows[0];
  if (!admin) throw new Error("platform_admin_not_active");

  let provisioned: Awaited<ReturnType<typeof provisionBusiness>>;
  try {
    provisioned = await provisionBusiness({
      businessName: "کسب‌وکار پلتفرم",
      locationName: "دفتر مرکزی",
      ownerName: admin.full_name,
      email: admin.email,
      // The mapped tenant user is only ever reached through the company
      // handoff, so it has no usable password. It is not a credential anyone
      // is expected to type.
      password: randomBytes(32).toString("hex"),
      industry: "service_saas",
      subdomain: "platform-company",
      seedChartOfAccounts: true,
      ownershipKind: "platform_internal",
      createdBy: session.padmin,
    });
  } catch (error) {
    // A concurrent initializer may have won the unique ownership marker.
    const raced = await platformCompanyStatus(session.padmin);
    if (raced) return;
    platformCompanyLog("provision.failed", {
      platformAdminId: session.padmin,
      error: error instanceof Error ? error.message.slice(0, 300) : "unknown_error",
    });
    throw error;
  }
  platformCompanyLog("provision.created", {
    businessId: provisioned.businessId,
    platformAdminId: session.padmin,
  });
}

/**
 * Repair the safe, idempotent infrastructure around an already-provisioned
 * company: app entitlements and app availability. Deliberately NOT repaired
 * here — the chart of accounts, opening balances, business data and configured
 * settings, all of which are real data a repair must not overwrite.
 */
export async function repairCompanyInfrastructure(businessId: string, actorAdminId: string): Promise<void> {
  await withoutTenantScope("platform", async () => {
    await query(
      `INSERT INTO platform_company_entitlements (business_id, capability)
       SELECT $1, unnest($2::text[])
       ON CONFLICT (business_id, capability) DO UPDATE SET enabled = true`,
      [businessId, [...COMPANY_CAPABILITIES]],
    );
    await query(
      `INSERT INTO business_app_availability (business_id, app_key, state, note, updated_by)
       SELECT $1, unnest($2::text[]), 'available', 'دسترسی داخلی شرکت پلتفرم', $3
       ON CONFLICT (business_id, app_key) DO UPDATE
         SET state = 'available', note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [businessId, APP_KEYS, actorAdminId],
    );
    // Lifecycle exclusion, non-destructively: the internal company is never
    // billed, never suspended and never counted as a customer acquisition. A
    // subscription row that some provision hook created is switched off rather
    // than deleted — deleting it would erase the history of why it existed.
    await query(
      `UPDATE business_subscriptions
          SET auto_renew = false, updated_at = now()
        WHERE business_id = $1 AND auto_renew`,
      [businessId],
    );
  });
}

/** Whether the company is switched on for one of its five work areas. */
export async function companyAppEnabled(businessId: string, appKey: string): Promise<boolean> {
  if (!(COMPANY_CAPABILITIES as readonly string[]).includes(appKey)) return false;
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ enabled: boolean }>(
      `SELECT enabled FROM platform_company_entitlements WHERE business_id = $1 AND capability = $2`,
      [businessId, appKey],
    ),
  );
  // An entitlement row that does not exist (pre-0191 data repaired out of band)
  // fails closed: no row, no access.
  return rows[0]?.enabled === true;
}

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

export function hashCompanyHandoff(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The only return paths a company app may be opened at. Prefix-matched, so
 *  an absolute URL or a `//host/…` can never be smuggled through. */
export const COMPANY_RETURN_PATHS = [
  "/workspace",
  "/accounting",
  "/crm",
  "/growth",
  "/websites",
] as const;

export function isValidCompanyReturnPath(path: string): boolean {
  return COMPANY_RETURN_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export interface RedeemedCompanyHandoff {
  handoffId: string;
  platformAdminId: string;
  businessId: string;
  userId: string;
  returnPath: string;
  subdomain: string;
  slug: string;
  fullName: string;
  role: string;
  locationId: string | null;
  platformUserId: string | null;
  tokenVersion: number | null;
  preset: string;
}

/**
 * Atomically redeem a company handoff token.
 *
 * One transaction, one row, locked: everything the handoff promised is
 * re-checked here, at redeem time, from the database — membership still active,
 * platform admin still active, business still active and still the internal
 * company, tenant user still active, token unused and unexpired, and the
 * origin's subdomain still the company's own. So a token stops working the
 * moment any of those change, not when it expires.
 *
 * The role and preset are read here rather than carried in the token, so a role
 * changed between minting and redeeming is the role that takes effect.
 *
 * Returns `null` for every failure mode — expired, used, revoked, archived —
 * because telling an anonymous caller *which* one it was would be a free
 * oracle. It never discloses the token or its hash.
 */
export async function redeemCompanyHandoff(
  token: string,
  expectedSubdomain: string | null,
): Promise<RedeemedCompanyHandoff | null> {
  return withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{
        id: string; platform_admin_id: string; business_id: string; user_id: string;
        return_path: string; subdomain: string; slug: string; full_name: string; role: string;
        location_id: string | null; platform_user_id: string | null; token_version: number | null;
        access_preset: string;
      }>(
        `SELECT h.id, h.platform_admin_id, h.business_id, h.user_id, h.return_path,
                b.subdomain::text, b.slug::text, u.full_name, u.role, u.location_id,
                u.platform_user_id, pu.token_version, m.access_preset
           FROM platform_company_handoffs h
           JOIN platform_company_members m ON m.platform_admin_id = h.platform_admin_id
             AND m.business_id = h.business_id AND m.user_id = h.user_id AND m.is_active
           JOIN platform_admins pa ON pa.id = h.platform_admin_id AND pa.is_active
           JOIN businesses b ON b.id = h.business_id AND b.ownership_kind = 'platform_internal' AND b.status = 'active'
           JOIN users u ON u.id = h.user_id AND u.business_id = h.business_id AND u.is_active
           LEFT JOIN platform_users pu ON pu.id = u.platform_user_id
          WHERE h.token_hash = $1 AND h.used_at IS NULL AND h.expires_at > now()
          FOR UPDATE OF h`,
        [hashCompanyHandoff(token)],
      );
      const row = rows[0];
      if (!row || (expectedSubdomain && expectedSubdomain !== row.subdomain)) {
        await client.query("ROLLBACK");
        platformCompanyLog("handoff.rejected", {
          reason: !row ? "invalid_or_expired" : "wrong_origin",
        });
        return null;
      }
      // Defence in depth: validated when minted, validated again here because
      // this value drives a browser redirect.
      if (!isValidCompanyReturnPath(row.return_path)) {
        await client.query("ROLLBACK");
        platformCompanyLog("handoff.rejected", { reason: "invalid_return_path" });
        return null;
      }
      await client.query(`UPDATE platform_company_handoffs SET used_at = now() WHERE id = $1`, [row.id]);
      await client.query("COMMIT");
      return {
        handoffId: row.id,
        platformAdminId: row.platform_admin_id,
        businessId: row.business_id,
        userId: row.user_id,
        returnPath: row.return_path,
        subdomain: row.subdomain,
        slug: row.slug,
        fullName: row.full_name,
        role: row.role,
        locationId: row.location_id,
        platformUserId: row.platform_user_id,
        tokenVersion: row.token_version,
        preset: row.access_preset,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}

export async function createCompanyHandoff(actor: PlatformCompanyActor, returnPath: string) {
  if (!isValidCompanyReturnPath(returnPath)) throw new Error("invalid_company_return_path");
  const token = randomBytes(32).toString("base64url");
  await withoutTenantScope("platform", () => query(
    `INSERT INTO platform_company_handoffs
       (token_hash, platform_admin_id, business_id, user_id, return_path, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + interval '2 minutes')`,
    [hashCompanyHandoff(token), actor.platformAdminId, actor.businessId, actor.userId, returnPath],
  ));
  const { rows } = await withoutTenantScope("platform", () => query<{ subdomain: string }>(
    `SELECT subdomain::text FROM businesses WHERE id=$1`, [actor.businessId],
  ));
  platformCompanyLog("handoff.created", {
    businessId: actor.businessId,
    platformAdminId: actor.platformAdminId,
    returnPath,
  });
  return { token, subdomain: rows[0].subdomain, returnPath };
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export async function listPlatformCompanyMembers(businessId: string): Promise<PlatformCompanyMemberSummary[]> {
  const { rows } = await query<{
    id: string; full_name: string; email: string; access_preset: CompanyAccessPreset | null;
    is_active: boolean | null; revision: string | null;
  }>(
    `SELECT pa.id, pa.full_name, pa.email::text, m.access_preset, m.is_active, m.revision::text
       FROM platform_admins pa
       LEFT JOIN platform_company_members m
         ON m.platform_admin_id = pa.id AND m.business_id = $1
      WHERE pa.is_active
      ORDER BY pa.full_name, pa.id`,
    [businessId],
  );
  return rows.map((row) => ({
    platformAdminId: row.id,
    fullName: row.full_name,
    email: row.email,
    preset: row.access_preset,
    active: row.is_active === true,
    revision: Number(row.revision ?? 0),
  }));
}

/**
 * Create or update one company member.
 *
 * The company operating role and the platform infrastructure role stay
 * independent in both directions: granting someone `finance` here gives them no
 * console capability, and an infrastructure owner still needs a membership row
 * to work inside the company.
 */
export async function setPlatformCompanyMember(
  actor: PlatformCompanyActor,
  platformAdminId: string,
  preset: CompanyAccessPreset,
  active: boolean,
): Promise<PlatformCompanyMemberSummary> {
  if (!isCompanyAccessPreset(preset)) throw new Error("invalid_preset");
  if (platformAdminId === actor.platformAdminId && !active) throw new Error("cannot_revoke_self");

  const { rows: admins } = await query<{ id: string; email: string; full_name: string }>(
    `SELECT id, email::text, full_name FROM platform_admins WHERE id = $1 AND is_active`,
    [platformAdminId],
  );
  const admin = admins[0];
  if (!admin) throw new Error("platform_admin_not_found");

  // Last-owner protection: the internal company must never be left with nobody
  // who can administer it.
  if (!active) {
    const { rows: owners } = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform_company_members
        WHERE business_id = $1 AND is_active AND access_preset = 'company_owner'`,
      [actor.businessId],
    );
    const { rows: target } = await query<{ access_preset: string }>(
      `SELECT access_preset FROM platform_company_members
        WHERE business_id = $1 AND platform_admin_id = $2`,
      [actor.businessId, platformAdminId],
    );
    if (target[0]?.access_preset === "company_owner" && Number(owners[0]?.count ?? "0") <= 1) {
      throw new Error("last_company_owner");
    }
  }

  // The global identity row is created once and never rewritten. `full_name` on
  // `platform_users` is shared by every business membership this person holds,
  // so overwriting it here would silently rename them in another business.
  const { rows: identities } = await query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [admin.email, await bcrypt.hash(randomBytes(32).toString("base64url"), 12), admin.full_name],
  );
  let identityId = identities[0]?.id;
  if (!identityId) {
    const { rows: existing } = await query<{ id: string }>(
      `SELECT id FROM platform_users WHERE email = $1`, [admin.email],
    );
    identityId = existing[0].id;
  }

  const role = preset === "company_owner" ? "owner" : preset === "finance" ? "accountant" : "manager";
  const granted = [...PRESET_PERMISSIONS[preset]];
  const permissions = {
    granted,
    revoked: Object.values(PERMISSIONS).filter((permission) => !granted.includes(permission)),
  };

  const { rows: users } = await query<{ id: string }>(
    `INSERT INTO users (business_id, platform_user_id, email, full_name, role, is_active, permissions)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (business_id, platform_user_id) WHERE platform_user_id IS NOT NULL
     DO UPDATE SET email = EXCLUDED.email, full_name = EXCLUDED.full_name, role = EXCLUDED.role,
       is_active = EXCLUDED.is_active, permissions = EXCLUDED.permissions, updated_at = now()
     RETURNING id`,
    [actor.businessId, identityId, admin.email, admin.full_name, role, active, JSON.stringify(permissions)],
  );

  await query(
    `INSERT INTO platform_company_members
       (platform_admin_id, business_id, user_id, access_preset, is_active, granted_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (platform_admin_id) DO UPDATE SET
       business_id = EXCLUDED.business_id, user_id = EXCLUDED.user_id,
       access_preset = EXCLUDED.access_preset, is_active = EXCLUDED.is_active,
       granted_by = EXCLUDED.granted_by,
       revision = platform_company_members.revision + 1, updated_at = now()`,
    [platformAdminId, actor.businessId, users[0].id, preset, active, actor.platformAdminId],
  );

  platformCompanyLog("membership.updated", {
    businessId: actor.businessId,
    platformAdminId,
    preset,
    active,
    grantedBy: actor.platformAdminId,
  });

  const members = await listPlatformCompanyMembers(actor.businessId);
  return members.find((member) => member.platformAdminId === platformAdminId)!;
}

/** Map a platform identity into the company without going through the member API. */
async function mapCompanyMember(
  platformAdminId: string,
  businessId: string,
  preset: CompanyAccessPreset,
  active: boolean,
): Promise<void> {
  const { rows: admins } = await query<{ email: string; full_name: string }>(
    `SELECT email::text, full_name FROM platform_admins WHERE id = $1 AND is_active`,
    [platformAdminId],
  );
  const admin = admins[0];
  if (!admin) throw new Error("platform_admin_not_active");
  const { rows: identities } = await query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name)
     VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING RETURNING id`,
    [admin.email, await bcrypt.hash(randomBytes(32).toString("base64url"), 12), admin.full_name],
  );
  let identityId = identities[0]?.id;
  if (!identityId) {
    const { rows: existing } = await query<{ id: string }>(
      `SELECT id FROM platform_users WHERE email = $1`, [admin.email],
    );
    identityId = existing[0].id;
  }
  const role = preset === "company_owner" ? "owner" : preset === "finance" ? "accountant" : "manager";
  const granted = [...PRESET_PERMISSIONS[preset]];
  const permissions = {
    granted,
    revoked: Object.values(PERMISSIONS).filter((permission) => !granted.includes(permission)),
  };
  const { rows: users } = await query<{ id: string }>(
    `INSERT INTO users (business_id, platform_user_id, email, full_name, role, is_active, permissions)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (business_id, platform_user_id) WHERE platform_user_id IS NOT NULL
     DO UPDATE SET email = EXCLUDED.email, full_name = EXCLUDED.full_name, role = EXCLUDED.role,
       is_active = EXCLUDED.is_active, permissions = EXCLUDED.permissions, updated_at = now()
     RETURNING id`,
    [businessId, identityId, admin.email, admin.full_name, role, active, JSON.stringify(permissions)],
  );
  await query(
    `INSERT INTO platform_company_members
       (platform_admin_id, business_id, user_id, access_preset, is_active, granted_by)
     VALUES ($1,$2,$3,$4,$5,$1)
     ON CONFLICT (platform_admin_id) DO UPDATE SET
       business_id = EXCLUDED.business_id, user_id = EXCLUDED.user_id,
       access_preset = EXCLUDED.access_preset, is_active = EXCLUDED.is_active,
       revision = platform_company_members.revision + 1, updated_at = now()`,
    [platformAdminId, businessId, users[0].id, preset, active],
  );
  platformCompanyLog("membership.mapped", { businessId, platformAdminId, preset });
}
