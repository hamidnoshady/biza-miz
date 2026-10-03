import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import {
  COMPANY_ACCESS_PRESET_KEYS,
  isCompanyAccessPreset,
  listPlatformCompanyMembers,
  setPlatformCompanyMember,
  withPlatformCompany,
} from "@/lib/platform-company";
import { platformAudit, withPlatformScope } from "@/lib/platform-auth";

/**
 * Company staff administration.
 *
 * Guarded by the company permission `team.manage` — never by an infrastructure
 * capability. A company owner with no platform role beyond a login can
 * administer their own staff; a platform owner with no company membership
 * cannot.
 */
export const GET = withPlatformScope(async (): Promise<NextResponse> => {
  const result = await withPlatformCompany(PERMISSIONS.teamManage, (actor) =>
    listPlatformCompanyMembers(actor.businessId),
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ members: result.value, presets: COMPANY_ACCESS_PRESET_KEYS });
});

export const PATCH = withPlatformScope(async (request: NextRequest): Promise<NextResponse> => {
  let body: { platformAdminId?: string; preset?: string; active?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (
    typeof body?.platformAdminId !== "string" ||
    !isCompanyAccessPreset(body?.preset) ||
    typeof body?.active !== "boolean"
  ) {
    return NextResponse.json({ error: "invalid_member_update" }, { status: 400 });
  }
  const platformAdminId = body.platformAdminId;
  const preset = body.preset;
  const active = body.active;
  try {
    const result = await withPlatformCompany(PERMISSIONS.teamManage, async (actor) => {
      const member = await setPlatformCompanyMember(actor, platformAdminId, preset, active);
      await platformAudit({
        adminId: actor.platformAdminId,
        businessId: actor.businessId,
        action: active ? "platform_company.member.updated" : "platform_company.member.revoked",
        entity: "platform_company_member",
        entityId: platformAdminId,
        // Preset and activation state only — never an email, a name or anything
        // the audit log does not need in order to answer "who changed what".
        payload: { preset, active },
      });
      return member;
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ member: result.value });
  } catch (error) {
    const code = error instanceof Error ? error.message : "member_update_failed";
    const status =
      code === "platform_admin_not_found"
        ? 404
        : code === "cannot_revoke_self" || code === "last_company_owner"
          ? 409
          : code === "invalid_preset"
            ? 400
            : 500;
    return NextResponse.json({ error: code }, { status });
  }
});
