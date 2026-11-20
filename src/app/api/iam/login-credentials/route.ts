import { NextRequest, NextResponse } from "next/server";
import { authenticateIamSite } from "@/lib/iam/site-auth";
import {
  applySitePins,
  buildLoginCredentials,
  buildReplicatedPins,
  buildStaffPinMemberships,
  recordSpentRecoveryCodes,
} from "@/lib/iam/login-credentials-service";
import {
  validateReplicatedPins,
  type SpentRecoveryCode,
} from "@/lib/iam/login-credentials";

/**
 * Global login: the password + second factor a paired site replicates, plus
 * every member's quick-login PIN hash (src/lib/iam/login-credentials.ts).
 *
 * `staffPins` (issue #850) is what makes a *deletion* travel: `pins` only ever
 * lists members the cloud has a PIN for, so without the companion roster a site
 * cannot tell "the cloud removed this staff member's PIN" from "this member is
 * not the cloud's to speak for". The block is authoritative and complete by
 * construction — it is only ever sent whole — and lists just the PIN roles,
 * whose PINs the cloud owns.
 *
 * The `POST` is the other direction of the same channel: a paired site pushes
 * the PINs *it* wrote (the owner's first-run PIN, a rotation at the till) and
 * the cloud adopts the ones newer than its own before the site pulls. Without
 * this half, a PIN changed locally never reached the cloud and "the PIN is
 * wrong" depended on which replica asked.
 */
export async function GET(request: NextRequest) {
  const site = await authenticateIamSite(request);
  if (!site) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [credentials, pins, staffPinMemberships] = await Promise.all([
    buildLoginCredentials(site.businessId),
    buildReplicatedPins(site.businessId),
    buildStaffPinMemberships(site.businessId),
  ]);
  const response = NextResponse.json({
    credentials,
    pins,
    staffPins: { authoritative: true, memberships: staffPinMemberships },
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A recovery code spent on the site is spent here too — single use across both
 * replicas — and a PIN the site wrote is adopted here when it is the newer
 * write (see `applySitePins`).
 */
export async function POST(request: NextRequest) {
  const site = await authenticateIamSite(request);
  if (!site) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { spent?: unknown; pins?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  const spent = body.spent ?? [];
  if (
    !Array.isArray(spent) || spent.length > 500 ||
    !spent.every((c): c is SpentRecoveryCode =>
      !!c && typeof c === "object" &&
      typeof c.membershipId === "string" && UUID.test(c.membershipId) &&
      typeof c.codeHash === "string" && c.codeHash.length > 0 && c.codeHash.length <= 200 &&
      typeof c.usedAt === "string" && !Number.isNaN(Date.parse(c.usedAt)))
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  // An older site sends only `spent`; a site that predates the push is not an
  // error, it simply has nothing to merge.
  const pinPayload = validateReplicatedPins(body.pins ?? []);
  if (!pinPayload.ok) {
    return NextResponse.json({ error: "bad_request", detail: pinPayload.code }, { status: 400 });
  }
  const { applied } = await applySitePins(site.businessId, pinPayload.pins);
  await recordSpentRecoveryCodes(site.businessId, spent);
  return NextResponse.json({ ok: true, pinsApplied: applied });
}
