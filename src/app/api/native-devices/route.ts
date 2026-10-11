import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  requireMember,
  requirePermission,
  sessionCookieOptions,
  signSession,
  withTenantScope,
} from "@/lib/auth";
import { NATIVE_ENVIRONMENTS, type NativeEnvironment } from "@/lib/native/bridge-contract";
import {
  NativeDeviceError,
  listNativeDevicesForBusiness,
  registerNativeDevice,
} from "@/lib/native-device-service";
import { PERMISSIONS } from "@/lib/permissions";

const MAX_INSTALL_ID_LENGTH = 128;
const MIN_INSTALL_ID_LENGTH = 8;
const MAX_VERSION_NAME_LENGTH = 32;
const INSTALL_ID_PATTERN = /^[A-Za-z0-9-]+$/;

/**
 * Issue #884 — every registered Android installation across the business.
 * Business-wide, gated the same way the device-management surfaces above it
 * are: `native_devices.manage` (owner, or a member it was explicitly granted
 * to — see permissions.ts). A plain member's own device is at
 * `/api/native-devices/self`, never here.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.nativeDevicesManage);
  if (error) return error;
  const devices = await listNativeDevicesForBusiness(session.businessId);
  return NextResponse.json({ devices });
});

interface RegisterBody {
  installationId?: unknown;
  environment?: unknown;
  appVersionName?: unknown;
  appVersionCode?: unknown;
  bridgeVersion?: unknown;
}

/**
 * Registers the caller's own Android installation (owner decision #2,
 * ISSUE_884_PLAN.md): the web app calls this after login and business
 * selection, once it has the installation identity from the `device.identity`
 * bridge command. `requireMember` — not a permission — because every member
 * registers only their own installation; `registerNativeDevice` is what
 * scopes the write to `session.sub`.
 *
 * On success, re-signs the session cookie with `nativeDeviceId` so this
 * browser's session is now bound to the row — the enforcement half lives in
 * `checkNativeDevice` (auth.ts), re-checked on every later request.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireMember();
  if (error) return error;

  let body: RegisterBody;
  try {
    body = (await request.json()) as RegisterBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const installationId = body.installationId;
  if (
    typeof installationId !== "string" ||
    installationId.length < MIN_INSTALL_ID_LENGTH ||
    installationId.length > MAX_INSTALL_ID_LENGTH ||
    !INSTALL_ID_PATTERN.test(installationId)
  ) {
    return NextResponse.json({ error: "invalid_installation_id" }, { status: 400 });
  }
  if (!(NATIVE_ENVIRONMENTS as readonly unknown[]).includes(body.environment)) {
    return NextResponse.json({ error: "invalid_environment" }, { status: 400 });
  }
  const appVersionName = body.appVersionName;
  if (
    typeof appVersionName !== "string" ||
    appVersionName.length < 1 ||
    appVersionName.length > MAX_VERSION_NAME_LENGTH
  ) {
    return NextResponse.json({ error: "invalid_app_version_name" }, { status: 400 });
  }
  const appVersionCode = body.appVersionCode;
  if (typeof appVersionCode !== "number" || !Number.isSafeInteger(appVersionCode) || appVersionCode < 1) {
    return NextResponse.json({ error: "invalid_app_version_code" }, { status: 400 });
  }
  const bridgeVersion = body.bridgeVersion;
  if (typeof bridgeVersion !== "number" || !Number.isSafeInteger(bridgeVersion) || bridgeVersion < 1) {
    return NextResponse.json({ error: "invalid_bridge_version" }, { status: 400 });
  }

  try {
    const { device, created } = await registerNativeDevice(session.businessId, session.sub, {
      installId: installationId,
      appEnvironment: body.environment as NativeEnvironment,
      appVersionName,
      appVersionCode,
      bridgeVersion,
    });
    const nextToken = await signSession({ ...session, nativeDeviceId: device.id });
    const res = NextResponse.json({ device }, { status: created ? 201 : 200 });
    res.cookies.set(SESSION_COOKIE, nextToken, sessionCookieOptions());
    return res;
  } catch (err) {
    if (err instanceof NativeDeviceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
