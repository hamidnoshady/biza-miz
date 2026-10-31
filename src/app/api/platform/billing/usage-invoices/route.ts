import { NextResponse } from "next/server";
import {
  platformAudit,
  requirePlatformAdmin,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import {
  currentUsagePeriodMonth,
  issueUsageInvoice,
  previewUsageInvoice,
  UsageInvoicePeriodError,
} from "@/lib/billing/usage-invoice-service";

/**
 * Issue #902 §9 item 3 — usage invoices, as an operator action.
 *
 * `GET`  ?businessId=…&month=YYYY-MM — what a month's usage would be billed as,
 *        line by line, with the price version behind each line. Writes nothing.
 * `POST` { businessId, month }      — issue (or finish) that invoice.
 *
 * Both are explicit rather than scheduled. Post-paid metered usage is a
 * commercial decision — today virtually every rateable event is wallet-backed and
 * therefore already paid — so issuing on a timer would change who owes money
 * without anyone deciding it should. The read half exists so the decision can be
 * made from real numbers, and the write half is capability-guarded and audited.
 */

function monthParam(value: string | null): string | undefined {
  if (!value) return undefined;
  return value;
}

export const GET = withPlatformScope(async (req: Request) => {
  const guard = await requirePlatformCapability("billing.view");
  if (guard.error) return guard.error;

  const url = new URL(req.url);
  const businessId = String(url.searchParams.get("businessId") ?? "").trim();
  if (!businessId) return NextResponse.json({ error: "missing_business" }, { status: 400 });
  try {
    const preview = await previewUsageInvoice({
      businessId,
      periodMonth: monthParam(url.searchParams.get("month")),
    });
    return NextResponse.json({ preview });
  } catch (error) {
    if (error instanceof UsageInvoicePeriodError) {
      return NextResponse.json({ error: "invalid_period_month" }, { status: 400 });
    }
    throw error;
  }
});

export const POST = withPlatformScope(async (req: Request) => {
  const guard = await requirePlatformCapability("billing.manage");
  if (guard.error) return guard.error;

  let body: { businessId?: string; month?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const businessId = String(body.businessId ?? "").trim();
  if (!businessId) return NextResponse.json({ error: "missing_business" }, { status: 400 });

  try {
    const result = await issueUsageInvoice({
      businessId,
      periodMonth: monthParam(body.month ?? null) ?? currentUsagePeriodMonth(),
    });
    if (result.invoiceId) {
      await platformAudit({
        adminId: guard.session.padmin,
        businessId,
        action: result.created ? "usage_invoice.issued" : "usage_invoice.replayed",
        entity: "billing_invoices",
        entityId: result.invoiceId,
        payload: { totalRial: result.totalRial, lineCount: result.lineCount },
      });
    }
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    if (error instanceof UsageInvoicePeriodError) {
      return NextResponse.json({ error: "invalid_period_month" }, { status: 400 });
    }
    throw error;
  }
});
