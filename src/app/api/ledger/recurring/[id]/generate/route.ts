import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  generateForTemplate,
  RecurringVoucherError,
  recurringAsOfDefault,
} from "@/lib/recurring-voucher-service";
import { isValidIsoDate } from "@/lib/jalali";

/**
 * «تولید اکنون» — claim and draft everything this template owes up to `asOf`.
 *
 * This is the same function the background tick calls, exposed so a manager can
 * resolve a catch-up immediately instead of waiting for the next pass. It still
 * creates drafts only; there is no path from here to a posted entry.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.ledgerPropose);
    if (error) return error;
    const { id } = await context.params;

    let asOfDate: string | undefined;
    try {
      const body = await request.json();
      if (body && typeof body.asOfDate === "string" && body.asOfDate) {
        if (!isValidIsoDate(body.asOfDate)) {
          return NextResponse.json({ error: "invalid_as_of_date" }, { status: 400 });
        }
        asOfDate = body.asOfDate;
      }
    } catch {
      /* An empty body means "the business's today", the documented default. */
    }

    try {
      const result = await generateForTemplate({
        businessId: session.businessId,
        templateId: id,
        asOfDate: asOfDate ?? (await recurringAsOfDefault(session.businessId)),
      });
      return NextResponse.json(result);
    } catch (err) {
      if (err instanceof RecurringVoucherError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  },
);
