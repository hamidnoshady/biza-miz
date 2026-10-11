import { NextRequest, NextResponse } from "next/server";
import { getPool, query } from "@/lib/db";
import { AccountsError, replaceChartOfAccounts } from "@/lib/accounts-service";
import { markStepDone } from "@/lib/settings";
import { requireManager } from "@/lib/setup-state";
import { coaTemplateForIndustry, validateAccounts, type TemplateAccount } from "@/lib/coa-template";
import { AccountTreeError } from "@/lib/account-hierarchy";
import { withTenantScope } from "@/lib/auth";
import { getBusinessIndustry } from "@/lib/industry-guard";

/** Chart of accounts. GET returns the industry-appropriate template + what already exists. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireManager();
  if (error) return error;

  const [industry, { rows: existing }] = await Promise.all([
    getBusinessIndustry(session.businessId),
    query(
      `SELECT a.id, a.code, a.name, a.type, p.code AS parent_code
         FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id
        WHERE a.business_id = $1 ORDER BY a.code`,
      [session.businessId],
    ),
  ]);
  const template = coaTemplateForIndustry(industry ?? "food_service");
  return NextResponse.json({ template, existing });
});

/**
 * Creates the chart of accounts from the (possibly customized) template.
 * Replaces an existing chart only while no journal line or draft line references it.
 */
/** The Persian message for each way a wizard chart can fail to place. */
const TREE_MESSAGES: Record<AccountTreeError["reason"], string> = {
  too_deep: "ساختار حساب‌ها از سطح «تفصیلی» عمیق‌تر است.",
  parent_cycle: "ساختار والد/فرزند حساب‌ها حلقه دارد.",
  parent_missing: "والد یکی از حساب‌ها در فهرست نیست.",
  duplicate_code: "کد یکی از حساب‌ها تکراری است.",
  type_mismatch: "نوع حساب فرزند باید با نوع والدش یکسان باشد.",
};

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;

  let body: { accounts?: TemplateAccount[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const accounts = (body.accounts ?? []).map((a) => ({
    code: String(a.code ?? "").trim(),
    name: String(a.name ?? "").trim(),
    type: a.type,
    parentCode: a.parentCode ? String(a.parentCode).trim() : undefined,
    isContra: Boolean(a.isContra),
  }));

  const errors = validateAccounts(accounts);
  if (errors.length > 0) {
    return NextResponse.json({ error: "invalid_accounts", messages: errors }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // The replacement places the list, takes the canonical chart lock, refuses
    // a chart that is in use and audits every row it removes or creates, all on
    // this transaction (see replaceChartOfAccounts).
    const created = await replaceChartOfAccounts(
      client,
      session.businessId,
      accounts.map((a) => ({ ...a, parentCode: a.parentCode ?? null })),
      session.sub,
    );
    // The step marker commits with the chart it describes (issue #808 §6), so
    // a failed progress write can no longer leave accounts that exist while
    // the wizard believes the step was never done.
    const progress = await markStepDone(session.businessId, "accounts", client);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, created, progress });
  } catch (err) {
    await client.query("ROLLBACK");
    // A typed refusal is an answer, not a failure: the same 400/409 the editor
    // gives for the same rule, with nothing written.
    if (err instanceof AccountTreeError) {
      return NextResponse.json({ error: "invalid_accounts", messages: [TREE_MESSAGES[err.reason]] }, { status: 400 });
    }
    if (err instanceof AccountsError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  } finally {
    client.release();
  }
});
