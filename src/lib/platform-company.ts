/**
 * Central boundary between platform administration and the platform company's
 * tenant data. It resolves the one database-enforced internal business and a
 * real tenant membership, then replaces the platform bypass with tenant scope.
 */
import { randomBytes, createHash } from "node:crypto";
import { query, withTenant, withoutTenantScope } from "./db";
import { provisionBusiness } from "./business-provisioning";
import { requirePlatformAdmin } from "./platform-auth";
import { PERMISSIONS, type Permission } from "./permissions";
import type { PlatformSessionPayload } from "./platform-auth-edge";
import { APP_KEYS } from "./apps";
import bcrypt from "bcryptjs";

export const COMPANY_ACCESS_PRESETS = [
  "company_owner",
  "finance",
  "sales_success",
  "marketing",
  "website_editor",
  "project_manager",
] as const;
export type CompanyAccessPreset = (typeof COMPANY_ACCESS_PRESETS)[number];

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

async function mappedActor(session: PlatformSessionPayload): Promise<PlatformCompanyActor | null> {
  const { rows } = await query<{
    business_id: string; user_id: string; access_preset: CompanyAccessPreset;
    revision: string; full_name: string; member_active: boolean;
  }>(
    `SELECT m.business_id, m.user_id, m.access_preset, m.revision::text,
            u.full_name, u.is_active AS member_active
       FROM platform_company_members m
       JOIN businesses b ON b.id = m.business_id AND b.ownership_kind = 'platform_internal'
       JOIN users u ON u.id = m.user_id AND u.business_id = m.business_id
      WHERE m.platform_admin_id = $1 AND m.is_active AND b.status = 'active'`,
    [session.padmin],
  );
  const row = rows[0];
  if (!row?.member_active) return null;
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

/**
 * Authorize from current identity state and execute under the internal tenant.
 * No client-supplied business id is accepted anywhere in this contract.
 */
export async function withPlatformCompany<T>(
  permission: Permission,
  operation: (actor: PlatformCompanyActor) => Promise<T>,
): Promise<{ ok: true; value: T; actor: PlatformCompanyActor } | { ok: false; status: 401 | 403 | 404; error: string }> {
  const guard = await requirePlatformAdmin();
  if (guard.error) return { ok: false, status: 401, error: "unauthorized" };
  const actor = await mappedActor(guard.session);
  if (!actor) return { ok: false, status: 404, error: "platform_company_not_provisioned_or_not_member" };
  if (!actor.permissions.has(permission)) return { ok: false, status: 403, error: "company_permission_denied" };
  const value = await withTenant(actor.businessId, () => operation(actor), { userId: actor.userId });
  return { ok: true, value, actor };
}

export async function platformCompanyStatus(platformAdminId: string) {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{
      business_id: string; name: string; subdomain: string; access_preset: CompanyAccessPreset | null;
      is_active: boolean | null;
    }>(
      `SELECT b.id AS business_id, b.name, b.subdomain::text, m.access_preset, m.is_active
         FROM businesses b
         LEFT JOIN platform_company_members m
           ON m.business_id = b.id AND m.platform_admin_id = $1
        WHERE b.ownership_kind = 'platform_internal'`,
      [platformAdminId],
    );
    return rows[0] ?? null;
  });
}

/** Idempotent and concurrency-safe through provisioning's advisory lock plus the partial unique index. */
export async function ensurePlatformCompany(session: PlatformSessionPayload) {
  const existing = await platformCompanyStatus(session.padmin);
  if (existing) return existing;

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
    if (raced) return raced;
    throw error;
  }

  await withoutTenantScope("platform", async () => {
    await query(
      `INSERT INTO platform_company_members
         (platform_admin_id,business_id,user_id,access_preset,granted_by)
       VALUES ($1,$2,$3,'company_owner',$1)
       ON CONFLICT (platform_admin_id) DO UPDATE SET
         business_id=EXCLUDED.business_id,user_id=EXCLUDED.user_id,
         access_preset='company_owner',is_active=true,revision=platform_company_members.revision+1,updated_at=now()`,
      [session.padmin, provisioned.businessId, provisioned.userId],
    );
    await query(
      `INSERT INTO platform_company_entitlements (business_id, capability)
       SELECT $1, unnest($2::text[])
       ON CONFLICT (business_id, capability) DO UPDATE SET enabled=true`,
      [provisioned.businessId, [...APP_KEYS, "workspace"]],
    );
    await query(
      `INSERT INTO business_app_availability (business_id,app_key,state,note,updated_by)
       SELECT $1, unnest($2::text[]), 'available', 'دسترسی داخلی شرکت پلتفرم', $3
       ON CONFLICT (business_id,app_key) DO UPDATE SET state='available',note=EXCLUDED.note,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [provisioned.businessId, APP_KEYS, session.padmin],
    );
    // Defensive lifecycle exclusion: an internal company never participates in
    // customer renewal/trial suspension even if a generic provision hook added a row.
    await query(`DELETE FROM business_subscriptions WHERE business_id = $1`, [provisioned.businessId]);
  });
  return (await platformCompanyStatus(session.padmin))!;
}

export function hashCompanyHandoff(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createCompanyHandoff(actor: PlatformCompanyActor, returnPath: string) {
  const allowed = ["/workspace", "/accounting", "/crm", "/growth", "/websites"];
  if (!allowed.some((prefix) => returnPath === prefix || returnPath.startsWith(`${prefix}/`))) {
    throw new Error("invalid_company_return_path");
  }
  const token = randomBytes(32).toString("base64url");
  await withoutTenantScope("platform", () => query(
    `INSERT INTO platform_company_handoffs
       (token_hash,platform_admin_id,business_id,user_id,return_path,expires_at)
     VALUES ($1,$2,$3,$4,$5,now()+interval '2 minutes')`,
    [hashCompanyHandoff(token), actor.platformAdminId, actor.businessId, actor.userId, returnPath],
  ));
  const { rows } = await withoutTenantScope("platform", () => query<{ subdomain: string }>(
    `SELECT subdomain::text FROM businesses WHERE id=$1`, [actor.businessId],
  ));
  return { token, subdomain: rows[0].subdomain, returnPath };
}

export interface PlatformCompanyMemberSummary {
  platformAdminId: string;
  fullName: string;
  email: string;
  preset: CompanyAccessPreset | null;
  active: boolean;
  revision: number;
}

export async function listPlatformCompanyMembers(businessId: string): Promise<PlatformCompanyMemberSummary[]> {
  const { rows } = await query<{
    id: string; full_name: string; email: string; access_preset: CompanyAccessPreset | null;
    is_active: boolean | null; revision: string | null;
  }>(
    `SELECT pa.id,pa.full_name,pa.email::text,m.access_preset,m.is_active,m.revision::text
       FROM platform_admins pa
       LEFT JOIN platform_company_members m
         ON m.platform_admin_id=pa.id AND m.business_id=$1
      WHERE pa.is_active
      ORDER BY pa.full_name,pa.id`, [businessId],
  );
  return rows.map((row) => ({
    platformAdminId: row.id, fullName: row.full_name, email: row.email,
    preset: row.access_preset, active: row.is_active === true, revision: Number(row.revision ?? 0),
  }));
}

/** Add/update a real tenant actor for an active platform identity. */
export async function setPlatformCompanyMember(
  actor: PlatformCompanyActor,
  platformAdminId: string,
  preset: CompanyAccessPreset,
  active: boolean,
): Promise<PlatformCompanyMemberSummary> {
  if (platformAdminId === actor.platformAdminId && !active) throw new Error("cannot_revoke_self");
  const { rows: admins } = await query<{ id: string; email: string; full_name: string }>(
    `SELECT id,email::text,full_name FROM platform_admins WHERE id=$1 AND is_active`, [platformAdminId],
  );
  const admin = admins[0];
  if (!admin) throw new Error("platform_admin_not_found");
  const passwordHash = await bcrypt.hash(randomBytes(32).toString("base64url"), 12);
  const { rows: identities } = await query<{ id: string }>(
    `INSERT INTO platform_users (email,password_hash,full_name)
     VALUES ($1,$2,$3)
     ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name
     RETURNING id`, [admin.email, passwordHash, admin.full_name],
  );
  const role = preset === "company_owner" ? "owner" : preset === "finance" ? "accountant" : "manager";
  const granted = [...PRESET_PERMISSIONS[preset]];
  const permissions = {
    granted,
    revoked: Object.values(PERMISSIONS).filter((permission) => !granted.includes(permission)),
  };
  const { rows: users } = await query<{ id: string }>(
    `INSERT INTO users (business_id,platform_user_id,email,full_name,role,is_active,permissions)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (business_id,platform_user_id) WHERE platform_user_id IS NOT NULL
     DO UPDATE SET email=EXCLUDED.email,full_name=EXCLUDED.full_name,role=EXCLUDED.role,
       is_active=EXCLUDED.is_active,permissions=EXCLUDED.permissions,updated_at=now()
     RETURNING id`, [actor.businessId, identities[0].id, admin.email, admin.full_name, role, active, JSON.stringify(permissions)],
  );
  await query(
    `INSERT INTO platform_company_members
       (platform_admin_id,business_id,user_id,access_preset,is_active,granted_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (platform_admin_id) DO UPDATE SET
       business_id=EXCLUDED.business_id,user_id=EXCLUDED.user_id,access_preset=EXCLUDED.access_preset,
       is_active=EXCLUDED.is_active,granted_by=EXCLUDED.granted_by,
       revision=platform_company_members.revision+1,updated_at=now()`,
    [platformAdminId, actor.businessId, users[0].id, preset, active, actor.platformAdminId],
  );
  const members = await listPlatformCompanyMembers(actor.businessId);
  return members.find((member) => member.platformAdminId === platformAdminId)!;
}
