import { NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requirePermission } from "@/lib/auth";

/**
 * Kept as a safe compatibility endpoint after Phase 18 removed the
 * per-business provider/key form. It intentionally never returns or accepts
 * provider credentials; the AI connection is platform-managed (LiteLLM).
 */
export const GET = withTenantScope(async () => {
  const { error } = await requirePermission(PERMISSIONS.aiManage);
  if (error) return error;
  return NextResponse.json(
    { error: "ai_configuration_platform_managed" },
    { status: 410 },
  );
});

export const PUT = withTenantScope(async () => {
  const { error } = await requirePermission(PERMISSIONS.aiManage);
  if (error) return error;
  return NextResponse.json(
    { error: "ai_configuration_platform_managed" },
    { status: 410 },
  );
});
