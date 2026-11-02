/**
 * Archive the losing twins of the WooCommerce creation race (dashboard audit
 * F13) in one business's `items`. A DRY RUN unless `--apply` is given.
 *
 * Run `scripts/report-duplicate-items.ts` first: it explains every duplicate
 * SKU. This script acts only on groups it classifies `race_orphan` — an
 * unmapped row created within ten minutes of a WooCommerce-mapped row of the
 * same kind and branch — and only archives (`is_active = false`, reversible,
 * audited) an orphan that nothing references. A row with sales, stock
 * movements, batches, barcodes, children or any other referencing record is
 * listed as blocked with the tables that hold it, and is left for a person.
 * Nothing is merged, moved or deleted.
 *
 *   npx tsx scripts/resolve-duplicate-items.ts --business <uuid>                  # plan only
 *   npx tsx scripts/resolve-duplicate-items.ts --business <uuid> --sku zza05023   # one SKU
 *   npx tsx scripts/resolve-duplicate-items.ts --business <uuid> --location <uuid> # one branch
 *   npx tsx scripts/resolve-duplicate-items.ts --business <uuid> --apply          # do it
 *   npx tsx scripts/resolve-duplicate-items.ts --business <uuid> --json           # machine-readable plan
 */
import "dotenv/config";
import { getPool } from "../src/lib/db";
import { archiveDuplicateOrphans, planDuplicateOrphanArchives } from "../src/lib/duplicate-items-resolve-service";
import { ORPHAN_BLOCKER_LABEL, type OrphanPlan } from "../src/lib/duplicate-items-resolution";
import { formatJalali } from "../src/lib/jalali";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : "";
}

/** Dates a person reads are Shamsi; the --json output keeps ISO for machines. */
function shamsi(iso: string): string {
  return formatJalali(iso, { withTime: true, timeZone: "Asia/Tehran" });
}

function describe(plan: OrphanPlan): void {
  console.log(
    `  SKU ${plan.sku}  orphan ${plan.orphanItemId}  qty ${plan.orphanQuantity ?? "—"}  created ${shamsi(plan.orphanCreatedAt)}`,
  );
  console.log(`    name: ${plan.orphanName}`);
  console.log(`    kept twin: ${plan.twinItemId ?? "—"}  qty ${plan.twinQuantity ?? "—"}`);
  for (const blocker of plan.blockers) console.log(`    blocked: ${ORPHAN_BLOCKER_LABEL[blocker]}`);
  for (const ref of plan.references) console.log(`      ${ref.table}.${ref.column}: ${ref.count} row(s)`);
}

async function main(): Promise<number> {
  const businessId = argValue("--business");
  if (!businessId || !UUID_RE.test(businessId)) {
    console.error(
      "usage: npx tsx scripts/resolve-duplicate-items.ts --business <uuid> [--sku <sku>] [--location <uuid>] [--apply] [--json]",
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
  const apply = process.argv.includes("--apply");
  const asJson = process.argv.includes("--json");
  if (apply && asJson) {
    console.error("--json prints the plan only; run it without --apply to review, then without --json to apply.");
    return 2;
  }

  const plans = await planDuplicateOrphanArchives(businessId, { sku, locationId });

  if (asJson) {
    console.log(JSON.stringify(plans, null, 2));
    return 0;
  }

  const toArchive = plans.filter((p) => p.status === "archive");
  const done = plans.filter((p) => p.status === "already_archived");
  const blocked = plans.filter((p) => p.status === "blocked");
  console.log(
    `${plans.length} creation-race orphan(s): ${toArchive.length} can be archived, ${done.length} already archived, ${blocked.length} blocked.\n`,
  );
  if (toArchive.length > 0) {
    console.log(apply ? "Archiving:" : "Would archive (dry run — pass --apply to do it):");
    toArchive.forEach(describe);
    console.log("");
  }
  if (blocked.length > 0) {
    console.log("Blocked — a person decides these:");
    blocked.forEach(describe);
    console.log("");
  }

  if (apply && toArchive.length > 0) {
    const result = await archiveDuplicateOrphans(businessId, plans);
    console.log(`Archived ${result.archived.length} orphan(s).`);
    for (const { plan, blockers } of result.changedSincePlan) {
      console.log(
        `  left alone: ${plan.orphanItemId} changed since the plan (${blockers.map((b) => ORPHAN_BLOCKER_LABEL[b]).join("; ")})`,
      );
    }
    return result.changedSincePlan.length > 0 ? 1 : 0;
  }
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
