import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { linkDealToSalesDocument, prepareDealHandoff } from "@/lib/crm-deal-handoff";

/**
 * Won deal → Accounting, the explicit handoff.
 *
 * `GET` answers «آیا این معامله آمادهٔ تبدیل به فاکتور است، و اگر نه چرا؟» —
 * every blocker at once, so the user fixes one screen rather than discovering
 * them one round trip at a time.
 *
 * `POST` records that a document Accounting created belongs to this deal. It
 * **creates nothing**: no order, no invoice, no journal line — the CRM's own
 * boundary test pins that, and it is the reason a drag between two kanban
 * columns cannot move the income statement. The order id is verified against
 * this business before linking, because it arrives from a browser.
 *
 * Both halves are `crm.manage`: a deal's owner is the person who knows the sale
 * happened. Nothing financial is disclosed beyond the id the Accounting screen
 * already produced, and the link is idempotent.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmManage);
    if (error) return error;

    const { id } = await params;
    const handoff = await prepareDealHandoff(session.businessId, id);
    if (!handoff) return NextResponse.json({ error: "deal_not_found" }, { status: 404 });
    return NextResponse.json({ handoff });
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmManage);
    if (error) return error;

    let body: { orderId?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (!body.orderId) return NextResponse.json({ error: "order_required" }, { status: 400 });

    const { id } = await params;
    const result = await linkDealToSalesDocument(session.businessId, id, body.orderId, {
      name: session.fullName,
      userId: session.sub,
    });
    if (!result.ok) {
      const status = result.error === "already_linked" ? 409 : 404;
      return NextResponse.json({ error: result.error }, { status });
    }
    const handoff = await prepareDealHandoff(session.businessId, id);
    return NextResponse.json({ handoff });
  },
);
