import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import {
  classifyConnectionCode,
  normalizeServerAddress,
} from "@/lib/connection-code";
import { applyPairingSnapshot } from "@/lib/pairing-apply";
import { validateSnapshot } from "@/lib/pairing-snapshot";
import { hasAnyUser } from "@/lib/setup-state";
import { acknowledgePendingPairing } from "@/lib/server-sync";

/** How long to wait on the online server before calling it unreachable. */
const REDEEM_TIMEOUT_MS = 30_000;

/** Electron supplies this durable identity; the deterministic fallback keeps non-Electron development resumable. */
function localInstallationId(): string {
  const desktopId = process.env.DESKTOP_INSTANCE_ID?.trim();
  if (desktopId && desktopId.length >= 8 && desktopId.length <= 200)
    return desktopId;
  return `server:${createHash("sha256")
    .update(process.env.HOSTNAME || "local-development")
    .digest("hex")}`;
}

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
    // Cloud credentials are never copied. The wizard must establish a PIN,
    // local password or passkey for this site before ending this session.
    requiresOfflineCredential: true,
  });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return response;
}
