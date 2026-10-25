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
