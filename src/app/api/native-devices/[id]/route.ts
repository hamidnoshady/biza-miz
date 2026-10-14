import { NextResponse, type NextRequest } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { NativeDeviceError, revokeNativeDeviceAsAdmin } from "@/lib/native-device-service";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * Issue #884 — an owner/admin revoking any Android installation in the
 * business, gated on `native_devices.manage` (owner decision #1). Reaches
 * every member's device, not only the caller's own — `/api/native-devices
 * /self/[id]` is the self-service counterpart that never does.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.nativeDevicesManage);
  if (error) return error;
  const { id } = await context.params;
  try {
    await revokeNativeDeviceAsAdmin(id, session.businessId, session.sub);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof NativeDeviceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
