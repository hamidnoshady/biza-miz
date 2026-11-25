import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { tradeGoodsItemStockPost } from "@/lib/trade-goods-routes";

// Issue #1567 — receiving/adjusting stock for one fashion variant, through
// the canonical trade-goods stock handler (weighted-average cost, posting
// rules and tenant scope included).
const writeGuard = () => requirePermission(PERMISSIONS.inventoryAdjust);

export const POST = tradeGoodsItemStockPost("fashion_apparel", writeGuard);
