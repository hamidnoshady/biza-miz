import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * Issue #795 Phase 1 (items 6 & 7) — retired.
 *
 * This legacy quick-sell mutation created revenue, COGS, a sold status and a
 * warranty window outside the canonical retail invoice lifecycle (no invoice
 * record/number, no customer, no promotions/loyalty/commission, no printable
 * invoice, no invoice history), and it only required `orders.create` even
 * though it settled money — weaker than the shared POS's
 * `POS_REQUIRED_PERMISSIONS` (orders.create + payments.take).
 *
 * There is exactly one canonical path to sell a watch now: a retail invoice
 * with a `watch` line (src/lib/retail-invoice-service.ts), which the watch
 * workspace UI already uses. This handler is kept only so an old client gets
 * a clear 410 instead of a confusing 404/405.
 */
export const POST = withTenantScope(async () => {
  // Still authenticated: an anonymous caller gets the usual 401/403, not a
  // route-shape oracle. Only a signed-in member sees the 410 redirect hint.
  const { error } = await requirePermission(PERMISSIONS.ordersCreate);
  if (error) return error;
  return NextResponse.json(
    {
      error: "gone",
      message:
        "فروش مستقیم دستگاه حذف شده است؛ فروش ساعت فقط از مسیر فاکتور فروش (صفحهٔ فروش) انجام می‌شود.",
    },
    { status: 410 },
  );
});
