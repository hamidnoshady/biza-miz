/**
 * Issue invoices for verified plan / add-on purchases that never got one.
 *
 * Before this fix a purchase paid through the gateway (or approved by hand)
 * produced a `billing_payments` row and a changed plan but no `billing_invoices`
 * row, so the business had nothing to download and the platform company's books
 * never saw the revenue. New purchases are invoiced at fulfilment; this repairs
 * the ones that already happened.
 *
 * Read-only by default. `--apply` writes, and it is a deliberate step: the
 * platform company's postings key on the invoice and are dated when it is
 * created, so back-filling an old payment books its revenue today, not on the
 * day it was paid. Decide with the accountant before running it on history.
 *
 *   npx tsx scripts/backfill-purchase-invoices.ts                      # dry run, every payment
 *   npx tsx scripts/backfill-purchase-invoices.ts --since-days 30      # dry run, last 30 days
 *   npx tsx scripts/backfill-purchase-invoices.ts --since-days 30 --apply
 *
 * Idempotent: a payment that already has an invoice is skipped, and re-running
 * after a partial failure finishes exactly the step that did not complete.
 */
import "dotenv/config";
import { backfillPurchaseInvoices } from "../src/lib/purchase-invoice-service";
import { closeDatabasePool } from "../src/lib/db";

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const sinceRaw = argValue("--since-days");
  const sinceDays = sinceRaw == null ? null : Number(sinceRaw);
  if (sinceDays != null && (!Number.isInteger(sinceDays) || sinceDays <= 0)) {
    throw new Error("--since-days must be a positive integer");
  }
  const result = await backfillPurchaseInvoices({ sinceDays, dryRun: !apply, limit: 1000 });
  for (const c of result.candidates) {
    console.log(
      `${apply ? "issue" : "would issue"}  payment=${c.paymentId}  business=${c.businessId}  ${c.purpose}  ${c.amountRial} IRR  verified=${c.verifiedAt ?? "-"}`,
    );
  }
  console.log(
    apply
      ? `issued ${result.issued} of ${result.candidates.length} (failed ${result.failed})`
      : `${result.candidates.length} payment(s) would get an invoice. Re-run with --apply to write.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabasePool());
