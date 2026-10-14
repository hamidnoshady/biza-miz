import { NextRequest, NextResponse } from "next/server";
import { authenticateIamSite } from "@/lib/iam/site-auth";
import {
  buildLoginCredentials,
  buildReplicatedPins,
  buildStaffPinMemberships,
  recordSpentRecoveryCodes,
} from "@/lib/iam/login-credentials-service";
import type { SpentRecoveryCode } from "@/lib/iam/login-credentials";

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

/** A recovery code spent on the site is spent here too — single use across both replicas. */
export async function POST(request: NextRequest) {
  const site = await authenticateIamSite(request);
  if (!site) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { spent?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  const spent = body.spent;
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
  await recordSpentRecoveryCodes(site.businessId, spent);
  return NextResponse.json({ ok: true });
}
