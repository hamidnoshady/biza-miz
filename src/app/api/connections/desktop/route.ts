import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requireRole } from "@/lib/auth";
import { deploymentRole } from "@/lib/deployment-role";
import {
  getDesktopLinkView,
  issueDesktopCode,
  revokeDesktopCode,
} from "@/lib/desktop-link-service";
import { revokeSiteDevice, rotateSiteCredential } from "@/lib/site-device-service";

/**
 * Owner self-service for connecting a desktop install to this business.
 *
 * The credential this issues is the same one the super-admin console issues
 * (`/api/platform/pairing`); what is new is that the person who actually needs
 * it can now mint it. Until this route existed the only generator inside a
 * business's own dashboard was the server-sync tab's «ساخت توکن», which mints
 * a different credential for a different channel — so owners pasted a `POS1-…`
 * sync token into the desktop's «کد اتصال» box and were told their code was
 * invalid. See src/lib/desktop-link-service.ts.
 *
 * Owner-only, and deliberately not `settings.manage`: redeeming a code hands
 * over a snapshot of the whole business including credential hashes, which is
 * an owner's decision the same way inviting a member is.
 *
 * It lives under /api/connections rather than /api/integrations so that no
 * feature flag gates it — `integrations` gates the WooCommerce channel, and a
 * business that never buys that must still be able to install the desktop app.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  return NextResponse.json({
    ...(await getDesktopLinkView(session.businessId, request.headers)),
    // A site install (a café laptop) is the thing that *redeems* a code; it
    // has no snapshot of its own to hand out, so the panel shows instructions
    // rather than a generator.
    role: deploymentRole(),
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  // Only a central server holds the business configuration a desktop install
  // pairs *to*. Issuing here on a site install would mint a code redeemable
  // against a database that is itself a copy. The UI doesn't offer it, but the
  // route is the boundary.
  if (deploymentRole() !== "central") {
    return NextResponse.json({ error: "not_central_server" }, { status: 409 });
  }

  let body: { locationId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const locationId = body.locationId?.trim();
  if (!locationId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const result = await issueDesktopCode(
    session.businessId,
    session.platformUserId ?? null,
    request.headers,
    locationId,
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });

  const response = NextResponse.json(
    { code: result.code, address: result.address, summary: result.summary },
    { status: 201 },
  );
  // The plaintext code exists only in this response.
  response.headers.set("Cache-Control", "no-store");
  return response;
});

export const PATCH = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;
  if (deploymentRole() !== "central") {
    return NextResponse.json({ error: "not_central_server" }, { status: 409 });
  }

  let body: { deviceId?: string; action?: "rotate" | "revoke" };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const deviceId = body.deviceId?.trim();
  if (!deviceId || (body.action !== "rotate" && body.action !== "revoke")) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  if (body.action === "rotate") {
    const result = await rotateSiteCredential(session.businessId, deviceId, session.sub);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.error === "device_not_found" ? 404 : 409 },
      );
    }
    return NextResponse.json({ pending: true, graceEndsAt: result.graceEndsAt, device: result.device });
  }

  const result = await revokeSiteDevice(session.businessId, deviceId, session.sub);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });
  return NextResponse.json({ ok: true, alreadyRevoked: result.alreadyRevoked });
});

export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  let body: { codeId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.codeId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const revoked = await revokeDesktopCode(session.businessId, body.codeId);
  if (!revoked) return NextResponse.json({ error: "code_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
