import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import {
  classifyConnectionCode,
  normalizeServerAddress,
} from "@/lib/connection-code";
import { syncHybridLoginCredentials } from "@/lib/iam/login-credential-sync";
import { applyPairingSnapshot, localInstallationId } from "@/lib/pairing-apply";
import {
  answersCapability,
  DESKTOP_REDEEM_CAPABILITY,
  validateSnapshot,
} from "@/lib/pairing-snapshot";
import { hasAnyUser } from "@/lib/setup-state";
import { acknowledgePendingPairing } from "@/lib/server-sync";

/** How long to wait on the online server before calling it unreachable. */
const REDEEM_TIMEOUT_MS = 30_000;

/**
 * Where to redeem, in order.
 *
 * The host-neutral path first, because that is the one that answers on the
 * business origin an owner copies out of their address bar; the original
 * /api/platform path second, so this desktop build still pairs against a cloud
 * server that predates it. See src/lib/pairing-redeem.ts.
 */
const REDEEM_PATHS = ["/api/pairing/redeem", "/api/platform/pairing/redeem"];

const PASSTHROUGH_ERRORS = new Set([
  "code_not_found",
  "code_expired",
  "code_already_redeemed",
  "code_revoked",
  "pairing_session_unavailable",
]);

/**
 * First-run pairing: claim an existing online business on this install.
 *
 * Public for the same reason /api/setup/bootstrap is — the database is empty,
 * so there is no session to require and no tenant to scope to. It refuses the
 * moment any user exists, which is what stops it being a way to overwrite a
 * working install.
 *
 * Everything happens server-side rather than in the browser: the snapshot
 * carries credential hashes, and routing it through the browser would put them
 * in a place they have no business being.
 */
export async function POST(request: NextRequest) {
  if (await hasAnyUser()) {
    return NextResponse.json({ error: "already_initialized" }, { status: 409 });
  }

  let body: { remoteUrl?: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const code = body.code?.trim() ?? "";
  // The address is accepted in whatever form it was copied — a bare hostname,
  // a full dashboard URL with a path, Persian digits from a Persian keyboard —
  // because the natural gesture is to copy the address bar of the cloud
  // account the owner is signed into. See connection-code.ts.
  const address = normalizeServerAddress(body.remoteUrl ?? "");
  if (!address.ok) {
    return NextResponse.json(
      {
        error:
          address.error === "missing_address"
            ? "missing_fields"
            : "invalid_url",
      },
      { status: 400 },
    );
  }
  const remoteUrl = address.url;
  if (!code)
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  // Name the credential mix-up before spending a round trip on it: the owner
  // who pastes a `POS1-…` server-sync token here has been told, until now,
  // only that their "code is not valid".
  const kind = classifyConnectionCode(code);
  if (kind !== "pairing_code") {
    return NextResponse.json({ error: `code_${kind}` }, { status: 400 });
  }

  // Try the host-neutral URL, then the legacy one. A 404/405 means *this
  // server* does not serve that path (an older cloud build), which is the only
  // condition worth falling back on — a real redemption failure comes back as
  // one of the PASSTHROUGH_ERRORS and is reported as itself.
  const installationId = localInstallationId();
  let remoteResponse: Response | null = null;
  let payload: {
    snapshot?: unknown;
    pairingSessionId?: unknown;
    error?: string;
  } = {};
  for (const path of REDEEM_PATHS) {
    try {
      remoteResponse = await fetch(`${remoteUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          deviceName:
            process.env.DESKTOP_DEVICE_NAME || "Windows Business Suite",
          installationId,
          ...DESKTOP_REDEEM_CAPABILITY,
        }),
        signal: AbortSignal.timeout(REDEEM_TIMEOUT_MS),
      });
    } catch {
      return NextResponse.json(
        { error: "remote_unreachable" },
        { status: 502 },
      );
    }
    payload = (await remoteResponse.json().catch(() => ({}))) as {
      snapshot?: unknown;
      pairingSessionId?: unknown;
      error?: string;
    };
    if (remoteResponse.status !== 404 && remoteResponse.status !== 405) break;
    // A 404 carrying a redemption error is the *code* not being found, not the
    // route — stop and report it rather than retrying against the legacy path.
    if (payload.error && PASSTHROUGH_ERRORS.has(payload.error)) break;
  }

  if (!remoteResponse)
    return NextResponse.json({ error: "remote_unreachable" }, { status: 502 });

  if (!remoteResponse.ok) {
    if (payload.error && PASSTHROUGH_ERRORS.has(payload.error)) {
      return NextResponse.json(
        { error: payload.error },
        { status: remoteResponse.status },
      );
    }
    return NextResponse.json({ error: "remote_unreachable" }, { status: 502 });
  }

  const validation = validateSnapshot(payload.snapshot);
  if (!validation.ok) {
    return NextResponse.json({ error: "snapshot_invalid" }, { status: 502 });
  }
  // Checked before anything is written: an older cloud would restore archived
  // and contra accounts as if they were ordinary active ones.
  if (!answersCapability(validation.snapshot.version)) {
    return NextResponse.json({ error: "server_predates_account_state" }, { status: 502 });
  }

  // Re-checked immediately before the write: the hasAnyUser() at the top is a
  // fast rejection, but the redeem round trip above takes seconds, and
  // applying into a non-empty database would violate the primary keys the
  // snapshot carries.
  if (await hasAnyUser()) {
    return NextResponse.json({ error: "already_initialized" }, { status: 409 });
  }

  const pairingSessionId =
    typeof payload.pairingSessionId === "string"
      ? payload.pairingSessionId
      : undefined;
  const applied = await applyPairingSnapshot(validation.snapshot, remoteUrl, {
    pairingSessionId,
    installationId,
  });

  // The cloud credential intentionally remains pending until this point.
  // `acknowledgePendingPairing` also promotes the stored local config to
  // enabled only after the cloud confirms the committed snapshot. If the
  // response is lost it leaves the durable recovery metadata intact for the
  // normal sync tick to retry; it never strands this newly-created business.
  const acknowledgement = pairingSessionId
    ? await acknowledgePendingPairing(applied.businessId)
    : { status: "skipped" as const };
  const activationPending =
    pairingSessionId !== undefined && acknowledgement.status !== "ok";

  // First-run credential convergence, before pairing is considered complete.
  //
  // The pairing snapshot carries membership metadata only; staff PINs and the
  // replicated password/MFA identities travel on `/api/iam/login-credentials`.
  // Without this call the first login after pairing could show only the owner
  // created during setup while cloud PIN staff sit credential-less locally,
  // waiting for a background tick. So the credential stage runs here, inside
  // the pairing request, and its outcome is returned to the wizard and stored
  // durably. If the cloud is momentarily unavailable the owner stays usable
  // and the state is `degraded`/`pending` with a retry (manual sync), never a
  // silent claim that pairing fully converged.
  const credentialSync = await syncHybridLoginCredentials(applied.businessId).catch(
    (error: unknown) => ({
      status: "degraded" as const,
      pinMembersExpected: 0,
      pinMembersUsable: 0,
      pinMembersMissing: 0,
      missingIdentityBindings: 0,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  const identitySyncPending = credentialSync.status !== "healthy";

  const token = await signSession({
    sub: applied.ownerUserId,
    role: "owner",
    businessId: applied.businessId,
    businessSlug: applied.businessSlug,
    businessSubdomain: applied.businessSubdomain,
    locationId: null,
    fullName: applied.ownerName,
    platformUserId: applied.ownerPlatformUserId,
  });
  const response = NextResponse.json({
    ok: true,
    slug: applied.businessSlug,
    ownerUserId: applied.ownerUserId,
    activationPending,
    // Hybrid replicates supported cloud login material on purpose
    // (`/api/iam/login-credentials`: password hashes, TOTP/recovery codes and
    // staff PIN hashes), so the wizard must not tell the owner Cloud
    // credentials stay in the cloud. What it must still ask for is a
    // *device-local* owner PIN: the guaranteed offline door for this install,
    // which a later credential sync never overwrites. See
    // src/lib/iam/login-credentials.ts for the ownership rules.
    requiresOfflineCredential: true,
    // The first-run convergence outcome, so the wizard can distinguish
    // "paired and ready" from "paired, identity sync still pending".
    identitySyncPending,
    credentialSync: {
      status: credentialSync.status,
      pinMembersExpected: credentialSync.pinMembersExpected,
      pinMembersUsable: credentialSync.pinMembersUsable,
      pinMembersMissing: credentialSync.pinMembersMissing,
      missingIdentityBindings: credentialSync.missingIdentityBindings,
      error: credentialSync.error ?? null,
    },
  });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return response;
}
