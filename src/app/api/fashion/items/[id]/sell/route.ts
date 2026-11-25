import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { tradeGoodsItemSellPost } from "@/lib/trade-goods-routes";

// Issue #1567 — selling units of one fashion variant, through the shared
// trade-goods sell handler (`fashion_apparel.sale_revenue`/`sale_cogs` events
// over the canonical posting engine).
const writeGuard = () => requirePermission(PERMISSIONS.ordersCreate);

export const POST = tradeGoodsItemSellPost("fashion_apparel", writeGuard);
