import { NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { requireManager } from "@/lib/setup-state";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { markStepDone } from "@/lib/settings";
import { AccountsError, replaceChartOfAccounts } from "@/lib/accounts-service";
import { AccountTreeError } from "@/lib/account-hierarchy";
import { coaTemplateForIndustry, validateAccounts } from "@/lib/coa-template";
import { accountingSetupEnabled } from "@/lib/setup-opening-service";
import { ACCOUNT_TREE_MESSAGES, REQUIRED_OPENING_CHART_CODES } from "@/lib/setup-chart";

/**
 * Explicit «ساخت سرفصل صنف» recovery for a genuinely missing chart
 * (issue #1583, workstream A4).
 *
 * This is not a second chart-provisioning authority: the Accounts step remains
 * the normal path, and this endpoint delegates to the same canonical pieces
 * (industry template → `validateAccounts` → `replaceChartOfAccounts` →
 * `markStepDone` in one transaction). What it adds is the two safety rules the
 * issue requires:
 *
 *  - it refuses outright when the business already has any account row, so a
 *    customized chart can never be replaced by pressing recover;
 *  - it verifies the codes the opening step and financial accounts depend on
 *    actually landed before reporting success.
 */
export const POST = withTenantScope(async () => {
  const { session, error } = await requireManager();
  if (error) return error;

  if (!(await accountingSetupEnabled(session.businessId))) {
    return NextResponse.json(
      { error: "accounting_not_enabled", state: "accounting_not_enabled" },
      { status: 409 },
    );
  }

  const access = await memberAccessFor(session);
  if (!access?.permissions.has(PERMISSIONS.accountsEdit)) {
    return NextResponse.json({ error: "permission_denied" }, { status: 403 });
  }

  const industry = (await getBusinessIndustry(session.businessId)) ?? "food_service";
  const template = coaTemplateForIndustry(industry);
  const accounts = template.map((account) => ({
    code: String(account.code).trim(),
    name: String(account.name).trim(),
    type: account.type,
    parentCode: account.parentCode ? String(account.parentCode).trim() : undefined,
    isContra: Boolean(account.isContra),
  }));
  const errors = validateAccounts(accounts);
  if (errors.length > 0) {
    return NextResponse.json({ error: "invalid_accounts", messages: errors }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    // Idempotence first: if the recovery already succeeded, a retry is a no-op
    // success — the chart exists and has a postable leaf. This is also the
    // "never overwrite" rule: nothing is written when the owner has a usable
    // chart, customized or not.
    const { rows: usable } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounts a
        WHERE a.business_id = $1 AND a.is_active
          AND NOT EXISTS (SELECT 1 FROM accounts k WHERE k.parent_id = a.id)`,
      [session.businessId],
    );
    if (Number(usable[0]?.n ?? 0) > 0) {
      return NextResponse.json({ ok: true, created: 0, alreadyPresent: true, industry });
    }

    await client.query("BEGIN");
    // Any row at all (archived, parent-only, customized) means the chart exists
    // and is the owner's, not ours to replace.
    const { rows: existing } = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM accounts WHERE business_id = $1",
      [session.businessId],
    );
    if (Number(existing[0]?.n ?? 0) > 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "chart_exists" }, { status: 409 });
    }

    const created = await replaceChartOfAccounts(
      client,
      session.businessId,
      accounts.map((account) => ({ ...account, parentCode: account.parentCode ?? null })),
      session.sub,
    );

    const { rows: placed } = await client.query<{ code: string }>(
      "SELECT code FROM accounts WHERE business_id = $1 AND code = ANY($2::text[])",
      [session.businessId, accounts.map((account) => account.code)],
    );
    const placedCodes = new Set(placed.map((row) => row.code));
    // Verify the codes the step actually depends on *that this industry's
    // template contains*: retail trades keep stock in `items`, not the 1300 GL
    // control, so requiring 1300 there would reject a correct chart.
    const required = REQUIRED_OPENING_CHART_CODES.filter((code) =>
      accounts.some((account) => account.code === code),
    );
    const missing = required.filter((code) => !placedCodes.has(code));
    if (missing.length > 0 || placedCodes.size !== accounts.length) {
      throw new Error(`chart_incomplete:${missing.join(",") || "count"}`);
    }

    // The step marker is derived from the chart it describes and commits with
    // it, exactly as the normal Accounts step does.
    const progress = await markStepDone(session.businessId, "accounts", client);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, created, industry, progress });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err instanceof AccountTreeError) {
      return NextResponse.json(
        { error: "invalid_accounts", messages: [ACCOUNT_TREE_MESSAGES[err.reason]] },
        { status: 400 },
      );
    }
    if (err instanceof AccountsError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  } finally {
    client.release();
  }
});
