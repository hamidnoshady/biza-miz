/**
 * Read-only report of duplicate SKUs in one business's `items` — dashboard
 * audit F13 («دو ردیف یکسان برای یک SKU»).
 *
 * For each SKU that more than one item row carries, it prints every row's id,
 * name, kind (simple / variant parent / variant child), parent, active flag,
 * branch and on-hand quantity; each integration mapping pointing at it
 * (connection, provider, remote id, remote parent id); the newest product
 * payload the store sent for that remote id (the source snapshot); and a
 * verdict — a variant family is legitimate, an unmapped twin created moments
 * after a mapped one is the creation race fixed with this script, and so on
 * (see src/lib/duplicate-items.ts).
 *
 * It writes nothing. The work runs inside withTenant (RLS confines it to the
 * named business) on a READ ONLY transaction that is rolled back. Decide on any
 * merge from its output; this script never merges, archives or deletes.
 *
 *   npx tsx scripts/report-duplicate-items.ts --business <uuid>
 *   npx tsx scripts/report-duplicate-items.ts --business <uuid> --sku zza05023
 *   npx tsx scripts/report-duplicate-items.ts --business <uuid> --json > dups.json
 */
import "dotenv/config";
import { getPool } from "../src/lib/db";
import { findDuplicateItemGroups } from "../src/lib/duplicate-items-report";
import { DUPLICATE_VERDICT_LABEL, verdictNeedsAction } from "../src/lib/duplicate-items";
import { formatJalali } from "../src/lib/jalali";

/** Dates a person reads are Shamsi; the --json output keeps ISO for machines. */
function shamsi(iso: string): string {
  return formatJalali(iso, { withTime: true, timeZone: "Asia/Tehran" });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : "";
}

async function main(): Promise<number> {
  const businessId = argValue("--business");
  if (!businessId || !UUID_RE.test(businessId)) {
    console.error("usage: npx tsx scripts/report-duplicate-items.ts --business <uuid> [--sku <sku>] [--json]");
    return 2;
  }
  const sku = argValue("--sku");
  if (sku === "") {
    console.error("--sku needs a value.");
    return 2;
  }
  const asJson = process.argv.includes("--json");

  const groups = await findDuplicateItemGroups(businessId, { sku });

  if (asJson) {
    console.log(
      JSON.stringify(
        groups.map((g) => ({ ...g, verdictLabel: DUPLICATE_VERDICT_LABEL[g.verdict], needsAction: verdictNeedsAction(g.verdict) })),
        null,
        2,
      ),
    );
    return 0;
  }

  if (groups.length === 0) {
    console.log(sku ? `No duplicate rows for SKU "${sku}".` : "No SKU is carried by more than one item.");
    return 0;
  }

  const actionable = groups.filter((g) => verdictNeedsAction(g.verdict)).length;
  console.log(`${groups.length} duplicate SKU group(s); ${actionable} need a person's decision.\n`);
  for (const group of groups) {
    const flag = verdictNeedsAction(group.verdict) ? "!" : " ";
    console.log(`${flag} SKU ${group.sku} — ${DUPLICATE_VERDICT_LABEL[group.verdict]}`);
    for (const m of group.members) {
      console.log(
        `    item ${m.itemId}  ${m.kind}${m.parentItemId ? ` (parent ${m.parentItemId})` : ""}` +
          `${m.isActive ? "" : "  [inactive]"}  branch «${m.locationName}»  qty ${m.quantity ?? "—"}  created ${shamsi(m.createdAt)}`,
      );
      console.log(`      name: ${m.name}`);
      console.log(`      source: ${m.provenance}`);
      for (const s of m.snapshots) {
        console.log(
          `      last store payload: ${s.topic} at ${shamsi(s.receivedAt)} (${s.status}) sku=${s.sku ?? "—"} stock=${s.stockQuantity ?? "—"}`,
        );
      }
    }
    console.log("");
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
