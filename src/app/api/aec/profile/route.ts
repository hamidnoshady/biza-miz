import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { loadBusinessAecProfile, saveBusinessAecProfile } from "@/lib/aec-service";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../guard";

/**
 * The business's AEC operating profile — «پروفایل کسب‌وکار» for an
 * architecture/engineering/construction tenant.
 *
 * GET  — the stored profile, or the default preset when none has been saved
 *        yet (`stored: false` says which).
 * PUT  — replace the profile, its specialties and its capability overrides in
 *        one save.
 *
 * Both run on `settings.manage`: this is business-wide configuration, the same
 * key the settings section that edits it requires, and not a per-project write
 * a project editor should be able to make. A business of another industry is
 * refused with `industry_mismatch` — the profile means nothing outside AEC.
 */
export const GET = withTenantScope(async () => {
  const { owner, error } = await aecOwner(PERMISSIONS.settingsManage);
  if (error) return error;
  try {
    return NextResponse.json({ profile: await loadBusinessAecProfile(owner.businessId) });
  } catch (err) {
    return handleAecError(err);
  }
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await aecOwner(PERMISSIONS.settingsManage);
  if (error) return error;
  const body = await readBody(request);
  try {
    return NextResponse.json({ profile: await saveBusinessAecProfile(owner, body) });
  } catch (err) {
    return handleAecError(err);
  }
});
