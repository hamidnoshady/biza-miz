import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { deploymentRole } from "@/lib/deployment-role";
import { getMasterKey } from "@/lib/master-key";

/** Owner-only Desktop recovery material; never expose a central/platform KEK to a tenant. */
export const GET = withTenantScope(async () => {
  const { error } = await requirePermission(PERMISSIONS.backupConfigure);
  if (error) return error;
  if (deploymentRole() !== "site" || !process.env.DESKTOP_INSTANCE_ID) {
    return NextResponse.json({ error: "desktop_recovery_kit_only" }, { status: 404 });
  }
  const masterKey = getMasterKey();
  if (!masterKey) {
    return NextResponse.json({ error: "recovery_kit_unavailable" }, { status: 503 });
  }
  return NextResponse.json(
    { recoveryKit: { format: "POS_MASTER_KEY/base64", masterKey: masterKey.toString("base64") } },
    { headers: { "Cache-Control": "no-store" } },
  );
});
