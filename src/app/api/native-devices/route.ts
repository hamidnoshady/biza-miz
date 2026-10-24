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
  capabilities?: unknown;
  pushToken?: unknown;
  pushProvider?: unknown;
  pushChannels?: unknown;
  biometricEnabled?: unknown;
  biometricVerified?: unknown;
  callerIdRoleHeld?: unknown;
  syncedNow?: unknown;
}

/**
 * Registers the caller's own Android installation (owner decision #2,
 * docs/plans/ISSUE_884_PLAN.md): the web app calls this after login and business
 * selection, once it has the installation identity from the `device.identity`
 * bridge command. `requireMember` — not a permission — because every member
 * registers only their own installation; `registerNativeDevice` is what
 * scopes the write to `session.sub`.
 *
 * On success, re-signs the session cookie with `nativeDeviceId` and
 * `nativeDeviceGeneration` so this browser's session is now bound to the
 * row — the enforcement half lives in `checkNativeDevice` (auth.ts),
 * re-checked on every later request.
 *
 * On `device_revoked`, the registration itself still fails (409), but the
 * session cookie is *also* re-signed, bound to that same (revoked) row. This
 * is what actually closes the gap a silent client failure would otherwise
 * leave open: the bridge-driven registrar never reads this response body
 * (docs/plans/ISSUE_884_PLAN.md's offline-limitation decision — it cannot show the
 * member anything useful anyway), so without this the browser's session
 * would stay completely unbound — and therefore fully authenticated, with
 * no revocation enforcement ever applying to it — for its entire remaining
 * lifetime, exactly for a device revoked before it ever finished
 * registering. Binding it here means `checkNativeDevice` denies this
 * session on the very next protected request regardless of what the client
 * does with a 409.
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
  const pushToken = body.pushToken;
  if (
    pushToken !== undefined &&
    pushToken !== null &&
    (typeof pushToken !== "string" || pushToken.length < 16 || pushToken.length > 4096)
  ) {
    return NextResponse.json({ error: "invalid_push_token" }, { status: 400 });
  }
  const pushProvider = body.pushProvider;
  if (
    pushProvider !== undefined &&
    pushProvider !== null &&
    pushProvider !== "fcm" &&
    pushProvider !== "webpush" &&
    pushProvider !== "none"
  ) {
    return NextResponse.json({ error: "invalid_push_provider" }, { status: 400 });
  }

  const normalizedCapabilities = Array.isArray(body.capabilities)
    ? body.capabilities.filter((c): c is string => typeof c === "string" && c.length <= 64).slice(0, 32)
    : undefined;
  const normalizedPushChannels = Array.isArray(body.pushChannels)
    ? body.pushChannels.filter((c): c is string => typeof c === "string" && c.length <= 64).slice(0, 16)
    : undefined;

  try {
    const { device, created } = await registerNativeDevice(session.businessId, session.sub, {
      installId: installationId,
      appEnvironment: body.environment as NativeEnvironment,
      appVersionName,
      appVersionCode,
      bridgeVersion,
      ...(normalizedCapabilities !== undefined ? { capabilities: normalizedCapabilities } : {}),
      ...(pushToken !== undefined ? { pushToken } : {}),
      ...(pushProvider !== undefined ? { pushProvider } : {}),
      ...(normalizedPushChannels !== undefined ? { pushChannels: normalizedPushChannels } : {}),
      ...(typeof body.biometricEnabled === "boolean" ? { biometricEnabled: body.biometricEnabled } : {}),
      ...(typeof body.biometricVerified === "boolean" ? { biometricVerified: body.biometricVerified } : {}),
      ...(typeof body.callerIdRoleHeld === "boolean" ? { callerIdRoleHeld: body.callerIdRoleHeld } : {}),
      ...(typeof body.syncedNow === "boolean" ? { syncedNow: body.syncedNow } : {}),
    });
    const nextToken = await signSession({
      ...session,
      nativeDeviceId: device.id,
      nativeDeviceGeneration: device.sessionGeneration,
    });
    const res = NextResponse.json({ device }, { status: created ? 201 : 200 });
    res.cookies.set(SESSION_COOKIE, nextToken, sessionCookieOptions(session));
    return res;
  } catch (err) {
    if (err instanceof NativeDeviceError) {
      const res = NextResponse.json({ error: err.message }, { status: err.status });
      // See this handler's doc comment: a `device_revoked` failure still
      // binds the session, so revocation is enforced from the very next
      // request even though this one failed and the client may never look
      // at why.
      if (err.message === "device_revoked" && err.deviceId && err.sessionGeneration !== undefined) {
        const nextToken = await signSession({
          ...session,
          nativeDeviceId: err.deviceId,
          nativeDeviceGeneration: err.sessionGeneration,
        });
        res.cookies.set(SESSION_COOKIE, nextToken, sessionCookieOptions(session));
      }
      return res;
    }
    throw err;
  }
});
