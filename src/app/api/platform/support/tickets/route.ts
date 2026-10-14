import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  listAssignablePlatformAdmins,
  querySupportTickets,
  supportTicketStats,
} from "@/lib/platform-service";

/**
 * The super-admin support desk — every business's tickets, cross-tenant.
 *
 * Gated on `support.manage`, which every platform-admin role holds (the
 * `support` role's whole job is this desk). Reads are scoped through the
 * platform bypass exactly like bug reports. Results are server-paginated.
 */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("support.manage");
  if (error) return error;

  const sp = request.nextUrl.searchParams;
  const assignedToMe = sp.get("assignedToMe") === "true";
  const openOnly = sp.get("queue") === "open";
  const unassigned = sp.get("unassigned") === "true";

  const [list, stats, assignableAdmins] = await Promise.all([
    querySupportTickets({
      status: sp.get("status") ?? "",
      priority: sp.get("priority") ?? "",
      category: sp.get("category") ?? "",
      search: sp.get("q") ?? "",
      businessId: sp.get("businessId") ?? "",
      assignedToMe,
      adminId: assignedToMe ? session.padmin : "",
      openOnly,
      unassigned,
      page: Number(sp.get("page")) || 1,
      pageSize: Number(sp.get("pageSize")) || 40,
    }),
    supportTicketStats(),
    listAssignablePlatformAdmins(),
  ]);

  return NextResponse.json({
    tickets: list.tickets,
    stats,
    assignableAdmins,
    meta: { total: list.total, page: list.page, pageSize: list.pageSize },
  });
});
