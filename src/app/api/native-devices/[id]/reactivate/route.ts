import { NextResponse, type NextRequest } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { NativeDeviceError, reactivateNativeDevice } from "@/lib/native-device-service";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * Issue #884 — lets a previously revoked Android installation register
 * again. Owner decision #3: reactivation requires this explicit owner/admin
 * action, same gate as revoking (`native_devices.manage`), and does not by
 * itself restore any access — the member still has to sign in again and the
 * app still has to call `POST /api/native-devices` again, because the
 * session this installation used was already invalidated the moment it was
 * revoked. That is what makes "followed by fresh authentication" true
 * without this route needing to do anything about sessions itself.
 */
export const POST = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.nativeDevicesManage);
  if (error) return error;
  const { id } = await context.params;
  try {
    await reactivateNativeDevice(id, session.businessId, session.sub);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof NativeDeviceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
