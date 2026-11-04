import { NextRequest, NextResponse } from "next/server";
import { bodyTooLarge, handleTorobProductRequest } from "@/lib/torob/product-api";

/**
 * Torob's **Product API v3** endpoint for one shop (issue #894).
 *
 * Public and session-less by design: the caller is Torob's fetcher, not a browser,
 * and its credential is the signed JWT in `X-Torob-Token` — verified against the
 * shop's own stored domain inside `handleTorobProductRequest`. `/api/v1` is already
 * the platform's public integration surface, so no middleware change is needed and
 * the request reaches the same per-key rate-limit bucket as every other machine
 * client.
 *
 * The shop is named by an opaque uuid in the path, never by a `Host` header: a
 * caller cannot become another shop by sending a different host, which is the
 * audience check's whole purpose.
 */
export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ shopId: string }> },
) {
  const { shopId } = await context.params;

  // Refuse an oversized body before it is read: `page_urls` is capped at 100
  // entries by the contract, so anything this large is not Torob.
  if (bodyTooLarge(request.headers.get("content-length"))) {
    return NextResponse.json({ error: "request body too large" }, { status: 413 });
  }

  const rawBody = await request.text();
  const result = await handleTorobProductRequest({ shopId, headers: request.headers, rawBody });
  return NextResponse.json(result.body, { status: result.status });
}

/** The contract defines POST only; anything else is a 405, not a 400. */
export function GET() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}

export const HEAD = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
