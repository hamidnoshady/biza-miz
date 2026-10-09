import { NextRequest, NextResponse } from "next/server";
import { getPool, query } from "@/lib/db";
import { lockChartOfAccounts } from "@/lib/accounts-service";
import { markStepDone } from "@/lib/settings";
import { requireManager } from "@/lib/setup-state";
import {
  coaTemplateForIndustry,
  nextAccountLevel,
  validateAccounts,
  type AccountLevel,
  type TemplateAccount,
} from "@/lib/coa-template";
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
 * Replaces an existing chart only while no journal lines reference it.
 */
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
    // Same wholesale-replacement shape as the settings route, so the same
    // canonical chart-of-accounts lock applies (issue #824 review item 6).
    await lockChartOfAccounts(client, session.businessId);

    const { rows: used } = await client.query(
      `SELECT 1 FROM journal_lines jl
        JOIN accounts a ON a.id = jl.account_id
       WHERE a.business_id = $1 LIMIT 1`,
      [session.businessId],
    );
    if (used.length > 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "accounts_in_use" }, { status: 409 });
    }

    await client.query("DELETE FROM accounts WHERE business_id = $1", [session.businessId]);

    // Insert parents before children: roots first, then rows whose parent exists.
    const idByCode = new Map<string, string>();
    const levelByCode = new Map<string, AccountLevel>();
    const pending = [...accounts];
    while (pending.length > 0) {
      const ready = pending.filter((a) => !a.parentCode || idByCode.has(a.parentCode));
      if (ready.length === 0) {
        // validateAccounts guarantees parents exist, so a cycle is the only way here
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: "invalid_accounts", messages: ["ساختار والد/فرزند حساب‌ها حلقه دارد."] },
          { status: 400 },
        );
      }
      for (const a of ready) {
        const parentLevel = a.parentCode ? (levelByCode.get(a.parentCode) ?? null) : null;
        const level = nextAccountLevel(parentLevel);
        if (!level) {
          await client.query("ROLLBACK");
          return NextResponse.json(
            { error: "invalid_accounts", messages: ["ساختار حساب‌ها از سطح «تفصیلی» عمیق‌تر است."] },
            { status: 400 },
          );
        }
        const res = await client.query(
          `INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [session.businessId, a.parentCode ? idByCode.get(a.parentCode) : null, a.code, a.name, a.type, level, a.isContra],
        );
        idByCode.set(a.code, res.rows[0].id);
        levelByCode.set(a.code, level);
        pending.splice(pending.indexOf(a), 1);
      }
    }

    // The step marker commits with the chart it describes (issue #808 §6), so
    // a failed progress write can no longer leave accounts that exist while
    // the wizard believes the step was never done.
    const progress = await markStepDone(session.businessId, "accounts", client);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, created: accounts.length, progress });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});
