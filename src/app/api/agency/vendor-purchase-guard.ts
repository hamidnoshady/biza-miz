import { NextResponse } from "next/server";
import { VendorPurchaseError, VENDOR_PURCHASE_ERROR_STATUS } from "@/lib/agency-vendor-purchase";
import { costErrorResponse } from "./reimbursable-cost-guard";

export function vendorPurchaseErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof VendorPurchaseError) return NextResponse.json({ error: err.code }, { status: VENDOR_PURCHASE_ERROR_STATUS[err.code] });
  return costErrorResponse(err);
}
