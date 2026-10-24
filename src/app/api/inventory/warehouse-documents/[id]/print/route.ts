import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { authorize, denialResponse } from "@/lib/authorize";
import {
  loadPrintableWarehouseDocument,
  renderWarehouseDocumentHtml,
} from "@/lib/warehouse-document-print";

type Context = { params: Promise<{ id: string }> };

/**
 * The printable sheet for one warehouse voucher (#923 — "printable" is part of
 * the definition of done).
 *
 * Server-side, in this order: permission, document, **branch authorization**,
 * then rendering. The branch check happens before a single byte of the
 * document is read into the template, so a restricted member cannot print
 * another branch's voucher by guessing an id — the same order the detail route
 * uses, and the reason this is a route rather than a client-side render of the
 * detail response.
 *
 * The output is the platform's own A4 template (`renderPrintTemplate`), served
 * as `text/html`. The browser prints it or saves it as PDF; `?download=1` asks
 * for an attachment disposition so "Save as PDF" gets a sensible filename.
 */
export const GET = withTenantScope(async (request: NextRequest, context: Context) => {
  const guard = await requirePermission(PERMISSIONS.inventoryView);
  if (guard.error) return guard.error;
  const session = guard.session;

  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const document = await loadPrintableWarehouseDocument({
    businessId: session.businessId,
    documentId: id,
    family: "fnb",
  });
  if (!document) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Authorize the document's actual branch before rendering anything of it.
  const decision = await authorize(session, { locationId: document.locationId });
  if (!decision.ok) return denialResponse(decision);

  const html = await renderWarehouseDocumentHtml({ businessId: session.businessId, document });
  const download = new URL(request.url).searchParams.get("download") === "1";
  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...(download
        ? { "Content-Disposition": `attachment; filename="${document.voucherNumber ?? id}.html"` }
        : {}),
    },
  });
});
