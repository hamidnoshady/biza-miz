/**
 * Universal safe import & first-sync reconciliation (issue #1118), against a
 * real database.
 *
 * The properties this suite exists to keep true, in the issue's own words:
 *
 *  1. A preview writes nothing canonical — staging touches only its own tables.
 *  2. Overlap is matched, linked and reviewed BEFORE mutation; a name or a
 *     non-unique SKU alone never links.
 *  3. Re-running converges: the same records, a retried batch or a reconnect
 *     produce no duplicates and keep the owner's decisions.
 *  4. A verified source identity is never silently re-pointed, and many sources
 *     may link to one canonical row.
 *  5. A stale preview cannot be applied, and an approval given under the old
 *     picture falls back to review.
 *  6. Progress is truthful: "reconciled" needs every item terminal and the
 *     post-apply cross-check.
 *  7. Decisions are append-only, a second active run on a scope is refused, and
 *     another business cannot see any of it.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let svc: typeof import("../src/lib/import-reconciliation/service");

const retail = { id: "", locationId: "", connectionId: "" };
const cafe = { id: "", locationId: "" };
const other = { id: "", locationId: "" };
const actor = { userId: null as string | null, name: "مدیر آزمون" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

async function seedBusiness(industry: string, label: string): Promise<{ id: string; locationId: string }> {
  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, $3) RETURNING id`,
    [label, `rc-${randomUUID().slice(0, 8)}`, industry],
  );
  const location = await db.query<{ id: string }>(`INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id`, [
    business.rows[0].id,
  ]);
  return { id: business.rows[0].id, locationId: location.rows[0].id };
}

async function addItem(locationId: string, name: string, sku: string | null, barcode?: string): Promise<string> {
  const row = await db.query<{ id: string }>(`INSERT INTO items (location_id, name, sku) VALUES ($1, $2, $3) RETURNING id`, [
    locationId,
    name,
    sku,
  ]);
  if (barcode) {
    await db.query(`INSERT INTO item_barcodes (location_id, item_id, code, symbology) VALUES ($1, $2, $3, 'EAN13')`, [
      locationId,
      row.rows[0].id,
      barcode,
    ]);
  }
  return row.rows[0].id;
}

const countItems = async (locationId: string) =>
  Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM items WHERE location_id = $1`, [locationId])).rows[0].n);

function asBusiness<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

function product(externalId: string, name: string, sku: string | null = null, extra: Record<string, unknown> = {}) {
  return { domain: "product" as const, externalId, name, sku, ...extra };
}

beforeAll(async () => {
  databaseName = `pos_reconcile_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  svc = await import("../src/lib/import-reconciliation/service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  Object.assign(retail, await seedBusiness("cosmetics", "فروشگاه آزمون"));
  Object.assign(cafe, await seedBusiness("food_service", "کافهٔ آزمون"));
  Object.assign(other, await seedBusiness("cosmetics", "کسب‌وکار دیگر"));
  const connection = await db.query<{ id: string }>(
    `INSERT INTO integration_connections (business_id, location_id, name, provider, base_url, currency_unit)
     VALUES ($1, $2, 'Holoo', 'holoo', NULL, 'rial') RETURNING id`,
    [retail.id, retail.locationId],
  );
  retail.connectionId = connection.rows[0].id;
}, 240_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.closeDatabasePool();
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("product reconciliation against a populated catalogue", () => {
  let runId = "";
  let canonicalA = "";
  let canonicalDup1 = "";
  let canonicalDup2 = "";
  let canonicalName = "";
  const sourceKey = "woo-main";

  it("opens a run and refuses a second active run on the same scope", async () => {
    canonicalA = await addItem(retail.locationId, "رژ لب", "LIP-1", "6260000000012");
    canonicalDup1 = await addItem(retail.locationId, "سایه الف", "DUP-9");
    canonicalDup2 = await addItem(retail.locationId, "سایه ب", "DUP-9");
    canonicalName = await addItem(retail.locationId, "ریمل", null);

    const run = await asBusiness(retail.id, () =>
      svc.openRun({
        businessId: retail.id,
        locationId: retail.locationId,
        domain: "product",
        sourceKind: "plugin",
        provider: "woocommerce",
        sourceKey,
        importMode: "live_link",
        sourceFingerprint: "v1",
        evidence: { site: "shop.example" },
        actor,
      }),
    );
    runId = run.id;
    expect(run.status).toBe("discovering");

    await expect(
      asBusiness(retail.id, () =>
        svc.openRun({
          businessId: retail.id,
          locationId: retail.locationId,
          domain: "product",
          sourceKind: "plugin",
          sourceKey,
          importMode: "live_link",
          sourceFingerprint: "v1",
          actor,
        }),
      ),
    ).rejects.toMatchObject({ code: "active_run_exists", details: { runId } });
  });

  it("stages the overlap without writing a single canonical row", async () => {
    const before = await countItems(retail.locationId);
    const records = [
      product("w1", "Lipstick", "lip-1"), // same SKU as canonicalA → safe match
      product("w2", "Brand new", "NEW-77"), // nothing overlaps → create
      product("w3", "Shadow", "DUP-9"), // non-unique in the books → ambiguous
      product("w4", "ریمل"), // name only → ambiguous, never linked
      product("w5", "Twin A", "TWIN-1"), // duplicated inside the source
      product("w6", "Twin B", "twin-1"),
      product("w7", "No identity", null, { name: null }),
    ];
    const result = await asBusiness(retail.id, () => svc.stageProducts(retail.id, runId, records));
    expect(result).toEqual({ staged: 7, unchanged: 0, changed: 0 });
    expect(await countItems(retail.locationId)).toBe(before);

    const items = await asBusiness(retail.id, () => svc.listItems(retail.id, runId));
    const byKey = Object.fromEntries(items.map((i) => [i.externalKey, i]));
    expect(byKey.w1).toMatchObject({ outcome: "safe_match", canonicalId: canonicalA, status: "proposed" });
    expect(byKey.w2).toMatchObject({ outcome: "create_new", canonicalId: null });
    expect(byKey.w3.outcome).toBe("ambiguous");
    expect(byKey.w3.candidates.map((c) => c.id).sort()).toEqual([canonicalDup1, canonicalDup2].sort());
    expect(byKey.w4).toMatchObject({ outcome: "ambiguous", canonicalId: null });
    expect(byKey.w4.reasons).toEqual(["name_only"]);
    expect(byKey.w4.candidates.map((c) => c.id)).toEqual([canonicalName]);
    expect(byKey.w5.reasons).toContain("duplicate_in_source");
    expect(byKey.w6.reasons).toContain("duplicate_in_source");
    expect(byKey.w7).toMatchObject({ outcome: "invalid", status: "held" });
  });

  it("converges when a batch is re-sent, and finds duplicates that arrive in a later batch", async () => {
    const resend = await asBusiness(retail.id, () =>
      svc.stageProducts(retail.id, runId, [product("w1", "Lipstick", "lip-1"), product("w2", "Brand new", "NEW-77")]),
    );
    expect(resend).toEqual({ staged: 0, unchanged: 2, changed: 0 });

    // A later batch repeats w2's SKU under another id: both are now ambiguous.
    await asBusiness(retail.id, () => svc.stageProducts(retail.id, runId, [product("w8", "Brand new again", "new-77")]));
    const items = await asBusiness(retail.id, () => svc.listItems(retail.id, runId));
    const byKey = Object.fromEntries(items.map((i) => [i.externalKey, i]));
    expect(byKey.w2.outcome).toBe("ambiguous");
    expect(byKey.w2.reasons).toContain("duplicate_in_source");
    expect(byKey.w8.outcome).toBe("ambiguous");
    // The safe match is untouched.
    expect(byKey.w1.outcome).toBe("safe_match");
  });

  it("gates a populated catalogue into review rather than the fast path", async () => {
    const discovery = await asBusiness(retail.id, () => svc.completeProductDiscovery(retail.id, runId, actor));
    expect(discovery.gate.path).toBe("staged");
    expect(discovery.run.status).toBe("staged");
    expect(discovery.counts.proposedLinks).toBe(1);
    expect(discovery.counts.conflicts).toBeGreaterThanOrEqual(4);
    // Nothing is approved without a person.
    expect(discovery.counts.approved).toBe(0);
  });

  it("refuses decisions the verdict does not allow, and a link to a candidate nobody offered", async () => {
    const items = await asBusiness(retail.id, () => svc.listItems(retail.id, runId));
    const w3 = items.find((i) => i.externalKey === "w3")!;
    const w7 = items.find((i) => i.externalKey === "w7")!;
    await expect(
      asBusiness(retail.id, () =>
        svc.decideItem({ businessId: retail.id, runId, itemId: w7.id, decision: "create_separate", reason: "x", actor }),
      ),
    ).rejects.toMatchObject({ code: "decision_not_allowed" });
    await expect(
      asBusiness(retail.id, () =>
        svc.decideItem({ businessId: retail.id, runId, itemId: w3.id, decision: "link", canonicalId: canonicalA, actor }),
      ),
    ).rejects.toMatchObject({ code: "candidate_not_offered" });
    await expect(
      asBusiness(retail.id, () =>
        svc.decideItem({ businessId: retail.id, runId, itemId: w3.id, decision: "create_separate", actor }),
      ),
    ).rejects.toMatchObject({ code: "reason_required" });
  });

  it("records owner decisions append-only, with who and why", async () => {
    const items = await asBusiness(retail.id, () => svc.listItems(retail.id, runId));
    const w3 = items.find((i) => i.externalKey === "w3")!;
    const w4 = items.find((i) => i.externalKey === "w4")!;
    const w5 = items.find((i) => i.externalKey === "w5")!;
    const w6 = items.find((i) => i.externalKey === "w6")!;
    const w2 = items.find((i) => i.externalKey === "w2")!;
    const w8 = items.find((i) => i.externalKey === "w8")!;

    // The owner confirms w3 is the first of the two same-SKU rows.
    const linked = await asBusiness(retail.id, () =>
      svc.decideItem({ businessId: retail.id, runId, itemId: w3.id, decision: "link", canonicalId: canonicalDup1, reason: "تأیید مالک", actor }),
    );
    expect(linked).toMatchObject({ status: "approved", effect: "link", canonicalId: canonicalDup1 });

    // w4 (name only) is a genuinely different product: create it separately, with a reason.
    await asBusiness(retail.id, () =>
      svc.decideItem({ businessId: retail.id, runId, itemId: w4.id, decision: "create_separate", reason: "محصول دیگری است", actor }),
    );
    // The duplicated source rows are skipped; the second of the new-SKU pair too.
    for (const item of [w5, w6, w8]) {
      await asBusiness(retail.id, () => svc.decideItem({ businessId: retail.id, runId, itemId: item.id, decision: "skip", actor }));
    }
    // w2 is held for later.
    const held = await asBusiness(retail.id, () =>
      svc.decideItem({ businessId: retail.id, runId, itemId: w2.id, decision: "keep_for_review", actor }),
    );
    expect(held.status).toBe("held");

    const decisions = await db.query(`SELECT decision, reason, decided_by_name FROM import_reconciliation_decisions WHERE item_id = $1`, [w3.id]);
    expect(decisions.rows).toEqual([{ decision: "link", reason: "تأیید مالک", decided_by_name: actor.name }]);
    await expect(db.query(`UPDATE import_reconciliation_decisions SET reason = 'edited' WHERE item_id = $1`, [w3.id])).rejects.toThrow(
      /append_only/,
    );
  });

  it("batch-approves only the safe classes", async () => {
    const result = await asBusiness(retail.id, () => svc.approveSafeBatch(retail.id, runId, actor));
    expect(result.approved).toBe(1); // only w1; w2 is held, ambiguous rows are untouched
    const items = await asBusiness(retail.id, () => svc.listItems(retail.id, runId, { status: "approved" }));
    expect(items.map((i) => i.externalKey).sort()).toEqual(["w1", "w3", "w4"]);
  });

  it("will not apply a preview whose canonical state moved, and sends approvals back to review", async () => {
    await addItem(retail.locationId, "کالای تازه", "FRESH-1"); // the books changed after the preview
    const current = await asBusiness(retail.id, async () => {
      const run = (await svc.getRunSummary(retail.id, runId)).run;
      return {
        sourceFingerprint: run.sourceFingerprint,
        policyVersion: run.policyVersion,
        canonicalToken: await dbLib.withTenantTransaction(retail.id, (client) => svc.productCanonicalToken(client, run)),
      };
    });
    const handler = svc.createProductApplyHandler();
    await expect(
      asBusiness(retail.id, () => svc.applyRun({ businessId: retail.id, runId, handler, current, actor })),
    ).rejects.toMatchObject({ code: "preview_stale" });

    const summary = await asBusiness(retail.id, () => svc.getRunSummary(retail.id, runId));
    expect(summary.run.status).toBe("stale");
    expect(summary.counts.approved).toBe(0);
    // Everything approved under the old picture is back to proposed — no write happened.
    expect(await db.query(`SELECT count(*)::int AS n FROM source_identities WHERE business_id = $1`, [retail.id])).toMatchObject({
      rows: [{ n: 0 }],
    });
  });

  it("re-stages a stale run against the new state, keeping the same run and its history", async () => {
    await asBusiness(retail.id, () => svc.reopenStaleRun(retail.id, runId, { sourceFingerprint: "v1" }, actor));
    // Re-send the records the owner had decided: identical fingerprints, so nothing is lost.
    const resend = await asBusiness(retail.id, () =>
      svc.stageProducts(retail.id, runId, [product("w1", "Lipstick", "lip-1"), product("w3", "Shadow", "DUP-9")]),
    );
    expect(resend.staged).toBe(0);
    await asBusiness(retail.id, () => svc.completeProductDiscovery(retail.id, runId, actor));
    const items = await asBusiness(retail.id, () => svc.listItems(retail.id, runId));
    // Approvals were reset to proposed by the stale transition; the decision trail survives.
    expect(items.find((i) => i.externalKey === "w3")!.status).toBe("proposed");
    const trail = await db.query(`SELECT count(*)::int AS n FROM import_reconciliation_decisions WHERE run_id = $1`, [runId]);
    expect(trail.rows[0].n).toBeGreaterThanOrEqual(7);
  });

  it("applies the reviewed decisions: links write identities, a missing create handler fails loudly, nothing else moves", async () => {
    // Re-decide after the stale round (decisions are cheap; the audit trail keeps both).
    const items = await asBusiness(retail.id, () => svc.listItems(retail.id, runId));
    const find = (k: string) => items.find((i) => i.externalKey === k)!;
    await asBusiness(retail.id, () =>
      svc.decideItem({ businessId: retail.id, runId, itemId: find("w3").id, decision: "link", canonicalId: canonicalDup1, actor }),
    );
    await asBusiness(retail.id, () =>
      svc.decideItem({ businessId: retail.id, runId, itemId: find("w4").id, decision: "create_separate", reason: "محصول دیگری است", actor }),
    );
    await asBusiness(retail.id, () => svc.approveSafeBatch(retail.id, runId, actor));

    const before = await countItems(retail.locationId);
    const run = (await asBusiness(retail.id, () => svc.getRunSummary(retail.id, runId))).run;
    const current = {
      sourceFingerprint: run.sourceFingerprint,
      policyVersion: run.policyVersion,
      canonicalToken: await asBusiness(retail.id, () =>
        dbLib.withTenantTransaction(retail.id, (client) => svc.productCanonicalToken(client, run)),
      ),
    };
    const result = await asBusiness(retail.id, () =>
      svc.applyRun({ businessId: retail.id, runId, handler: svc.createProductApplyHandler(), current, actor, batchSize: 1 }),
    );

    // Links applied; the create had no handler and says so rather than guessing.
    expect(await countItems(retail.locationId)).toBe(before);
    const applied = await asBusiness(retail.id, () => svc.listItems(retail.id, runId, { status: "applied" }));
    expect(applied.map((i) => i.externalKey).sort()).toEqual(["w1", "w3"]);
    const failed = await asBusiness(retail.id, () => svc.listItems(retail.id, runId, { status: "failed" }));
    expect(failed.map((i) => [i.externalKey, i.error])).toEqual([["w4", "create_not_supported"]]);

    // Never "fully synced" while anything is pending, held or failed.
    expect(result.run.status).toBe("partially_applied");
    expect(result.progress.fullyReconciled).toBe(false);

    const identities = await db.query(
      `SELECT external_id, canonical_id, canonical_type, verified FROM source_identities WHERE business_id = $1 ORDER BY external_id`,
      [retail.id],
    );
    expect(identities.rows).toEqual([
      { external_id: "w1", canonical_id: canonicalA, canonical_type: "items", verified: true },
      { external_id: "w3", canonical_id: canonicalDup1, canonical_type: "items", verified: true },
    ]);
  });

  it("never silently re-points a verified identity, in the service or in the database", async () => {
    await expect(
      dbLib.withTenantTransaction(retail.id, (client) =>
        svc.linkSourceIdentity(client, {
          businessId: retail.id,
          domain: "product",
          sourceKey,
          externalType: "product",
          externalId: "w1",
          canonicalType: "items",
          canonicalId: canonicalDup2,
        }),
      ),
    ).rejects.toMatchObject({ code: "identity_already_linked" });
    await expect(db.query(`UPDATE source_identities SET canonical_id = $2 WHERE external_id = 'w1' AND business_id = $1`, [retail.id, canonicalDup2])).rejects.toThrow(
      /repoint_requires_approval/,
    );
  });

  it("lets a second source link to the same canonical product", async () => {
    await dbLib.withTenantTransaction(retail.id, (client) =>
      svc.linkSourceIdentity(client, {
        businessId: retail.id,
        domain: "product",
        sourceKey: "holoo-main",
        externalType: "product",
        externalId: "H-100",
        canonicalType: "items",
        canonicalId: canonicalA,
      }),
    );
    const rows = await db.query(`SELECT source_key FROM source_identities WHERE canonical_id = $1 ORDER BY source_key`, [canonicalA]);
    expect(rows.rows.map((r) => r.source_key)).toEqual(["holoo-main", "woo-main"]);
  });

  it("recognises a linked product on the next run: re-importing converges without duplicates", async () => {
    await asBusiness(retail.id, () => svc.cancelRun(retail.id, runId, actor));
    const second = await asBusiness(retail.id, () =>
      svc.openRun({
        businessId: retail.id,
        locationId: retail.locationId,
        domain: "product",
        sourceKind: "plugin",
        sourceKey,
        importMode: "live_link",
        sourceFingerprint: "v2",
        actor,
      }),
    );
    const before = await countItems(retail.locationId);
    await asBusiness(retail.id, () =>
      svc.stageProducts(retail.id, second.id, [product("w1", "Lipstick renamed", "lip-1"), product("w3", "Shadow", "DUP-9")]),
    );
    const items = await asBusiness(retail.id, () => svc.listItems(retail.id, second.id));
    expect(items.map((i) => [i.externalKey, i.outcome])).toEqual([
      ["w1", "already_linked"],
      ["w3", "already_linked"],
    ]);
    expect(await countItems(retail.locationId)).toBe(before);
    // Everything is already verified: the gate takes the fast path and the run has nothing left to apply.
    const discovery = await asBusiness(retail.id, () => svc.completeProductDiscovery(retail.id, second.id, actor));
    expect(discovery.gate.path).toBe("fast");
    expect(discovery.counts.pending).toBe(0);
  });

  it("keeps another business out of every table", async () => {
    await expect(asBusiness(other.id, () => svc.getRunSummary(other.id, runId))).rejects.toMatchObject({ code: "run_not_found" });
    await expect(asBusiness(other.id, () => svc.listItems(other.id, runId))).resolves.toEqual([]);
  });
});

describe("a preview-only run, an empty catalogue and a connection-backed source", () => {
  it("never writes, never lets a decision through, and is released by cancelling", async () => {
    const run = await asBusiness(cafe.id, () =>
      svc.openRun({
        businessId: cafe.id,
        locationId: cafe.locationId,
        domain: "product",
        sourceKind: "file",
        provider: "csv",
        sourceKey: "menu.csv",
        importMode: "preview_only",
        sourceFingerprint: "sha256:abc",
        evidence: { fileName: "menu.csv", bytes: 1200 },
        actor,
      }),
    );
    await asBusiness(cafe.id, () =>
      svc.stageProducts(cafe.id, run.id, [{ domain: "product", externalId: null, rowNumber: 2, name: "اسپرسو", sku: "ESP-1" }]),
    );
    const discovery = await asBusiness(cafe.id, () => svc.completeProductDiscovery(cafe.id, run.id, actor));
    expect(discovery.gate).toEqual({ path: "staged", reasons: ["preview_only"] });
    const items = await asBusiness(cafe.id, () => svc.listItems(cafe.id, run.id));
    expect(items[0]).toMatchObject({ externalKey: "row:2", outcome: "create_new", status: "proposed" });
    await expect(
      asBusiness(cafe.id, () => svc.decideItem({ businessId: cafe.id, runId: run.id, itemId: items[0].id, decision: "skip", actor })),
    ).rejects.toMatchObject({ code: "preview_only_run" });
    expect(Number((await db.query(`SELECT count(*)::int AS n FROM menu_items WHERE location_id = $1`, [cafe.locationId])).rows[0].n)).toBe(0);

    await asBusiness(cafe.id, () => svc.cancelRun(cafe.id, run.id, actor));
    // The scope is free again.
    await expect(
      asBusiness(cafe.id, () =>
        svc.openRun({
          businessId: cafe.id,
          locationId: cafe.locationId,
          domain: "product",
          sourceKind: "file",
          sourceKey: "menu.csv",
          importMode: "one_time",
          sourceFingerprint: "sha256:abc",
          actor,
        }),
      ),
    ).resolves.toMatchObject({ status: "discovering" });
  });

  it("applies a reviewed create through the owning service, then cross-checks and reports truthfully", async () => {
    const run = await asBusiness(retail.id, () =>
      svc.openRun({
        businessId: retail.id,
        locationId: retail.locationId,
        domain: "product",
        sourceKind: "provider",
        provider: "holoo",
        sourceKey: retail.connectionId,
        connectionId: retail.connectionId,
        importMode: "one_time",
        sourceFingerprint: "holoo-1",
        actor,
      }),
    );
    await asBusiness(retail.id, () =>
      svc.stageProducts(retail.id, run.id, [
        product("H-1", "کرم", "CREAM-1"),
        product("H-2", "لاک", "NAIL-1"),
      ]),
    );
    const discovery = await asBusiness(retail.id, () => svc.completeProductDiscovery(retail.id, run.id, actor));
    expect(discovery.gate.path).toBe("staged"); // populated: nothing writes without review
    await asBusiness(retail.id, () => svc.approveSafeBatch(retail.id, run.id, actor));

    const created: string[] = [];
    const handler = svc.createProductApplyHandler({
      async create(ctx) {
        // The owning service would create the product; the test inserts through the same transaction.
        const row = await ctx.client.query<{ id: string }>(
          `INSERT INTO items (location_id, name, sku) VALUES ($1, $2, $3) RETURNING id::text AS id`,
          [ctx.run.locationId, (ctx.item.snapshot as { name: string }).name, (ctx.item.snapshot as { sku: string }).sku],
        );
        created.push(row.rows[0].id);
        return { canonicalId: row.rows[0].id };
      },
    });
    const runRow = (await asBusiness(retail.id, () => svc.getRunSummary(retail.id, run.id))).run;
    const current = {
      sourceFingerprint: runRow.sourceFingerprint,
      policyVersion: runRow.policyVersion,
      canonicalToken: await asBusiness(retail.id, () =>
        dbLib.withTenantTransaction(retail.id, (client) => svc.productCanonicalToken(client, runRow)),
      ),
    };
    const result = await asBusiness(retail.id, () => svc.applyRun({ businessId: retail.id, runId: run.id, handler, current, actor }));
    expect(created).toHaveLength(2);
    expect(result.run.status).toBe("applied");
    // Applied is not yet "reconciled": the cross-check has not run.
    expect(result.progress).toMatchObject({ stage: "acknowledged", fullyReconciled: false });

    // Connection-backed sources also get the integration_mappings row the sync code reads.
    const mappings = await db.query(`SELECT remote_id FROM integration_mappings WHERE connection_id = $1 ORDER BY remote_id`, [retail.connectionId]);
    expect(mappings.rows.map((r) => r.remote_id)).toEqual(["H-1", "H-2"]);

    const check = await asBusiness(retail.id, () => svc.crossCheckRun(retail.id, run.id));
    expect(check).toEqual({ ok: true, problems: [] });
    const after = await asBusiness(retail.id, () => svc.getRunSummary(retail.id, run.id));
    expect(after.progress).toMatchObject({ stage: "reconciled", fullyReconciled: true });

    // An applied run is history: it cannot be reopened.
    await expect(db.query(`UPDATE import_reconciliation_runs SET status = 'staged' WHERE id = $1`, [run.id])).rejects.toThrow(/run_closed/);
    await expect(db.query(`UPDATE import_reconciliation_runs SET evidence = '{"tampered":true}' WHERE id = $1`, [run.id])).rejects.toThrow(/immutable/);
  });

  it("re-points nothing and tombstones only on an explicit, reasoned act", async () => {
    const identity = await db.query<{ id: string }>(`SELECT id FROM source_identities WHERE business_id = $1 AND external_id = 'H-1'`, [retail.id]);
    await expect(asBusiness(retail.id, () => svc.retireSourceIdentity(retail.id, identity.rows[0].id, " ", actor))).rejects.toMatchObject({
      code: "reason_required",
    });
    await asBusiness(retail.id, () => svc.retireSourceIdentity(retail.id, identity.rows[0].id, "منبع حذف شد", actor));
    const row = await db.query(`SELECT retired_at, retired_reason FROM source_identities WHERE id = $1`, [identity.rows[0].id]);
    expect(row.rows[0].retired_reason).toBe("منبع حذف شد");
    expect(row.rows[0].retired_at).not.toBeNull();
  });
});

describe("XLSX catalogue workflow", () => {
  const columns = ["sku", "title", "price", "موجودی", "drive", "case_dimension", "band_color", "parent_sku", "parent_title", "option"];
  const sheet = (rows: string[][]) => ({
    name: "Catalogue", columns, rows: rows.map((values, index) => ({
      number: index + 2,
      cells: values.map((value, col) => col === 2 || col === 3
        ? { text: value, issue: "formula" as const }
        : { text: value }),
    })),
  });
  const stageInput = (data: ReturnType<typeof sheet>, axis = "", fallbackBrand: string | null = "FixtureBrand") => ({
    sheet: data, mapping: { sku: 0, title: 1, price: 2, quantity: 3, drive: 4, case_dimension: 5, band_color: 6,
      parent_sku: 7, parent_title: 8, option: 9 },
    fileName: "fixture.xlsx", sourceName: "fixtures", fingerprint: randomUUID(), fallbackBrand, axis, duplicateRows: [],
  });

  it("reviews and reapplies a serialized watch model without stock, price or phantom variants", async () => {
    const catalogue = await import("../src/lib/data-transfer/catalogue-service");
    const gate = await import("../src/lib/data-transfer/catalogue-gate");
    const watch = await seedBusiness("watch", "Watch fixture");
    const owner = { businessId: watch.id, locationId: watch.locationId, target: "watch" as const, actor };
    const input = stageInput(sheet([["W-10", "Model", "EXTERNAL_PRICE", "EXTERNAL_QTY", "اتوماتیک (Hand Winding)", "42 × 29 mm", "Silver"]]));
    await asBusiness(owner.businessId, async () => {
      const runId = await catalogue.stageCatalogue(owner, input);
      expect(await countItems(watch.locationId)).toBe(0);
      await expect(dbLib.withTenantTransaction(watch.id, client => gate.gateWooCatalogueCreate(client, watch.id, watch.locationId, "w-۱۰")))
        .rejects.toThrow("catalogue_reconciliation_required");
      await expect(catalogue.catalogueSummary({ ...owner, locationId: retail.locationId }, runId)).rejects.toThrow("run_not_found");
      expect((await catalogue.applyCatalogue(owner, runId, true)).run.status).toBe("applied");
      const second = await catalogue.stageCatalogue(owner, input);
      expect((await catalogue.catalogueItems(owner, second))[0].outcome).toBe("already_linked");
      expect((await catalogue.applyCatalogue(owner, second, true)).run.status).toBe("applied");
    });
    const result = await db.query(`SELECT i.kind,i.tracking,i.publish_status,a.movement,a.case_dimensions_mm,a.bracelet_color,
       s.unit_price,s.quantity FROM items i JOIN watch_item_attributes a ON a.item_id=i.id
       LEFT JOIN item_stock s ON s.item_id=i.id WHERE i.location_id=$1`, [watch.locationId]);
    expect(result.rows).toEqual([{ kind: "simple", tracking: "serial", publish_status: "draft", movement: null,
      case_dimensions_mm: [42, 29], bracelet_color: "نقره ای", unit_price: null, quantity: null }]);
  });

  it("creates an explicit retail family atomically and rejects a changed local preview", async () => {
    const catalogue = await import("../src/lib/data-transfer/catalogue-service");
    const business = await seedBusiness("cosmetics", "Retail fixture");
    const owner = { businessId: business.id, locationId: business.locationId, target: "retail" as const, actor };
    await db.query("INSERT INTO item_attribute_definitions (location_id,name,options) VALUES ($1,'Color',ARRAY['Blue','Red'])", [business.locationId]);
    const rows = sheet([
      ["C-1", "Blue model", "", "", "", "", "", "F-1", "Family", "Blue"],
      ["C-2", "Red model", "", "", "", "", "", "F-1", "Family", "Red"],
    ]);
    await asBusiness(owner.businessId, async () => {
      const runId = await catalogue.stageCatalogue(owner, stageInput(rows, "Color"));
      expect((await catalogue.applyCatalogue(owner, runId, true)).run.status).toBe("applied");
      expect(await countItems(business.locationId)).toBe(3);
      const retryId = await catalogue.stageCatalogue(owner, stageInput(rows, "Color"));
      expect((await catalogue.catalogueItems(owner, retryId))[0].outcome).toBe("already_linked");
      await addItem(business.locationId, "Concurrent SKU", "NEW-1");
      await expect(catalogue.applyCatalogue(owner, retryId, true)).rejects.toThrow("preview_stale");
      expect((await catalogue.catalogueSummary(owner, retryId)).run.status).toBe("stale");
    });
  });
  it("waits for live connector discovery and records the Woo link only after the fenced ACK", async () => {
    const catalogue = await import("../src/lib/data-transfer/catalogue-service");
    const { previewCatalogueWoo, queueCatalogueWoo, catalogueWooStatus } = await import("../src/lib/data-transfer/catalogue-woo");
    const { getConnection } = await import("../src/lib/integrations/connections-service");
    const { pluginAckJobs } = await import("../src/lib/integrations/plugin-service");
    const business = await seedBusiness("watch", "Plugin fixture");
    const owner = { businessId: business.id, locationId: business.locationId, target: "watch" as const, actor };
    const { rows: [store] } = await db.query<{ id: string }>(
      `INSERT INTO integration_connections (business_id,location_id,name,provider,base_url,link_mode,status,plugin_capabilities,link_token_hash,link_token_ciphertext)
       VALUES ($1,$2,'Fixture','woocommerce','https://example.invalid','plugin','active',$3::jsonb,repeat('a',64),'test-only') RETURNING id`,
      [business.id, business.locationId, JSON.stringify({ protocolVersion: 3, jobTypes: ["catalogue_product_review", "product_publish"] })],
    );
    await asBusiness(business.id, async () => {
      const connection = (await getConnection(business.id, store.id))!;
      const runId = await catalogue.stageCatalogue(owner, stageInput(sheet([["W-11", "Local title"]])));
      const [item] = await catalogue.catalogueItems(owner, runId);
      await expect(previewCatalogueWoo(owner, runId, item.id, connection)).rejects.toThrow("catalogue_woo_discovery_pending");

      const lease = randomUUID();
      const { rows: [probe] } = await db.query<{ id: string }>(
        `UPDATE integration_outbox_events SET status='processing', lease_token=$2, leased_until=now()+interval '5 minutes'
         WHERE connection_id=$1 AND entity_type='catalogue_product_review' RETURNING id`, [store.id, lease],
      );
      await pluginAckJobs(connection, [{ id: probe.id, status: "done", leaseToken: lease, result: {
        matches: [{ id: 59, sku: "W-11", name: "Store-owned title", type: "simple", parent: null, options: [], categories: [] }],
        variations: [], attributes: [], brands: [], categories: [],
      } }]);
      const preview = await previewCatalogueWoo(owner, runId, item.id, connection);
      expect(preview).toMatchObject({ action: "link", discovery: "live", remote: { id: "59", name: "Store-owned title" } });
      const approval = { token: preview.token, createMissing: false, acceptMirror: false };
      await expect(queueCatalogueWoo(owner, runId, item.id, connection, approval)).rejects.toThrow("catalogue_local_apply_required");
      expect((await catalogue.applyCatalogue(owner, runId, true)).run.status).toBe("applied");
      await queueCatalogueWoo(owner, runId, item.id, connection, approval);
      expect((await catalogueWooStatus(owner, runId, store.id))[0]).toMatchObject({ status: "pending", remote: null });
      expect((await db.query("SELECT 1 FROM integration_mappings WHERE connection_id=$1", [store.id])).rowCount).toBe(0);
      const { rows: [delivery] } = await db.query<{ id: string; payload: Record<string, unknown> }>(
        `UPDATE integration_outbox_events SET status='processing',lease_token=$2,leased_until=now()+interval '5 minutes'
         WHERE connection_id=$1 AND entity_type='product_publish' RETURNING id,payload`, [store.id, lease],
      );
      expect(delivery.payload).toMatchObject({ __linkOnly: true, __targetRemoteId: "59", sku: "W-11" });
      expect(delivery.payload).not.toHaveProperty("name");
      await pluginAckJobs(connection, [{ id: delivery.id, status: "done", leaseToken: randomUUID(), result: { remoteId: 59 } }]);
      expect((await catalogueWooStatus(owner, runId, store.id))[0].status).toBe("processing");
      await pluginAckJobs(connection, [{ id: delivery.id, status: "done", leaseToken: lease, result: { remoteId: 59 } }]);
      expect((await catalogueWooStatus(owner, runId, store.id))[0]).toMatchObject({ status: "sent", remote: "59" });
      const { rows: [linked] } = await db.query(
        `SELECT last_pushed_payload FROM integration_mappings WHERE connection_id=$1 AND remote_id='59'`, [store.id],
      );
      expect(linked.last_pushed_payload).toMatchObject({ catalogueMetadataOnly: true, pricePushPaused: true, stockPushPaused: true });
    });
  });

  it("handles workbook brands, blank-row fallback, branch isolation, and concurrent brand creation safely (#1335)", async () => {
    const catalogue = await import("../src/lib/data-transfer/catalogue-service");
    const { ensureBranchBrand } = await import("../src/lib/item-brands-service");
    const branchA = await seedBusiness("cosmetics", "Brand Branch A");
    const branchB = await seedBusiness("cosmetics", "Brand Branch B");

    // Pre-create a brand with the same name in another branch/tenant AND one in branch A.
    const foreignBrand = await db.query<{ id: string }>(
      `INSERT INTO item_brands (location_id, name) VALUES ($1, 'Casio') RETURNING id`,
      [branchB.locationId],
    );
    const localExistingBrand = await db.query<{ id: string }>(
      `INSERT INTO item_brands (location_id, name) VALUES ($1, 'Seiko') RETURNING id`,
      [branchA.locationId],
    );

    const cols = ["sku", "title", "brand"];
    const makeSheet = (rows: string[][]) => ({
      name: "Catalogue",
      columns: cols,
      rows: rows.map((values, idx) => ({ number: idx + 2, cells: values.map((text) => ({ text })) })),
    });
    const mapping = { sku: 0, title: 1, brand: 2 };
    const ownerA = { businessId: branchA.id, locationId: branchA.locationId, target: "retail" as const, actor };

    await asBusiness(branchA.id, async () => {
      const runId = await catalogue.stageCatalogue(ownerA, {
        sheet: makeSheet([
          ["B-1", "Item One", "casio"],
          ["B-2", "Item Two", "SEIKO"],
          ["B-3", "Item Three", ""],
          ["B-4", "Item Four", "Citizen"],
        ]),
        mapping,
        fileName: "brands.xlsx",
        sourceName: "brand-source",
        fingerprint: randomUUID(),
        fallbackBrand: "FallbackBrand",
        duplicateRows: [],
        axis: "",
      });
      const summary = await catalogue.applyCatalogue(ownerA, runId, true);
      expect(summary.run.status).toBe("applied");

      const items = await db.query<{ sku: string; brand_id: string; brand_name: string }>(
        `SELECT i.sku, i.brand_id::text, b.name AS brand_name
           FROM items i
           JOIN item_brands b ON b.id = i.brand_id
          WHERE i.location_id = $1
          ORDER BY i.sku`,
        [branchA.locationId],
      );
      expect(items.rows.map((r) => [r.sku, r.brand_name])).toEqual([
        ["B-1", "casio"],
        ["B-2", "Seiko"], // reused existing normalized branch brand!
        ["B-3", "FallbackBrand"], // blank row got fallback; populated rows kept theirs
        ["B-4", "Citizen"],
      ]);
      // Branch A reused its own Seiko brand, and created its own Casio brand (never branch B's!).
      expect(items.rows[1].brand_id).toBe(localExistingBrand.rows[0].id);
      expect(items.rows[0].brand_id).not.toBe(foreignBrand.rows[0].id);

      // Concurrent ensureBranchBrand calls for the same brand name converge cleanly without 23505.
      const concurrent = await Promise.all([
        ensureBranchBrand(branchA.locationId, "Omega"),
        ensureBranchBrand(branchA.locationId, "Omega"),
        ensureBranchBrand(branchA.locationId, "omega"),
      ]);
      expect(new Set(concurrent.map((b) => b.id)).size).toBe(1);
    });
  });

});

describe("party, financial document, inventory, rejected remote edits & cutover (#1118)", () => {
  it("stages parties against encrypted/normalised phones without merging unverified phones or transferring consent", async () => {
    const { createParty } = await import("../src/lib/parties-service");
    const biz = await seedBusiness("cosmetics", "Party Rec Biz");
    const existingCustomer = await asBusiness(biz.id, () =>
      createParty(biz.id, {
        displayName: "سارا محمدی",
        role: "Customer",
        roles: ["Customer"],
        phone: "09121112233",
        email: "sara@example.com",
      }, { locationId: biz.locationId }),
    );
    const supplier = await asBusiness(biz.id, () =>
      createParty(biz.id, {
        displayName: "پخش آفتاب",
        role: "Supplier",
        roles: ["Supplier"],
        phone: "09129998877",
      }, { locationId: biz.locationId }),
    );

    const run = await asBusiness(biz.id, () =>
      svc.openRun({
        businessId: biz.id,
        locationId: biz.locationId,
        domain: "party",
        sourceKind: "file",
        provider: "csv",
        sourceKey: "customers.csv",
        importMode: "one_time",
        sourceFingerprint: "party-fp-1",
        actor,
      }),
    );

    await asBusiness(biz.id, () =>
      svc.stageParties(biz.id, run.id, [
        {
          domain: "party",
          externalId: "C-1",
          name: "سارا محمدی",
          phone: "۰۹۱۲۱۱۱۲۲۳۳",
          role: "customer",
          consent: { sms: true, marketing: true },
        },
        {
          domain: "party",
          externalId: "C-2",
          name: "پخش آفتاب",
          phone: "09129998877",
          role: "customer",
        },
        {
          domain: "party",
          externalId: "C-3",
          name: "مشتری تازه",
          phone: "09123334455",
          role: "customer",
        },
      ]),
    );

    const discovery = await asBusiness(biz.id, () => svc.completePartyDiscovery(biz.id, run.id, actor));
    expect(discovery.gate.path).toBe("staged");

    const items = await asBusiness(biz.id, () => svc.listItems(biz.id, run.id));
    const byKey = Object.fromEntries(items.map((i) => [i.externalKey, i]));
    // Unverified phone is NEVER auto-linked; surfaces candidate for human confirmation + consent warning.
    expect(byKey["C-1"].outcome).toBe("ambiguous");
    expect(byKey["C-1"].reasons).toContain("phone_match_unverified");
    expect(byKey["C-1"].candidates.map((c) => c.id)).toEqual([existingCustomer.id]);
    expect(byKey["C-1"].notes).toContain("consent_not_transferred");

    // Supplier phone arriving as customer flags role_mismatch.
    expect(byKey["C-2"].outcome).toBe("ambiguous");
    expect(byKey["C-2"].reasons).toContain("role_mismatch");
    expect(byKey["C-2"].candidates.map((c) => c.id)).toEqual([supplier.id]);

    expect(byKey["C-3"].outcome).toBe("create_new");

    await asBusiness(biz.id, () =>
      svc.decideItem({
        businessId: biz.id,
        runId: run.id,
        itemId: byKey["C-1"].id,
        decision: "link",
        canonicalId: existingCustomer.id,
        reason: "تأیید مشتری تکراری",
        actor,
      }),
    );
    await asBusiness(biz.id, () =>
      svc.decideItem({ businessId: biz.id, runId: run.id, itemId: byKey["C-2"].id, decision: "skip", actor }),
    );
    await asBusiness(biz.id, () => svc.approveSafeBatch(biz.id, run.id, actor));

    const runRow = (await asBusiness(biz.id, () => svc.getRunSummary(biz.id, run.id))).run;
    const handler = svc.createPartyApplyHandler({
      async create(ctx) {
        const snap = ctx.item.snapshot as { name: string; phone?: string };
        const created = await createParty(biz.id, {
          displayName: snap.name,
          role: "Customer",
          roles: ["Customer"],
          phone: snap.phone ?? null,
        }, { locationId: biz.locationId });
        return { canonicalId: created.id };
      },
    });
    const current = {
      sourceFingerprint: runRow.sourceFingerprint,
      policyVersion: runRow.policyVersion,
      canonicalToken: await asBusiness(biz.id, () =>
        dbLib.withTenantTransaction(biz.id, (client) => svc.partyCanonicalToken(client, runRow)),
      ),
    };
    const applied = await asBusiness(biz.id, () => svc.applyRun({ businessId: biz.id, runId: run.id, handler, current, actor }));
    expect(applied.run.status).toBe("applied");
    const cross = await asBusiness(biz.id, () => svc.crossCheckRun(biz.id, run.id));
    expect(cross).toEqual({ ok: true, problems: [] });

    // Consent remains false on both linked and created parties.
    const consentRows = await db.query<{ sms_consent: boolean; marketing_consent: boolean }>(
      `SELECT sms_consent, marketing_consent FROM parties WHERE business_id = $1`,
      [biz.id],
    );
    expect(consentRows.rows.every((r) => !r.sms_consent && !r.marketing_consent)).toBe(true);
  });

  it("matches financial documents conservatively, prevents double-posting, and records cutover & rejected remote edits", async () => {
    const biz = await seedBusiness("cosmetics", "Fin Inv Rec Biz");
    // Seed a manual order and an item with stock.
    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status, total, opened_at)
       VALUES ($1, 501, 'takeaway', 'completed', 250000, '2026-10-01T10:00:00Z') RETURNING id`,
      [biz.locationId],
    );
    const itemId = await addItem(biz.locationId, "کرم صورت", "SK-10");
    await db.query(`INSERT INTO item_stock (item_id, quantity, unit_price) VALUES ($1, 10, 50000)`, [itemId]);

    // 1. Financial documents: amount+date alone never auto-links; matching reference is historical_match.
    const finRun = await asBusiness(biz.id, () =>
      svc.openRun({
        businessId: biz.id,
        locationId: biz.locationId,
        domain: "financial_document",
        sourceKind: "provider",
        provider: "woocommerce",
        sourceKey: "woo-fin",
        importMode: "backfill",
        sourceFingerprint: "fin-1",
        actor,
      }),
    );
    await asBusiness(biz.id, () =>
      svc.setRunCutoverPolicy(biz.id, finRun.id, { cutoverAuthority: "books", cutoverAt: "2026-10-01T00:00:00Z" }, actor),
    );
    await asBusiness(biz.id, () =>
      svc.stageFinancialDocuments(biz.id, finRun.id, [
        { domain: "financial_document", externalId: "o-1", kind: "invoice", references: ["501"], totalRial: "250000", currency: "IRR", date: "2026-10-01" },
        { domain: "financial_document", externalId: "o-2", kind: "invoice", references: ["WEB-999"], totalRial: "250000", currency: "IRR", date: "2026-10-01" },
      ]),
    );
    await asBusiness(biz.id, () => svc.completeFinancialDocumentDiscovery(biz.id, finRun.id, actor));
    const finItems = await asBusiness(biz.id, () => svc.listItems(biz.id, finRun.id));
    const byFin = Object.fromEntries(finItems.map((i) => [i.externalKey, i]));
    expect(byFin["o-1"]).toMatchObject({ outcome: "historical_match", canonicalId: order.rows[0].id, status: "applied" });
    expect(byFin["o-2"]).toMatchObject({ outcome: "ambiguous", reasons: ["amount_date_only"] });

    // 2. Inventory: snapshot conflict + online_order skipped (never double-relieves).
    const prodIdentityRun = await asBusiness(biz.id, () =>
      svc.openRun({
        businessId: biz.id,
        locationId: biz.locationId,
        domain: "product",
        sourceKind: "provider",
        provider: "woocommerce",
        sourceKey: "woo-inv",
        importMode: "live_link",
        sourceFingerprint: "prod-inv",
        actor,
      }),
    );
    await asBusiness(biz.id, () => svc.stageProducts(biz.id, prodIdentityRun.id, [
      product("w-10", "کرم صورت", "SK-10", { fields: { stock_quantity: 8 } }),
    ]));
    await asBusiness(biz.id, () => svc.completeProductDiscovery(biz.id, prodIdentityRun.id, actor));
    const stagedProd = (await asBusiness(biz.id, () => svc.listItems(biz.id, prodIdentityRun.id)))[0];
    // Reject the incoming stock change in favor of canonical: persists in rejected_edits!
    await asBusiness(biz.id, () =>
      svc.decideItem({
        businessId: biz.id,
        runId: prodIdentityRun.id,
        itemId: stagedProd.id,
        decision: "choose_authority",
        authorityOverrides: { stock_quantity: "canonical" },
        reason: "موجودی انبار رسمی مرجع است",
        actor,
      }),
    );
    const prodRunRow = (await asBusiness(biz.id, () => svc.getRunSummary(biz.id, prodIdentityRun.id))).run;
    const prodToken = await asBusiness(biz.id, () =>
      dbLib.withTenantTransaction(biz.id, (c) => svc.productCanonicalToken(c, prodRunRow)),
    );
    await asBusiness(biz.id, () =>
      svc.applyRun({
        businessId: biz.id,
        runId: prodIdentityRun.id,
        handler: svc.createProductApplyHandler(),
        current: {
          sourceFingerprint: prodRunRow.sourceFingerprint,
          policyVersion: prodRunRow.policyVersion,
          canonicalToken: prodToken,
        },
        actor,
      }),
    );
    expect(await svc.isRemoteEditSuppressed(biz.id, "woo-inv", "product", "product", "w-10", "stock_quantity", 8)).toBe(true);
    expect(await svc.isRemoteEditSuppressed(biz.id, "woo-inv", "product", "product", "w-10", "stock_quantity", 7)).toBe(false);

    // Subsequent product run does NOT re-flag the same rejected value (8)!
    const prodRun2 = await asBusiness(biz.id, () =>
      svc.openRun({
        businessId: biz.id,
        locationId: biz.locationId,
        domain: "product",
        sourceKind: "provider",
        provider: "woocommerce",
        sourceKey: "woo-inv",
        importMode: "live_link",
        sourceFingerprint: "prod-inv-2",
        actor,
      }),
    );
    await asBusiness(biz.id, () => svc.stageProducts(biz.id, prodRun2.id, [
      product("w-10", "کرم صورت", "SK-10", { fields: { stock_quantity: 8 } }),
    ]));
    expect((await asBusiness(biz.id, () => svc.listItems(biz.id, prodRun2.id)))[0].outcome).toBe("already_linked");

    // Inventory domain staging: snapshot conflict vs online_order movement skipped.
    const invRun = await asBusiness(biz.id, () =>
      svc.openRun({
        businessId: biz.id,
        locationId: biz.locationId,
        domain: "inventory",
        sourceKind: "provider",
        provider: "woocommerce",
        sourceKey: "woo-inv",
        importMode: "live_link",
        sourceFingerprint: "inv-1",
        actor,
      }),
    );
    await asBusiness(biz.id, () =>
      svc.stageInventory(biz.id, invRun.id, [
        { domain: "inventory", externalId: "snap-1", kind: "snapshot", productExternalId: "w-10", quantity: "8" },
        { domain: "inventory", externalId: "mov-1", kind: "movement", productExternalId: "w-10", quantity: "-1", cause: "online_order" },
      ]),
    );
    await asBusiness(biz.id, () => svc.completeInventoryDiscovery(biz.id, invRun.id, actor));
    const invItems = await asBusiness(biz.id, () => svc.listItems(biz.id, invRun.id));
    expect(invItems.find((i) => i.externalKey === "snap-1")?.outcome).toBe("field_conflict");
    expect(invItems.find((i) => i.externalKey === "mov-1")?.outcome).toBe("skipped");
  });

  it("gates Data Transfer, Holoo, and WooCommerce product sync via staged reconciliation runs and applies via domain handlers", async () => {
    const biz = await seedBusiness("cosmetics", "Entry Gate Biz");
    const existingItemId = await addItem(biz.locationId, "عطر رز", "SKU-ROSE-1");
    await db.query(`INSERT INTO item_stock (item_id, quantity, unit_price) VALUES ($1, 5, 100000)`, [existingItemId]);

    const wooConnRes = await db.query<{ id: string }>(
      `INSERT INTO integration_connections
         (business_id, location_id, name, provider, base_url,
          consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
          currency_unit, link_mode, status)
       VALUES ($1, $2, 'Woo Gate', 'woocommerce', 'https://shop.example.com', 'enc-k', 'enc-s', 'enc-w', 'toman', 'rest_api', 'active')
       RETURNING id`,
      [biz.id, biz.locationId],
    );
    const wooConnId = wooConnRes.rows[0].id;
    const holooConnRes = await db.query<{ id: string }>(
      `INSERT INTO integration_connections (business_id, location_id, name, provider, base_url, currency_unit, status)
       VALUES ($1, $2, 'Holoo Gate', 'holoo', NULL, 'rial', 'active')
       RETURNING id`,
      [biz.id, biz.locationId],
    );
    const holooConnId = holooConnRes.rows[0].id;

    const dtImport = await import("../src/lib/data-transfer/import-service");
    const holooSvc = await import("../src/lib/data-transfer/providers/holoo/service");
    const wooSync = await import("../src/lib/integrations/sync-service");
    const applyRunner = await import("../src/lib/import-reconciliation/apply-runner");

    // 1. Data Transfer CSV upload with overlapping item + brand-new item -> staged reconciliation run
    const csvBuf = Buffer.from(
      "name,sku,unit,avgCost\nعطر رز,SKU-ROSE-1,عدد,100000\nعطر یاس,SKU-JAS-2,عدد,120000\n",
      "utf8",
    );
    const { job } = await asBusiness(biz.id, () =>
      dtImport.createImportJob({
        businessId: biz.id,
        locationId: biz.locationId,
        entityKey: "inventory.items",
        fileName: "items.csv",
        format: "csv",
        buffer: csvBuf.buffer.slice(csvBuf.byteOffset, csvBuf.byteOffset + csvBuf.byteLength),
        actorUserId: null,
        actorName: actor.name,
        mapping: {
          columns: [
            { column: 0, field: "name" },
            { column: 1, field: "sku" },
            { column: 2, field: "unit" },
            { column: 3, field: "avgCost" },
          ],
        },
      }),
    );

    await asBusiness(biz.id, () =>
      dtImport.previewImportJob(biz.id, job.id, { mapping: job.mapping }),
    );
    const stagedDt = await asBusiness(biz.id, () =>
      dtImport.stageImportJobToReconciliation(biz.id, job.id, actor),
    );
    expect(stagedDt.domain).toBe("product");
    expect(stagedDt.counts.newRecords).toBeGreaterThanOrEqual(1);

    // Queueing the Data Transfer job directly while its linked reconciliation run is active is refused
    await expect(
      asBusiness(biz.id, () => dtImport.queueImportJob(biz.id, job.id)),
    ).rejects.toThrow(/reconciliation_required/);

    // Approve safe batch & apply via domain-aware runner -> creates SKU-JAS-2 with item_stock row
    await asBusiness(biz.id, () => svc.approveSafeBatch(biz.id, stagedDt.runId, actor));
    const dtItems = await asBusiness(biz.id, () => svc.listItems(biz.id, stagedDt.runId));
    const roseItem = dtItems.find((i) => (i.snapshot as { sku?: string })?.sku === "SKU-ROSE-1");
    if (roseItem && roseItem.status === "proposed") {
      await asBusiness(biz.id, () =>
        svc.decideItem({
          businessId: biz.id,
          runId: stagedDt.runId,
          itemId: roseItem.id,
          decision: roseItem.outcome === "field_conflict" ? "choose_authority" : "link",
          ...(roseItem.outcome === "field_conflict"
            ? { authorityOverrides: Object.fromEntries(roseItem.conflicts.map((c) => [c.field, "canonical"])) }
            : { canonicalId: roseItem.canonicalId ?? existingItemId }),
          actor,
        }),
      );
    }

    const appliedDt = await asBusiness(biz.id, () =>
      applyRunner.applyReconciliationRunWithDomainHandlers({
        businessId: biz.id,
        runId: stagedDt.runId,
        locationId: biz.locationId,
        actor,
      }),
    );
    expect(appliedDt.summary.run.status).toBe("applied");
    expect(appliedDt.crossCheck.ok).toBe(true);
    expect(await countItems(biz.locationId)).toBe(2);

    // 2. Holoo entry gate detects canonical overlap and blocks blind apply while a staged run is active
    const holooBase = {
      goods: [{ remoteId: "hg-1", name: "ادکلن", sku: "SKU-H1", unit: "عدد", priceRial: 350000n, costRial: 200000n }],
      persons: [],
      accounts: [],
      openingInventory: [],
    };
    expect(
      await asBusiness(biz.id, () =>
        holooSvc.holooNeedsReconciliation(biz.id, holooConnId, ["goods"], biz.locationId),
      ),
    ).toBe(true);
    const holooStaged = await asBusiness(biz.id, () =>
      holooSvc.stageHolooBaseToReconciliation({
        businessId: biz.id,
        connectionId: holooConnId,
        locationId: biz.locationId,
        scopes: ["goods"],
        base: holooBase as never,
        source: "xlsx",
        actorUserId: actor.userId,
        actorName: actor.name,
      }),
    );
    expect(holooStaged.runs).toHaveLength(1);
    expect(holooStaged.runs[0].domain).toBe("product");

    await expect(
      asBusiness(biz.id, () =>
        holooSvc.applyHolooBaseMigration({
          businessId: biz.id,
          connectionId: holooConnId,
          locationId: biz.locationId,
          scopes: ["goods"],
          base: holooBase as never,
          profile: { key: "holoo-v1", version: 1 },
          source: "xlsx",
          actorUserId: actor.userId ?? "00000000-0000-0000-0000-000000000000",
          actorName: actor.name,
        }),
      ),
    ).rejects.toThrow(/reconciliation_required/);

    // 3. WooCommerce syncProducts is blocked immediately when an active product run exists on the connection
    const activeWooRun = await asBusiness(biz.id, () =>
      svc.openRun({
        businessId: biz.id,
        locationId: biz.locationId,
        domain: "product",
        sourceKind: "provider",
        provider: "woocommerce",
        sourceKey: wooConnId,
        connectionId: wooConnId,
        importMode: "live_link",
        sourceFingerprint: "woo-gate-1",
        actor,
      }),
    );
    await asBusiness(biz.id, () => svc.stageProducts(biz.id, activeWooRun.id, [product("501", "محصول تست", "SKU-W501")]));
    await asBusiness(biz.id, () => svc.completeProductDiscovery(biz.id, activeWooRun.id, actor));

    await expect(asBusiness(biz.id, () => wooSync.syncProducts(biz.id, wooConnId))).rejects.toThrow(/reconciliation_required/);
    await asBusiness(biz.id, () => svc.cancelRun(biz.id, activeWooRun.id, actor));
  });

  it("defers webhooks during active runs, gates first-contact plugin links, and suppresses rejected edits outbound", async () => {
    const biz = await seedBusiness("cosmetics", "Webhook Outbox Guard Biz");
    const itemId = await addItem(biz.locationId, "ژل شستشو", "SKU-GEL-1");
    await db.query(`INSERT INTO item_stock (item_id, quantity, unit_price) VALUES ($1, 12, 250000)`, [itemId]);

    const connRes = await db.query<{
      id: string;
      business_id: string;
      location_id: string;
      name: string;
      provider: string;
      status: string;
      link_mode: string;
      currency_unit: string;
      source_of_truth: string;
    }>(
      `INSERT INTO integration_connections
         (business_id, location_id, name, provider, base_url,
          link_token_hash, link_token_ciphertext,
          currency_unit, link_mode, status, source_of_truth)
       VALUES ($1, $2, 'Woo Guard', 'woocommerce', 'https://guard.example.com', $3, 'enc-tok', 'rial', 'plugin', 'active', 'pos')
       RETURNING id, business_id, location_id, name, provider, status, link_mode, currency_unit, source_of_truth`,
      [biz.id, biz.locationId, `hash-${randomUUID()}`],
    );
    const conn = connRes.rows[0];
    const guards = await import("../src/lib/import-reconciliation/entry-guards");
    const ingestSvc = await import("../src/lib/integrations/webhook-ingest-service");
    const reportMod = await import("../src/lib/import-reconciliation/report");

    // 1. First-contact gate creates staged product run when business already has canonical items
    const gate = await asBusiness(biz.id, () =>
      guards.ensureFirstContactReconciliationGate(biz.id, conn.id, biz.locationId),
    );
    expect(gate.gatedDomains).toContain("product");

    // 2. Inbound webhook on product.updated while product run is active -> deferred in inbox without mutating item!
    const ingestOutcome = await asBusiness(biz.id, () =>
      ingestSvc.applyIngestEvent(conn as never, {
        topic: "product.updated",
        deliveryId: "deliv-reconcile-defer-1",
        payload: { id: 901, name: "نام تحمیلی از فروشگاه", sku: "SKU-GEL-1", regular_price: "199000" },
      }),
    );
    expect(ingestOutcome).toEqual({ status: "deferred" });
    const inboxRow = await db.query<{ status: string }>(
      `SELECT status FROM integration_webhook_events WHERE connection_id = $1 AND delivery_id = 'deliv-reconcile-defer-1'`,
      [conn.id],
    );
    expect(inboxRow.rows[0]?.status).toBe("deferred");
    const itemNameRow = await db.query<{ name: string }>(`SELECT name FROM items WHERE id = $1`, [itemId]);
    expect(itemNameRow.rows[0].name).toBe("ژل شستشو");

    // Close the staged first-contact run, then run a real conflict resolution & check outbound suppression + reports
    const activeProductRun = await asBusiness(biz.id, () => guards.findActiveRunForConnection(biz.id, conn.id, "product"));
    expect(activeProductRun).not.toBeNull();
    await asBusiness(biz.id, () => svc.cancelRun(biz.id, activeProductRun!.id, actor));

    const run = await asBusiness(biz.id, () =>
      svc.openRun({
        businessId: biz.id,
        locationId: biz.locationId,
        domain: "product",
        sourceKind: "provider",
        provider: "woocommerce",
        sourceKey: conn.id,
        connectionId: conn.id,
        importMode: "live_link",
        sourceFingerprint: "woo-suppress-1",
        actor,
      }),
    );
    await asBusiness(biz.id, () =>
      svc.stageProducts(biz.id, run.id, [
        product("901", "ژل شستشو", "SKU-GEL-1", { fields: { stock_quantity: 5, regular_price: "199000" } }),
      ]),
    );
    await asBusiness(biz.id, () => svc.completeProductDiscovery(biz.id, run.id, actor));

    // Reject the incoming stock_quantity = 5 & regular_price = 199000 in favour of canonical
    const [stagedItem] = await asBusiness(biz.id, () => svc.listItems(biz.id, run.id));
    expect(stagedItem.outcome).toBe("field_conflict");
    await asBusiness(biz.id, () =>
      svc.decideItem({
        businessId: biz.id,
        runId: run.id,
        itemId: stagedItem.id,
        decision: "choose_authority",
        authorityOverrides: { stock_quantity: "canonical", regular_price: "canonical" },
        reason: "قیمت سیستم مرجع است",
        actor,
      }),
    );

    // Report builders work cleanly on this run
    const summary = await asBusiness(biz.id, () => svc.getRunSummary(biz.id, run.id));
    const items = await asBusiness(biz.id, () => svc.listItems(biz.id, run.id));
    expect(reportMod.buildReconciliationRunReport(summary, items).counts.read).toBe(1);
    expect(reportMod.buildReconciliationReportCsv(summary, items)).toContain("901");

    // Manual outbound guard refuses while run is unapplied, then suppresses rejected 199000 after apply, allows 260000
    const beforeApply = await asBusiness(biz.id, () =>
      guards.checkManualProductOutboundGuard(biz.id, conn, "901", { regular_price: "260000" }),
    );
    expect(beforeApply).toEqual({ ok: false, reason: "reconciliation_active" });

    const runRow = summary.run;
    const token = await asBusiness(biz.id, () =>
      dbLib.withTenantTransaction(biz.id, (c) => svc.productCanonicalToken(c, runRow)),
    );
    await asBusiness(biz.id, () =>
      svc.applyRun({
        businessId: biz.id,
        runId: run.id,
        handler: svc.createProductApplyHandler(),
        current: { sourceFingerprint: runRow.sourceFingerprint, policyVersion: runRow.policyVersion, canonicalToken: token },
        actor,
      }),
    );

    const suppressedSet = await asBusiness(biz.id, () =>
      guards.listSuppressedRemoteEditsForConnection(biz.id, conn.id),
    );
    expect(guards.isOutboxFieldSuppressed(suppressedSet, "901", "regular_price", "199000")).toBe(true);
    expect(guards.isOutboxFieldSuppressed(suppressedSet, "901", "regular_price", 260000)).toBe(false);

    expect(
      await asBusiness(biz.id, () =>
        guards.checkManualProductOutboundGuard(biz.id, conn, "901", { regular_price: "199000" }),
      ),
    ).toEqual({ ok: false, reason: "rejected_edit_suppressed" });
    expect(
      await asBusiness(biz.id, () =>
        guards.checkManualProductOutboundGuard(biz.id, conn, "901", { regular_price: "260000" }),
      ),
    ).toEqual({ ok: true });
    expect(
      await guards.canPublishConnectionOutbound(biz.id, { id: conn.id, source_of_truth: "store" }),
    ).toEqual({ allowed: false, reason: "source_of_truth_store" });
  });

  it("preserves reconciliation decisions on Data Transfer job completion, keeps food_service inventory.items on inventory_items, wires inventory/journal create writers, and reuses staged Woo runs", async () => {
    const dtImport = await import("../src/lib/data-transfer/import-service");
    const applyRunner = await import("../src/lib/import-reconciliation/apply-runner");
    const guards = await import("../src/lib/import-reconciliation/entry-guards");
    const holooSvc = await import("../src/lib/data-transfer/providers/holoo/service");

    // 1. Food-service tenant: menu_items overlap must NOT trigger inventory.items overlap or create zero-priced menu_items
    const foodBiz = await seedBusiness("food_service", "کافه تطبیق کامل");
    await db.query(`INSERT INTO menu_items (location_id, name, sku, price) VALUES ($1, 'لاته', 'LATTE-1', 90000)`, [
      foodBiz.locationId,
    ]);
    await db.query(
      `INSERT INTO inventory_items (location_id, name, sku, unit) VALUES ($1, 'دانه قهوه', 'RAW-COFFEE-1', 'kg')`,
      [foodBiz.locationId],
    );
    expect(await guards.hasCanonicalOverlapForImportEntity(foodBiz.id, "inventory.items", foodBiz.locationId)).toBe(true);

    // Food-service raw-material import with 3 rows: 1 skip, 1 canonical-wins conflict (with duplicateStrategy=update), 1 create_new
    const rawCsv = Buffer.from(
      "name,sku,unit,avgCost\nدانه قهوه تغییریافته,RAW-COFFEE-1,kg,500000\nشکر قهوه‌ای ردشده,RAW-SKIP-2,kg,80000\nشیر تازه جدید,RAW-MILK-3,l,45000\n",
      "utf8",
    );
    const { job: foodJob } = await asBusiness(foodBiz.id, () =>
      dtImport.createImportJob({
        businessId: foodBiz.id,
        locationId: foodBiz.locationId,
        entityKey: "inventory.items",
        fileName: "raw-materials.csv",
        format: "csv",
        buffer: rawCsv.buffer.slice(rawCsv.byteOffset, rawCsv.byteOffset + rawCsv.byteLength),
        actorUserId: null,
        actorName: actor.name,
        mapping: {
          columns: [
            { column: 0, field: "name" },
            { column: 1, field: "sku" },
            { column: 2, field: "unit" },
            { column: 3, field: "avgCost" },
          ],
        },
        options: { duplicateStrategy: "update" },
      }),
    );
    await asBusiness(foodBiz.id, () => dtImport.previewImportJob(foodBiz.id, foodJob.id, { mapping: foodJob.mapping }));
    const stagedFood = await asBusiness(foodBiz.id, () =>
      dtImport.stageImportJobToReconciliation(foodBiz.id, foodJob.id, actor, foodBiz.locationId),
    );
    expect(stagedFood.run.scope).toEqual({ entityKey: "inventory.items", canonicalTable: "inventory_items" });

    const foodItems = await asBusiness(foodBiz.id, () => svc.listItems(foodBiz.id, stagedFood.runId));
    const coffee = foodItems.find((i) => i.externalKey === "RAW-COFFEE-1")!;
    const skipRow = foodItems.find((i) => i.externalKey === "RAW-SKIP-2")!;
    const milkRow = foodItems.find((i) => i.externalKey === "RAW-MILK-3")!;
    expect(coffee.canonicalId).toBeTruthy();

    await asBusiness(foodBiz.id, () =>
      svc.decideItem({
        businessId: foodBiz.id,
        runId: stagedFood.runId,
        itemId: coffee.id,
        decision: coffee.outcome === "field_conflict" ? "choose_authority" : "link",
        ...(coffee.outcome === "field_conflict"
          ? { authorityOverrides: Object.fromEntries(coffee.conflicts.map((c) => [c.field, "canonical"])) }
          : { canonicalId: coffee.canonicalId! }),
        actor,
      }),
    );
    await asBusiness(foodBiz.id, () =>
      svc.decideItem({ businessId: foodBiz.id, runId: stagedFood.runId, itemId: skipRow.id, decision: "skip", actor }),
    );
    await asBusiness(foodBiz.id, () =>
      svc.decideItem({ businessId: foodBiz.id, runId: stagedFood.runId, itemId: milkRow.id, decision: "create_separate", actor }),
    );

    const appliedFood = await asBusiness(foodBiz.id, () =>
      applyRunner.applyReconciliationRunWithDomainHandlers({
        businessId: foodBiz.id,
        runId: stagedFood.runId,
        locationId: foodBiz.locationId,
        actor,
      }),
    );
    expect(appliedFood.summary.run.status).toBe("applied");
    expect(appliedFood.crossCheck.ok).toBe(true);

    // Must write into inventory_items (NOT menu_items!), skip RAW-SKIP-2, and keep canonical RAW-COFFEE-1 intact
    const menuCount = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM menu_items WHERE location_id = $1`, [foodBiz.locationId]);
    expect(Number(menuCount.rows[0].n)).toBe(1);
    const invRows = await db.query<{ name: string; sku: string | null; unit: string }>(
      `SELECT name, sku, unit FROM inventory_items WHERE location_id = $1 ORDER BY sku`,
      [foodBiz.locationId],
    );
    expect(invRows.rows).toEqual([
      { name: "دانه قهوه", sku: "RAW-COFFEE-1", unit: "kg" },
      { name: "شیر تازه جدید", sku: "RAW-MILK-3", unit: "l" },
    ]);
    // Job completed from reconciliation decisions -> queueImportJob refuses re-running blindly
    const finishedJob = await asBusiness(foodBiz.id, () => dtImport.getImportJob(foodBiz.id, foodJob.id));
    expect(finishedJob?.status).toBe("completed");
    expect(finishedJob?.createdRows).toBe(1);
    expect(finishedJob?.skippedRows).toBe(2);
    await expect(asBusiness(foodBiz.id, () => dtImport.queueImportJob(foodBiz.id, foodJob.id))).rejects.toThrow(
      /already_completed/,
    );

    // 2. Holoo inventory & journal create writers succeed cleanly through applyReconciliationRunWithDomainHandlers
    const holooBiz = await seedBusiness("cosmetics", "آرایشی هلو اسناد و موجودی");
    await db.query(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1100', 'صندوق', 'asset'), ($1, '4300', 'فروش', 'revenue')`,
      [holooBiz.id],
    );
    const hConnRes = await db.query<{ id: string }>(
      `INSERT INTO integration_connections (business_id, location_id, name, provider, base_url, currency_unit, status)
       VALUES ($1, $2, 'Holoo Test', 'holoo', NULL, 'rial', 'active') RETURNING id`,
      [holooBiz.id, holooBiz.locationId],
    );
    const hConnId = hConnRes.rows[0].id;
    const hGoodsId = await addItem(holooBiz.locationId, "عطر هلو", "HG-SKU-1");
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'holoo_goods', 'hg-1', $3)`,
      [holooBiz.id, hConnId, hGoodsId],
    );
    const stagedHoloo = await asBusiness(holooBiz.id, () =>
      holooSvc.stageHolooBaseToReconciliation({
        businessId: holooBiz.id,
        connectionId: hConnId,
        actorUserId: null,
        actorName: actor.name,
        scopes: ["openingInventory", "journal", "journalLines"],
        source: "xlsx",
        locationId: holooBiz.locationId,
        base: {
          goods: [],
          persons: [],
          accounts: [],
          openingInventory: [
            { remoteId: "hs-1", goodsRemoteId: "hg-1", name: "عطر هلو", unit: "عدد", quantity: "12", unitCostRial: 150000n },
          ],
        },
        journals: [
          {
            remoteId: "hv-1",
            entryDate: "2026-11-01",
            memo: "سند آزمایشی هلو",
            lines: [
              { accountCode: "1100", debitRial: 500000n, creditRial: 0n },
              { accountCode: "4300", debitRial: 0n, creditRial: 500000n },
            ],
          },
        ],
      }),
    );

    const invRun = stagedHoloo.runs.find((r) => r.domain === "inventory")!;
    const jrnRun = stagedHoloo.runs.find((r) => r.domain === "financial_document")!;
    await asBusiness(holooBiz.id, () => svc.approveSafeBatch(holooBiz.id, invRun.runId, actor));
    await asBusiness(holooBiz.id, () => svc.approveSafeBatch(holooBiz.id, jrnRun.runId, actor));

    const appliedInv = await asBusiness(holooBiz.id, () =>
      applyRunner.applyReconciliationRunWithDomainHandlers({
        businessId: holooBiz.id,
        runId: invRun.runId,
        locationId: holooBiz.locationId,
        actor,
      }),
    );
    expect(appliedInv.summary.run.status).toBe("applied");
    expect(appliedInv.crossCheck.ok).toBe(true);
    const stockCheck = await db.query<{ quantity: string }>(`SELECT quantity::text FROM item_stock WHERE item_id = $1`, [hGoodsId]);
    expect(Number(stockCheck.rows[0]?.quantity)).toBe(12);

    const appliedJrn = await asBusiness(holooBiz.id, () =>
      applyRunner.applyReconciliationRunWithDomainHandlers({
        businessId: holooBiz.id,
        runId: jrnRun.runId,
        locationId: holooBiz.locationId,
        actor,
      }),
    );
    expect(appliedJrn.summary.run.status).toBe("applied");
    expect(appliedJrn.crossCheck.ok).toBe(true);
    const jeCount = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1`, [holooBiz.id]);
    expect(Number(jeCount.rows[0].n)).toBe(1);
  });
});
