import { NextRequest, NextResponse } from "next/server";
import {
  OwnerActivationError,
  acceptOwnerActivation,
  previewOwnerActivation,
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
 * Redeems an activation link: the owner sets their own password, and their
 * second factor and recovery codes are minted here and returned once, to them.
 *
 * No platform operator is involved in this request, and none can be — the
 * console that created the business has no password field and receives none of
 * this material.
 */
export async function POST(request: NextRequest) {
  let body: { token?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.token) return NextResponse.json({ error: "missing_token" }, { status: 400 });
  if (!body.password) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  try {
    return NextResponse.json(await acceptOwnerActivation(body.token, body.password));
  } catch (err) {
    return errorResponse(err);
  }
}
