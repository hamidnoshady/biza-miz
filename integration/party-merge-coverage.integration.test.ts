/**
 * The regression guard for customer merge.
 *
 * ## The bug this exists to prevent
 *
 * `mergeCustomers()` used to re-point a **hand-written list** of nine tables.
 * The list was correct when it was written and wrong within two releases,
 * because every feature that linked something to a customer — cheques,
 * instalments, layaway, gold accounts, message recipients, the WooCommerce
 * customer mapping — added a reference that nobody remembered to add here.
 *
 * The symptom was silent and expensive. Merge two records for one customer and
 * their cheques stayed attached to a record that had just been archived; the
 * online store's mapping kept resolving new orders onto a customer who no
 * longer existed. Nothing threw. A screen simply showed less than the truth.
 *
 * ## Why a test rather than care
 *
 * No amount of review catches this, because the person adding
 * `installments.party_id` in a *financing* feature has no reason to be reading
 * the CRM's merge function. So the check is inverted: this test asks
 * **PostgreSQL** which columns point at `parties`, and demands that the
 * registry in `party-merge-references.ts` has an opinion about every one of
 * them. Add a customer-linked table and the suite fails until somebody writes
 * down what a merge should do with it — move it, leave it as history, or block
 * the merge outright.
 *
 * The three assertions, in order of what they protect:
 *
 * 1. **Coverage** — every live FK to `parties` is classified.
 * 2. **No fiction** — every classified reference exists in the live schema
 *    (so the registry cannot rot in the opposite direction, silently naming a
 *    table that was renamed away).
 * 3. **Behaviour** — a real merge over a populated database actually moves
 *    every `move` reference and leaves every `historical` one alone.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import {
  PARTY_REFERENCES,
  classifyPartyReference,
  historicalPartyReferences,
  movedPartyReferences,
  partyReferenceKey,
} from "../src/lib/party-merge-references";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let crm: typeof import("../src/lib/crm-service");

const biz = { id: "", locationId: "" };

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

beforeAll(async () => {
  databaseName = `pos_merge_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  crm = await import("../src/lib/crm-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry) VALUES ('مرج‌تست', $1, 'food_service') RETURNING id`,
    [`merge-${randomUUID().slice(0, 8)}`],
  );
  biz.id = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ اصلی') RETURNING id`,
    [biz.id],
  );
  biz.locationId = location.rows[0].id;
}, 180_000);

afterAll(async () => {
  await db?.end();
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

/** Every (table, column) in the live schema with a foreign key to parties(id). */
async function liveForeignKeys(): Promise<string[]> {
  const { rows } = await db.query<{ t: string; col: string }>(
    `SELECT src.relname AS t, att.attname AS col
       FROM pg_constraint con
       JOIN pg_class src ON src.oid = con.conrelid
       JOIN pg_class tgt ON tgt.oid = con.confrelid
       JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, pos) ON true
       JOIN unnest(con.confkey) WITH ORDINALITY AS fk(attnum, pos) ON fk.pos = k.pos
       JOIN pg_attribute att ON att.attrelid = src.oid AND att.attnum = k.attnum
       JOIN pg_attribute target_att ON target_att.attrelid = tgt.oid AND target_att.attnum = fk.attnum
      WHERE con.contype = 'f' AND tgt.relname = 'parties' AND target_att.attname = 'id'
      ORDER BY 1, 2`,
  );
  return rows.map((row) => partyReferenceKey(row.t, row.col));
}

describe("party merge reference coverage", () => {
  it("maps composite tenant foreign keys to the party identity column only", async () => {
    const live = await liveForeignKeys();
    expect(live).toContain("marketing_targets.party_id");
    expect(live).not.toContain("marketing_targets.business_id");
  });

  it("classifies every foreign key that points at parties", async () => {
    const live = await liveForeignKeys();
    const declared = new Set(
      PARTY_REFERENCES.map((reference) => partyReferenceKey(reference.table, reference.column)),
    );
    const unclassified = live.filter((key) => !declared.has(key));

    // The failure message has to teach, because whoever trips this did not set
    // out to touch the CRM and has no context for why merge cares.
    expect(
      unclassified,
      unclassified.length === 0
        ? ""
        : `These columns reference parties(id) but party-merge-references.ts has no opinion about them:\n` +
          unclassified.map((key) => `  - ${key}`).join("\n") +
          `\n\nMerging two customer records is irreversible. Decide what should happen to each:\n` +
          `  move       — the row belongs to the person; re-point it at the winner\n` +
          `  historical — the row records something that happened to the archived record; leave it\n` +
          `  blocked    — merging would corrupt this row; refuse the merge instead\n` +
          `Add an entry (with a \`reason\`) to PARTY_REFERENCES.`,
    ).toEqual([]);
  });

  it("declares nothing that the live schema does not have", async () => {
    const live = new Set(await liveForeignKeys());
    // A registry entry may legitimately have no FK — integration_mappings.local_id
    // is a bare uuid on purpose — but it must then say so, and the column must
    // still exist.
    const fictional: string[] = [];
    for (const reference of PARTY_REFERENCES) {
      const key = partyReferenceKey(reference.table, reference.column);
      if (live.has(key)) continue;
      const { rows } = await db.query<{ ok: boolean }>(
        `SELECT true AS ok FROM information_schema.columns
          WHERE table_name = $1 AND column_name = $2`,
        [reference.table, reference.column],
      );
      if (rows.length === 0) fictional.push(`${key} (no such column)`);
      else if (!reference.noForeignKey) {
        fictional.push(`${key} (no FK to parties — set noForeignKey: true if that is intended)`);
      }
    }
    expect(fictional).toEqual([]);
  });

  it("gives every reference a written reason", () => {
    // A classification without a justification is a guess, and the next person
    // cannot tell a guess from a decision.
    const unexplained = PARTY_REFERENCES.filter(
      (reference) => !reference.reason || reference.reason.trim().length < 20,
    ).map((reference) => partyReferenceKey(reference.table, reference.column));
    expect(unexplained).toEqual([]);
  });

  it("treats an unknown reference as merge-blocking, not as safe to ignore", () => {
    // Fail closed. A reference nobody classified is more likely to be a table
    // somebody forgot than a table that genuinely does not matter.
    expect(classifyPartyReference("some_future_table", "customer_id")).toBe("blocked");
  });

  it("moves every `move` reference and leaves every `historical` one behind", async () => {
    const winner = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, roles, phone)
       VALUES ($1, 'مشتری برنده', ARRAY['customer'], '09120000001') RETURNING id`,
      [biz.id],
    );
    const loser = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, roles, phone)
       VALUES ($1, 'مشتری بازنده', ARRAY['customer'], '09120000002') RETURNING id`,
      [biz.id],
    );
    const winnerId = winner.rows[0].id;
    const loserId = loser.rows[0].id;

    // Seed one row against the loser for every reference we can populate
    // generically. Tables needing heavy required context are skipped here and
    // covered by their own feature tests; the point of this case is the
    // *mechanism*, plus the two references that caused real incidents.
    const seeded: string[] = [];
    for (const reference of movedPartyReferences()) {
      const inserted = await seedReference(reference.table, reference.column, loserId);
      if (inserted) seeded.push(partyReferenceKey(reference.table, reference.column));
    }
    // The WooCommerce mapping is the reference that broke in production, so it
    // is seeded explicitly rather than opportunistically.
    expect(seeded).toContain("integration_mappings.local_id");
    // The workspace references are seeded deliberately too: a task tenanted
    // through its project is the shape that broke the merge when it was first
    // added, so a silent skip here would hide the regression it exists to
    // catch.
    expect(seeded).toContain("ai_project_tasks.party_id");
    expect(seeded).toContain("workspace_contracts.party_id");
    expect(seeded).toContain("marketing_targets.party_id");

    // A historical reference, to prove the merge leaves it alone.
    await db.query(
      `INSERT INTO crm_merges (business_id, winner_id, loser_id, moved_counts, loser_snapshot, merged_by)
       VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, 'سابقه')`,
      [biz.id, winnerId, loserId],
    );

    const result = await crm.mergeCustomers(biz.id, winnerId, loserId, { mergedBy: "آزمون" });
    expect(result).not.toBeNull();

    // Nothing that should have moved is still on the loser.
    const stragglers: string[] = [];
    for (const key of seeded) {
      const [table, column] = key.split(".");
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE ${column} = $1`,
        [loserId],
      );
      if (Number(rows[0].count) > 0) stragglers.push(key);
    }
    expect(
      stragglers,
      `Left pointing at the archived record after a merge: ${stragglers.join(", ")}`,
    ).toEqual([]);

    // The mapping now resolves to the surviving customer — the actual
    // production symptom, asserted directly.
    const mapping = await db.query<{ local_id: string }>(
      `SELECT local_id FROM integration_mappings
        WHERE business_id = $1 AND entity_type = 'customer'`,
      [biz.id],
    );
    expect(mapping.rows.map((row) => row.local_id)).toEqual([winnerId]);

    // History stays put: the merge record still names who lost.
    for (const reference of historicalPartyReferences()) {
      if (reference.table !== "crm_merges" || reference.column !== "loser_id") continue;
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM crm_merges WHERE loser_id = $1`,
        [loserId],
      );
      expect(Number(rows[0].count)).toBeGreaterThan(0);
    }

    // And the archived record is archived, not deleted — its id must stay
    // resolvable for every row that still names it.
    const archived = await db.query<{ is_active: boolean; merged_into_id: string }>(
      `SELECT is_active, merged_into_id FROM parties WHERE id = $1`,
      [loserId],
    );
    expect(archived.rows[0].is_active).toBe(false);
    expect(archived.rows[0].merged_into_id).toBe(winnerId);
  }, 60_000);
});

/**
 * Insert one minimal row linking `table.column` to `partyId`.
 *
 * Returns false when the table needs context this test does not set up (a
 * posted journal, an open shift); those references are exercised by their own
 * feature tests. Returning false rather than throwing keeps this test focused
 * on the merge mechanism instead of turning into a fixture factory for the
 * whole platform.
 */
async function seedReference(table: string, column: string, partyId: string): Promise<boolean> {
  // Each entry is a list of statements, because pg refuses to prepare more
  // than one command at a time and some references need a parent row first.
  const statements: Record<string, { sql: string; params: unknown[] }[]> = {
    "integration_mappings.local_id": [
      {
        // A rest_api connection with both consumer-key ciphertexts present is
        // the shape that satisfies integration_connections_mode_credentials
        // without needing a plugin link token.
        sql: `INSERT INTO integration_connections
                (business_id, provider, name, link_mode, base_url,
                 webhook_secret_ciphertext, consumer_key_ciphertext, consumer_secret_ciphertext)
                VALUES ($1, 'woocommerce', 'فروشگاه آنلاین', 'rest_api',
                        'https://example.test', 'whsec', 'ck', 'cs')
              ON CONFLICT DO NOTHING`,
        params: [biz.id],
      },
      {
        sql: `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
                SELECT $1, c.id, 'customer', '4242', $2 FROM integration_connections c
                 WHERE c.business_id = $1 LIMIT 1`,
        params: [biz.id, partyId],
      },
    ],
    "marketing_targets.party_id": [
      {
        sql: `INSERT INTO marketing_targets (business_id, location_id, site_label, party_id)
              VALUES ($1, $2, 'Merge target', $3)`,
        params: [biz.id, biz.locationId, partyId],
      },
    ],
    "customer_notes.customer_id": [
      {
        sql: `INSERT INTO customer_notes (business_id, customer_id, body, created_by)
                VALUES ($1, $2, 'یادداشت آزمایشی', 'آزمون')`,
        params: [biz.id, partyId],
      },
    ],
    "crm_activities.customer_id": [
      {
        sql: `INSERT INTO crm_activities (business_id, customer_id, kind, subject)
                VALUES ($1, $2, 'call', 'تماس آزمایشی')`,
        params: [biz.id, partyId],
      },
    ],
    "crm_consent_events.customer_id": [
      {
        sql: `INSERT INTO crm_consent_events (business_id, customer_id, channel, granted, source, actor)
                VALUES ($1, $2, 'sms', true, 'pos', 'آزمون')`,
        params: [biz.id, partyId],
      },
    ],
    // Phase G — «میز کار من». A project, a task inside it, a contract and a
    // document, all naming the losing customer. The task is the interesting
    // one: it has no `business_id` and reaches the tenant through its project,
    // which is the `parent` scope the registry grew for it.
    "ai_projects.party_id": [
      {
        sql: `INSERT INTO ai_projects (business_id, name, instructions, created_by, party_id)
                VALUES ($1, 'بازسازی شعبه', '', 'آزمون', $2)`,
        params: [biz.id, partyId],
      },
    ],
    "ai_project_tasks.party_id": [
      {
        sql: `INSERT INTO ai_projects (business_id, name, instructions, created_by)
                VALUES ($1, 'پروژهٔ میزبان کار', '', 'آزمون')`,
        params: [biz.id],
      },
      {
        sql: `INSERT INTO ai_project_tasks (project_id, title, created_by, party_id)
                SELECT p.id, 'پیگیری با مشتری', 'آزمون', $2 FROM ai_projects p
                 WHERE p.business_id = $1 AND p.name = 'پروژهٔ میزبان کار' LIMIT 1`,
        params: [biz.id, partyId],
      },
    ],
    "workspace_contracts.party_id": [
      {
        sql: `INSERT INTO workspace_contracts (business_id, title, contract_type, party_id, created_by)
                VALUES ($1, 'پیمان اجرایی', 'contractor', $2, 'آزمون')`,
        params: [biz.id, partyId],
      },
    ],
    "workspace_documents.party_id": [
      {
        sql: `INSERT INTO workspace_documents (business_id, title, party_id, created_by)
                VALUES ($1, 'اسکن قرارداد', $2, 'آزمون')`,
        params: [biz.id, partyId],
      },
    ],
    "orders.customer_id": [
      {
        sql: `INSERT INTO orders (location_id, customer_id, status, order_type)
                VALUES ($1, $2, 'open', 'dine_in')`,
        params: [biz.locationId, partyId],
      },
    ],
  };

  const plan = statements[`${table}.${column}`];
  if (!plan) return false;
  try {
    for (const statement of plan) await db.query(statement.sql, statement.params);
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE ${column} = $1`,
      [partyId],
    );
    return Number(rows[0].count) > 0;
  } catch (error) {
    // The WooCommerce mapping is the reference that caused the production
    // incident, so a seed failure there is a broken test, not a skip — hiding
    // it would quietly turn the most important assertion into a no-op.
    if (table === "integration_mappings" || table === "marketing_targets") throw error;
    // Anything else: a schema this seed does not understand is not this test's
    // business. The coverage assertions above are the part that must never be
    // skipped, and they do not depend on seeding.
    return false;
  }
}
