import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { tradeGoodsItemsGet, tradeGoodsItemsPost } from "@/lib/trade-goods-routes";

// Issue #1567 — the fashion trade's variant board (styles + size/colour
// children) over the shared trade-goods route handlers, exactly like the
// haberdashery/wholesale/tools namespaces beside it. The stricter
// `requireIndustryForApi("fashion_apparel")` check lives inside the handlers.
const readGuard = () => requirePermission(PERMISSIONS.inventoryView);
const writeGuard = () => requirePermission(PERMISSIONS.inventoryAdjust);

export const GET = tradeGoodsItemsGet("fashion_apparel", readGuard);
export const POST = tradeGoodsItemsPost("fashion_apparel", writeGuard);
