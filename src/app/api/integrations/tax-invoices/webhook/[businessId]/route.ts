import { NextRequest, NextResponse } from "next/server";
import { applyTaxCallback, readTaxCallbackBody } from "@/lib/tax-invoice-callback";
import { taxErrorResponse } from "@/lib/tax-invoice-http";

/** Session-less TSP ingress. Tenant-bound HMAC verification is the guard, never a browser cookie. */
export async function POST(request: NextRequest, context: { params: Promise<{ businessId: string }> }) {
  try {
    const { businessId } = await context.params;
    const raw = await readTaxCallbackBody(request);
    return NextResponse.json(await applyTaxCallback(businessId, raw, request.headers));
  } catch (error) { return taxErrorResponse(error); }
}
