import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import {
  COMPANY_ACCESS_PRESETS,
  listPlatformCompanyMembers,
  setPlatformCompanyMember,
  withPlatformCompany,
  type CompanyAccessPreset,
} from "@/lib/platform-company";
import { platformAudit } from "@/lib/platform-auth";

export async function GET() {
  const result = await withPlatformCompany(PERMISSIONS.teamManage, (actor) =>
    listPlatformCompanyMembers(actor.businessId),
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ members: result.value, presets: COMPANY_ACCESS_PRESETS });
}

export async function PATCH(request: NextRequest) {
  let body: { platformAdminId?: string; preset?: string; active?: boolean };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  if (!body.platformAdminId || !COMPANY_ACCESS_PRESETS.includes(body.preset as CompanyAccessPreset) || typeof body.active !== "boolean") {
    return NextResponse.json({ error: "invalid_member_update" }, { status: 400 });
  }
  try {
    const result = await withPlatformCompany(PERMISSIONS.teamManage, async (actor) => {
      const member = await setPlatformCompanyMember(actor, body.platformAdminId!, body.preset as CompanyAccessPreset, body.active!);
      await platformAudit({
        adminId: actor.platformAdminId,
        businessId: actor.businessId,
        action: body.active ? "platform_company.member.updated" : "platform_company.member.revoked",
        entity: "platform_company_member",
        entityId: body.platformAdminId,
        payload: { preset: body.preset },
      });
      return member;
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ member: result.value });
  } catch (error) {
    const code = error instanceof Error ? error.message : "member_update_failed";
    const status = code === "platform_admin_not_found" ? 404 : code === "cannot_revoke_self" ? 409 : 500;
    return NextResponse.json({ error: code }, { status });
  }
}
