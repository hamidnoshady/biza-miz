import { NextRequest, NextResponse } from "next/server";
import {
  OwnerActivationError,
  acceptOwnerActivation,
  previewOwnerActivation,
  requestActivationCode,
} from "@/lib/owner-activation";

function errorResponse(err: unknown): NextResponse {
  if (err instanceof OwnerActivationError) {
    return NextResponse.json({ error: err.code }, { status: err.status });
  }
  throw err;
}

/**
 * What an activation link is offering, before it is redeemed.
 *
 * Public and session-less by necessity: the person following the link has no
 * account (or, for a brand-new identity, no *usable* password) and no
 * membership yet. The token is the credential, and it is exchanged only for the
 * business name, the address it applies to and a masked hint of the mobile the
 * second factor will go to — never for anything about the business's data
 * (issue #755 §14).
 */
export async function GET(request: NextRequest) {
  // `new URL(request.url)` rather than `request.nextUrl`: the same handler has
  // to be drivable from an integration test with a plain Request, and the
  // Next-only helper would make the security-critical half of this route
  // untestable without a running server.
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return NextResponse.json({ error: "missing_token" }, { status: 400 });

  try {
    return NextResponse.json(await previewOwnerActivation(token));
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * The two halves of the owner's side of activation, on one public endpoint.
 *
 * `{action: "send_code", token}` texts a six-digit code to the owner's own
 * mobile. `{token, password, code}` redeems the link.
 *
 * The code is not optional. The activation link travels through the platform
 * operator — there is no mail transport in this system — so a link that sufficed
 * on its own would let whoever provisioned the business set themselves a
 * password, take the recovery codes and keep permanent access to a tenant they
 * are supposed to be administering. The code goes to a channel the operator can
 * make ring and cannot read, so redemption needs both halves, held by two
 * different people (issue #755 §14, and the Codex review finding that closed
 * this gap).
 *
 * Nothing here mints anything for the operator: the password is the owner's own
 * choice, and the second factor and recovery codes are created on this request
 * and returned only to this browser.
 */
export async function POST(request: NextRequest) {
  let body: { token?: string; password?: string; code?: string; action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.token) return NextResponse.json({ error: "missing_token" }, { status: 400 });

  try {
    if (body.action === "send_code") {
      return NextResponse.json(await requestActivationCode(body.token));
    }

    if (!body.password) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    if (!body.code) return NextResponse.json({ error: "activation_code_required" }, { status: 400 });

    return NextResponse.json(
      await acceptOwnerActivation(body.token, body.password, body.code),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
