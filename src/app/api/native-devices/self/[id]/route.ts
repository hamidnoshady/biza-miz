import { NextResponse, type NextRequest } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { NativeDeviceError, revokeOwnNativeDevice } from "@/lib/native-device-service";

/**
 * Issue #884 — a member revoking their own Android installation (a lost or
 * stolen phone). `revokeOwnNativeDevice` is what scopes the write to
 * `session.sub`; this never reaches a device belonging to anyone else, even
 * another member of the same business.
 *
 * Revocation is immediate but cannot reach an offline device — the owner
 * decision's documented limitation. What it *does* do immediately is end the
 * authenticated access the session this installation registered had: the
 * next request that session makes is re-checked by `checkNativeDevice`
 * (auth.ts) and refused.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireMember();
  if (error) return error;
  const { id } = await context.params;
  try {
    await revokeOwnNativeDevice(id, session.businessId, session.sub);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof NativeDeviceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
