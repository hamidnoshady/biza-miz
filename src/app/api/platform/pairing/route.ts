import { NextRequest, NextResponse } from "next/server";
import {
  platformAudit,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import { getBusiness } from "@/lib/platform-service";
import {
  issuePairingCode,
  listPairingCodes,
  listPairingLocations,
  revokePairingCode,
} from "@/lib/pairing-service";

/**
 * Desktop pairing codes for one business.
 *
 * Guarded on `business.provision` (owner-only) rather than a read capability
 * even for the list: a code's existence and expiry are operational secrets,
 * and the only reason to look at the list is to decide whether to issue or
 * revoke one.
 */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformCapability("business.provision");
  if (error) return error;

  const businessId = request.nextUrl.searchParams.get("businessId");
  if (!businessId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  const business = await getBusiness(businessId);
  if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (business.ownershipKind === "platform_internal") {
    return NextResponse.json({ error: "internal_business_pairing_unsupported" }, { status: 409 });
  }

  const [codes, locations] = await Promise.all([
    listPairingCodes(businessId),
    listPairingLocations(businessId),
  ]);
  return NextResponse.json({ codes, locations });
});

/** Issue a code. The plaintext is in this response and nowhere else, ever again. */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("business.provision");
  if (error) return error;

  let body: { businessId?: string; locationId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const businessId = body.businessId?.trim();
  const locationId = body.locationId?.trim();
  if (!businessId || !locationId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  const business = await getBusiness(businessId);
  if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (business.ownershipKind === "platform_internal") {
    return NextResponse.json({ error: "internal_business_pairing_unsupported" }, { status: 409 });
  }

  // `issued_by` is an FK to `platform_users(id)` (migration 0048). A platform
  // admin is deliberately NOT a platform_user — the super-user realm is a
  // separate table and admins are members of nothing (migration 0020) — so
  // `session.padmin` (a platform_admins.id) can never satisfy that FK. Passing
  // null keeps the code itself valid (issued_by is nullable) and the attribution
  // is still recorded by the platform_audit_log entry below, which stores the
  // real admin id in `platform_admin_id`.
  const issued = await issuePairingCode(businessId, null, locationId);
  if ("error" in issued) {
    return NextResponse.json({ error: issued.error }, { status: 409 });
  }

  await platformAudit({
    adminId: session.padmin,
    businessId,
    action: "pairing.issue",
    entity: "install_pairing_code",
    entityId: issued.summary.id,
    // Deliberately no code, not even a prefix: the audit log is readable by
    // every admin, and the plaintext is a credential.
    payload: { expiresAt: issued.summary.expiresAt, locationId },
  });

  return NextResponse.json({ code: issued.code, summary: issued.summary });
});

export const DELETE = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("business.provision");
  if (error) return error;

  let body: { businessId?: string; codeId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const businessId = body.businessId?.trim();
  const codeId = body.codeId?.trim();
  if (!businessId || !codeId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  const business = await getBusiness(businessId);
  if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (business.ownershipKind === "platform_internal") {
    return NextResponse.json({ error: "internal_business_pairing_unsupported" }, { status: 409 });
  }

  const revoked = await revokePairingCode(businessId, codeId);
  if (!revoked) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await platformAudit({
    adminId: session.padmin,
    businessId,
    action: "pairing.revoke",
    entity: "install_pairing_code",
    entityId: codeId,
  });

  return NextResponse.json({ ok: true });
});
