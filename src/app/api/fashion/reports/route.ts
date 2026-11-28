import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { tradeGoodsReportsGet } from "@/lib/trade-goods-routes";

// Issue #1567 — the fashion trade's variant-sales analysis, through the
// shared trade-goods reports handler.
const readGuard = () => requirePermission(PERMISSIONS.reportsView);

export const GET = tradeGoodsReportsGet("fashion_apparel", readGuard);
