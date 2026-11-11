/**
 * ESH-147 (#1305) — public resolution of a scanned table QR.
 *
 * The customer's browser (or the CMS's server) arrives with no session: the
 * token in the path is the whole credential. It names one table and nothing
 * else — the response carries the table's display name, its branch name and
 * the CMS `siteId` the caller already knows, never a uuid.
 *
 * `?siteId=` is the CMS's own site id. When supplied it must match the
 * token's business connection, so a token photographed at one site cannot be
 * replayed against another tenant's checkout.
 *
 * Unauthenticated and cross-tenant by nature, so middleware rate-limits it per
 * IP (`TABLE_QR_IP_LIMIT`), and every refusal is one of a small, fixed set of
 * reasons. Unknown and malformed tokens answer the same 404, so the endpoint
 * cannot be used to enumerate prints.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveTableQrToken } from "@/lib/table-qr-service";
import { TABLE_QR_REJECTION_STATUS } from "@/lib/table-qr";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await context.params;
  const siteId = request.nextUrl.searchParams.get("siteId");

  const resolved = await resolveTableQrToken(token, { siteId });
  if (!resolved.ok) {
    return NextResponse.json(
      { error: resolved.reason, status: TABLE_QR_REJECTION_STATUS[resolved.reason] },
      { status: resolved.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(resolved, { headers: { "Cache-Control": "no-store" } });
}
