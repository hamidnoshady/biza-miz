/**
 * Issue #1592 — read-only stock-authority preview for the stocked historical
 * duplicate pairs (the 304 in زنی زیبا).
 *
 * It writes nothing. The underlying report and planner run on a `READ ONLY`
 * transaction; this script only prints the comparison and the exact approval
 * token an owner would sign. There is no `--apply` here on purpose: a
 * production stock decision needs separate approval and a separately reviewed
 * write path.
 *
 *   npx tsx scripts/preview-duplicate-stock-authority.ts --business <uuid>
 *   npx tsx scripts/preview-duplicate-stock-authority.ts --business <uuid> --sku zza05023
 *   npx tsx scripts/preview-duplicate-stock-authority.ts --business <uuid> --json > preview.json
 */
import "dotenv/config";
import { getPool } from "../src/lib/db";
import { previewStockAuthority } from "../src/lib/duplicate-items-stock-authority-service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : "";
}

const EVIDENCE_LABEL: Record<string, string> = {
  both_match_store: "both local rows equal the store",
  canonical_matches_store: "surviving row equals the store; orphan is stale",
  orphan_matches_store_canonical_differs: "store agrees with the ORPHAN, not the surviving row",
  neither_matches_store: "neither row equals the store",
  store_stock_missing: "store payload has no stock_quantity",
  store_stock_negative: "store reports negative stock",
  variant_family: "variable product (per-variation stock)",
  canonical_unusable: "surviving row is inactive/unmapped",
  orphan_has_no_stock: "orphan holds no stock",
};

async function main(): Promise<number> {
  const businessId = argValue("--business");
  if (!businessId || !UUID_RE.test(businessId)) {
    console.error(
      "usage: npx tsx scripts/preview-duplicate-stock-authority.ts --business <uuid> [--sku <sku>] [--location <uuid>] [--json]",
    );
    return 2;
  }
  const sku = argValue("--sku");
  if (sku === "") {
    console.error("--sku needs a value.");
    return 2;
  }
  const locationId = argValue("--location");
  if (locationId === "" || (locationId && !UUID_RE.test(locationId))) {
    console.error("--location needs a branch (location) uuid.");
    return 2;
  }

  const preview = await previewStockAuthority(businessId, { sku, locationId });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(preview, null, 2));
    return 0;
  }

  console.log(
    `${preview.totals.pairs} stocked duplicate pair(s): ` +
      `${preview.totals.safe} safe to archive with no physical stock movement, ` +
      `${preview.totals.needsReconciliation} need store/canonical reconciliation, ` +
      `${preview.totals.manual} need a person (variable family).\n`,
  );
  console.log(
    `Units as recorded: orphan ${preview.totals.orphanUnits}, surviving rows ${preview.totals.canonicalUnits}. ` +
      `Archiving only the safe set leaves the active catalogue at ${preview.totals.catalogueUnitsAfterSafeArchives} units for these SKUs ` +
      `(the store's quantity; the orphan rows are duplicate snapshots).\n`,
  );
  for (const fact of preview.facts) console.log(`- ${fact}`);
  console.log("");
  for (const item of preview.items) {
    console.log(
      `[${item.verdict}] SKU ${item.sku}  orphan ${item.itemId} qty ${item.orphanQuantity}  ` +
        `kept ${item.canonicalItemId} qty ${item.canonicalQuantity}  store ${item.storeQuantity ?? "—"}` +
        (item.storeSnapshotAt ? ` (${item.storeSnapshotAt})` : ""),
    );
    console.log(`    ${item.name}`);
    console.log(`    evidence: ${EVIDENCE_LABEL[item.evidence] ?? item.evidence}`);
    for (const note of item.proposal.notes) console.log(`      ${note}`);
    for (const reference of item.references) {
      console.log(`      reference kept: ${reference.table}.${reference.column} (${reference.count})`);
    }
  }
  console.log("");
  console.log(`approval token (safe rows only): ${preview.approvalToken}`);
  console.log(`preview hash (all rows):         ${preview.previewHash}`);
  console.log("");
  console.log("Preview only. No stock change was proposed for execution and nothing was written.");
  return 0;
}

main()
  .then(async (code) => {
    await getPool().end().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await getPool().end().catch(() => {});
    process.exit(1);
  });
