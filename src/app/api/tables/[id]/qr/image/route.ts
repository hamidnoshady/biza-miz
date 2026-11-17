/**
 * ESH-147 (#1305) — render the table's QR as a PNG or SVG for printing.
 *
 * This is the only place the raw token leaves the database, and it leaves as
 * pixels/vector — never as JSON. `?format=svg` is for print shops (vector,
 * scales without blurring); PNG is the default. `?download=1` sets an
 * attachment disposition so «دانلود» saves a file instead of navigating.
 */
import QRCode from "qrcode";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { tableQrPrintPayload, TableQrError } from "@/lib/table-qr-service";

type Params = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const GET = withTenantScope(async (request: NextRequest, context: Params) => {
  const { id } = await context.params;
  const { session, error } = await requirePermission(PERMISSIONS.tablesManage);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let payload: Awaited<ReturnType<typeof tableQrPrintPayload>>;
  try {
    payload = await tableQrPrintPayload({
      businessId: session.businessId,
      locationId: location.id,
      tableId: id,
    });
  } catch (err) {
    if (err instanceof TableQrError) {
      return NextResponse.json({ error: err.reason }, { status: err.status });
    }
    throw err;
  }
  if (!payload) {
    return NextResponse.json({ error: "table_qr_not_generated" }, { status: 404 });
  }
  if (!payload.link) {
    // Without an active CMS site there is no menu URL to open, and a QR that
    // resolves to nothing is worse than no QR at all. The panel hides the
    // download action in this state and explains why.
    return NextResponse.json({ error: "site_not_connected" }, { status: 409 });
  }

  const format = request.nextUrl.searchParams.get("format") === "svg" ? "svg" : "png";
  const download = request.nextUrl.searchParams.get("download") === "1";
  const filename = `table-qr-${payload.prefix}.${format}`;
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
  });

  if (format === "svg") {
    const svg = await QRCode.toString(payload.link.url, {
      type: "svg",
      margin: 2,
      errorCorrectionLevel: "M",
    });
    headers.set("Content-Type", "image/svg+xml; charset=utf-8");
    return new NextResponse(svg, { status: 200, headers });
  }

  const png = await QRCode.toBuffer(payload.link.url, {
    type: "png",
    width: 1024,
    margin: 2,
    errorCorrectionLevel: "M",
  });
  headers.set("Content-Type", "image/png");
  return new NextResponse(new Uint8Array(png), { status: 200, headers });
});
