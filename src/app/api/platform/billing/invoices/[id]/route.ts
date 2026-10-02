import { NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  applyInvoicePayment,
  listInvoicePayments,
  voidBillingInvoice,
  SubscriptionError,
} from "@/lib/subscription-service";
import { parseSafeIntInput } from "@/lib/platform-money";

export const GET = withPlatformScope(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const { id } = await ctx.params;
  const payments = await listInvoicePayments(id);
  return NextResponse.json({ payments });
});

export const POST = withPlatformScope(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const guard = await requirePlatformCapability("billing.manage");
  if (guard.error) return guard.error;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as {
    action?: string;
    amountRial?: unknown;
    idempotencyKey?: string;
    paymentId?: string;
    note?: string;
  } | null;
  try {
    if (body?.action === "void") {
      return NextResponse.json({ invoice: await voidBillingInvoice(id) });
    }
    if (body?.action === "payment") {
      const amount = parseSafeIntInput(body.amountRial, { min: 1 });
      if (amount === null) {
        return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
      }
      const invoice = await applyInvoicePayment(id, amount, {
        idempotencyKey: body.idempotencyKey ?? null,
        paymentId: body.paymentId ?? null,
        note: body.note ?? null,
        platformAdminId: guard.session.padmin,
      });
      return NextResponse.json({ invoice });
    }
  } catch (err) {
    if (err instanceof SubscriptionError) {
      const status =
        err.code === "invoice_not_found" ? 404 : err.code === "bad_amount" ? 400 : 409;
      return NextResponse.json({ error: err.code }, { status });
    }
    throw err;
  }
  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});
