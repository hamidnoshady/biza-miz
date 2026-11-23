import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { setFinancialRatioMapping } from "@/lib/financial-ratios-service";

/**
 * The one reviewed account mapping the ratio report needs: which expense
 * account is interest expense. The seeded charts have none, so guessing from a
 * code block or a name would be a fabricated classification; the business names
 * it here once and the report uses it.
 *
 * Writing a classification needs `reports.manage` (the capability that owns the
 * report's configuration). Reading is part of the report itself, so the GET
 * report carries the mapping and `reports.view` suffices to see it.
 */
export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsManage);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  // A malformed list must never be read as "clear the mapping": only an
  // explicit array of account codes may change what interest coverage uses.
  const codes = (body as { interestExpenseAccountCodes?: unknown }).interestExpenseAccountCodes;
  if (!Array.isArray(codes) || codes.some((code) => typeof code !== "string")) {
    return NextResponse.json(
      { error: "invalid_mapping", message: "فهرست حساب‌های هزینهٔ بهره معتبر نیست." },
      { status: 400 },
    );
  }

  try {
    const mapping = await setFinancialRatioMapping(session.businessId, body);
    return NextResponse.json({ mapping });
  } catch (cause) {
    if (cause instanceof Error && cause.message === "unknown_interest_account") {
      return NextResponse.json(
        {
          error: "unknown_interest_account",
          message: "حساب انتخاب‌شده در نقشهٔ حساب‌های این کسب‌وکار به‌عنوان حساب هزینه پیدا نشد.",
          codes: (cause as Error & { codes?: string[] }).codes ?? [],
        },
        { status: 400 },
      );
    }
    throw cause;
  }
});
