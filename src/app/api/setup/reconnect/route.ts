import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { normalizeServerAddress } from "@/lib/connection-code";
import { repairPairingSnapshot } from "@/lib/pairing-apply";
import { validateSnapshot } from "@/lib/pairing-snapshot";

const REDEEM_TIMEOUT_MS = 30_000;

/**
 * Rebind an already-initialized desktop without deleting its local business,
 * queued events, users, or audit history. The Owner issues a fresh pairing
 * code from cloud, then enters it here only when repair is actually needed.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;
  let body: { remoteUrl?: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const address = normalizeServerAddress(body.remoteUrl ?? "");
  const code = body.code?.trim() ?? "";
  if (!address.ok || !code) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  let remote: Response;
  try {
    remote = await fetch(`${address.url}/api/pairing/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, deviceName: process.env.DESKTOP_DEVICE_NAME || "Windows Business Suite" }),
      signal: AbortSignal.timeout(REDEEM_TIMEOUT_MS),
    });
  } catch {
    return NextResponse.json({ error: "remote_unreachable" }, { status: 502 });
  }
  const payload = await remote.json().catch(() => ({})) as { snapshot?: unknown; error?: string };
  if (!remote.ok) return NextResponse.json({ error: payload.error ?? "remote_unreachable" }, { status: remote.status });
  const validated = validateSnapshot(payload.snapshot);
  if (!validated.ok || validated.snapshot.business.id !== session.businessId) {
    return NextResponse.json({ error: "repair_business_mismatch" }, { status: 409 });
  }

  await repairPairingSnapshot(validated.snapshot, address.url);
  // The persisted pairingPending configuration retries this acknowledgement on
  // every sync tick if this request is interrupted after its local commit.
  let activationPending = false;
  try {
    const activation = await fetch(`${address.url}/api/pairing/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validated.snapshot.syncToken}` },
      body: JSON.stringify({ siteDeviceId: validated.snapshot.siteDevice.id }),
      signal: AbortSignal.timeout(REDEEM_TIMEOUT_MS),
    });
    activationPending = !activation.ok;
  } catch {
    activationPending = true;
  }
  return NextResponse.json({ ok: true, activationPending });
});
