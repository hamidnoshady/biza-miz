/**
 * Phase 24 Wave 3 — field-level encryption at rest, against a real database.
 *
 * Three things are proved here, and only the first is about cryptography:
 *
 *  1. **The registry matches the schema.** `src/lib/encrypted-columns.ts` is
 *     asserted against `information_schema.columns`, the same mechanism
 *     `tenant-isolation.integration.test.ts` uses against `pg_policy`. A
 *     migration that drops an `_enc` column out from under the services, or
 *     adds a new plaintext PII column to `customers`/`reservations` without
 *     registering it, fails here instead of shipping.
 *  2. **The services actually encrypt.** A customer written through
 *     `parties-service.ts` is unreadable in the raw row and readable through
 *     the service, and exact-match phone lookup still works through the blind
 *     index.
 *  3. **The backfill is idempotent and resumable**, and the stale-ciphertext
 *     trigger from 0125 holds even for a writer that knows nothing about
 *     encryption.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";
import { SYSTEM_AI_READ_PERMISSIONS } from "../src/lib/ai-capabilities";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_fieldenc_test_role";
const APP_PASSWORD = "fieldenc-test-password";

let dbName: string;
let raw: Client; // superuser connection, for looking at what is really stored
let dbLib: typeof import("../src/lib/db");
let customers: typeof import("../src/lib/parties-service");
let backfill: typeof import("../scripts/encrypt-fields");
let masterKey: typeof import("../src/lib/master-key");
let businessKeys: typeof import("../src/lib/business-keys");

const biz = { id: "", locationId: "" };

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  dbName = `pos_fieldenc_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(dbName), quiet: true });

  // As an unprivileged role, not the owner. A superuser ignores RLS entirely,
  // which would make `exportTenantData` return every business's rows (it
  // relies on RLS alone to filter) and would hide whether
  // `business_encryption_keys` is reachable at all under the policy — the
  // exact bug 0126 exists to fix.
  await createAppRole({ databaseUrl: urlFor(dbName), roleName: APP_ROLE, password: APP_PASSWORD, quiet: true });

  // The KEK has to exist before any module memoises its absence.
  process.env.POS_MASTER_KEY = randomBytes(32).toString("base64");
  delete process.env.POS_MASTER_PASSPHRASE;
  process.env.DATABASE_URL = urlFor(dbName, { name: APP_ROLE, password: APP_PASSWORD });

  dbLib = await import("../src/lib/db");
  masterKey = await import("../src/lib/master-key");
  businessKeys = await import("../src/lib/business-keys");
  customers = await import("../src/lib/parties-service");
  backfill = await import("../scripts/encrypt-fields");
  masterKey.resetMasterKeyCache();

  raw = new Client({ connectionString: urlFor(dbName) });
  await raw.connect();

  const b = await raw.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Crypto Co', $1) RETURNING id",
    [`crypto-${randomUUID().slice(0, 8)}`],
  );
  biz.id = b.rows[0].id;
  const loc = await raw.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = loc.rows[0].id;
}, 120_000);

afterAll(async () => {
  await raw?.end();
  await dbLib?.getPool().end().catch(() => {});
  delete process.env.POS_MASTER_KEY;
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("the encrypted-column registry matches the live schema", () => {
  it("every registered ciphertext and blind-index column exists with the right type", async () => {
    const { encryptedPhysicalColumns, ENCRYPTED_TABLES } = await import("../src/lib/encrypted-columns");
    const { rows } = await raw.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const actual = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r.data_type]));

    for (const { table, column, dataType } of encryptedPhysicalColumns()) {
      expect(actual.get(`${table}.${column}`), `${table}.${column} is registered but missing`).toBe(dataType);
    }
    // And the plaintext twin each one shadows, for as long as step 3 of the
    // migration has not dropped it.
    for (const [table, spec] of Object.entries(ENCRYPTED_TABLES)) {
      for (const col of spec.columns) {
        expect(actual.has(`${table}.${col.column}`), `${table}.${col.column} is registered but missing`).toBe(true);
      }
    }
  });

  it("no unregistered PII column has appeared on an encrypted table", async () => {
    // The point of the registry: a future migration adding
    // `customers.secondary_phone` should fail here rather than quietly
    // shipping a plaintext phone number.
    const { ENCRYPTED_TABLES } = await import("../src/lib/encrypted-columns");
    const PII_NAME = /(phone|address|note)/;
    /** Registered, derived, or deliberately-plaintext columns. */
    const ALLOWED: Record<string, string[]> = {
      // The canonical +98… form (0118). Plaintext for now because duplicate
      // detection and segment resolution self-join on it; `phone_bidx` is its
      // designated replacement at step 3, when the plaintext columns go.
      customers: ["phone_e164"],
      // Migration 0137 renamed the table, so the party record inherits both of
      // customers' allowances and adds one of its own.
      parties: [
        "phone_e164",
        /*
         * The tab documents are the party's edited shape and are not in the
         * program at all: this registry is one spec per *scalar* column
         * (ciphertext plus its derived lookup columns), which a jsonb document
         * has no shape for. What the program does cover is the scalars the tabs
         * mirror — `address`/`address_enc`, `notes`/`notes_enc`,
         * `bank_account`/`bank_account_enc` — and those are registered below
         * rather than allowed here, so a new PII-shaped *scalar* still fails
         * this test the way it is meant to. Of the four tabs, `address_info` is
         * the only one whose name even reads as PII; the others are listed here
         * nowhere because they have nothing to allow.
         */
        "address_info",
      ],
      reservations: ["note"],
    };

    for (const [table, spec] of Object.entries(ENCRYPTED_TABLES)) {
      const registered = new Set(
        spec.columns.flatMap(
          (c) =>
            [c.column, c.encColumn, c.bidxColumn, c.last4Column, c.kindColumn].filter(Boolean) as string[],
        ),
      );
      const { rows } = await raw.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      const unregistered = rows
        .map((r) => r.column_name)
        .filter((c) => PII_NAME.test(c) && !registered.has(c) && !(ALLOWED[table] ?? []).includes(c));
      expect(unregistered, `unregistered PII-shaped column(s) on ${table}`).toEqual([]);
    }
  });

  it("business_encryption_keys is RLS-protected, honours the bypass, and is keyed per business", async () => {
    const { rows: policies } = await raw.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'business_encryption_keys'`,
    );
    expect(policies[0]?.relrowsecurity).toBe(true);
    expect(policies[0]?.relforcerowsecurity).toBe(true);

    // 0126. Without the bypass half of the predicate, the platform realm — and
    // therefore provisioning, which mints the key inside its own transaction —
    // cannot see or write this table at all as the app role.
    const { rows: expr } = await raw.query<{ using_expr: string; check_expr: string | null }>(
      `SELECT pg_get_expr(polqual, polrelid) AS using_expr,
              pg_get_expr(polwithcheck, polrelid) AS check_expr
         FROM pg_policy WHERE polrelid = 'business_encryption_keys'::regclass`,
    );
    expect(expr[0].using_expr).toContain("app_rls_bypass()");
    expect(expr[0].using_expr).toContain("app_current_business()");
    expect(expr[0].check_expr).toContain("app_rls_bypass()");

    const { rows: keyed } = await raw.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_constraint
        WHERE conrelid = 'business_encryption_keys'::regclass AND contype IN ('p', 'u')`,
    );
    expect(Number(keyed[0].count)).toBeGreaterThan(0);
  });
});

describe("per-business keys", () => {
  it("mints one key and reuses it", async () => {
    const first = await businessKeys.getBusinessDek(biz.id);
    businessKeys.clearBusinessDekCache();
    const second = await businessKeys.getBusinessDek(biz.id);
    expect(first).not.toBeNull();
    expect(first!.equals(second!)).toBe(true);

    const { rows } = await raw.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM business_encryption_keys WHERE business_id = $1",
      [biz.id],
    );
    expect(rows[0].count).toBe("1");
  });

  it("stores the key wrapped, never in the clear", async () => {
    const dek = (await businessKeys.getBusinessDek(biz.id))!;
    const { rows } = await raw.query<{ wrapped_dek: Buffer }>(
      "SELECT wrapped_dek FROM business_encryption_keys WHERE business_id = $1",
      [biz.id],
    );
    const wrapped = rows[0].wrapped_dek;
    expect(wrapped.includes(dek)).toBe(false);
    expect(wrapped.subarray(0, 7).toString("latin1")).toBe("POSKEK1");
  });

  it("gives two businesses different keys", async () => {
    const other = await raw.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
      [`crypto-other-${randomUUID().slice(0, 8)}`],
    );
    const a = await businessKeys.getBusinessDek(biz.id);
    const b = await businessKeys.getBusinessDek(other.rows[0].id);
    expect(a!.equals(b!)).toBe(false);
  });
});

/** `phone_last4` is only ever the last four digits — never a prefix bucket. */
async function query4(customerId: string): Promise<boolean> {
  const { rows } = await raw.query<{ phone: string; phone_last4: string | null }>(
    "SELECT phone, phone_last4 FROM parties WHERE id = $1",
    [customerId],
  );
  return rows[0].phone_last4 === rows[0].phone.slice(-4) && rows[0].phone_last4 !== rows[0].phone.slice(0, 4);
}

describe("parties-service reads and writes through the ciphertext", () => {
  it("stores the phone, address and notes encrypted, and reads them back in the clear", async () => {
    const created = await dbLib.withTenant(biz.id, () =>
      customers.createCustomer(biz.id, {
        name: "زهرا محمدی",
        phone: "09121234567",
        address: "تهران، خیابان ولیعصر",
        notes: "همیشه بدون شکر",
      }),
    );
    expect(created.phone).toBe("09121234567");
    expect(created.address).toBe("تهران، خیابان ولیعصر");

    const { rows } = await raw.query<{
      phone_enc: Buffer | null;
      phone_bidx: string | null;
      address_enc: Buffer | null;
      notes_enc: Buffer | null;
    }>("SELECT phone_enc, phone_bidx, address_enc, notes_enc FROM parties WHERE id = $1", [created.id]);
    expect(rows[0].phone_enc).not.toBeNull();
    expect(rows[0].phone_enc!.subarray(0, 7).toString("latin1")).toBe("POSFLD1");
    expect(rows[0].phone_enc!.toString("latin1")).not.toContain("09121234567");
    expect(rows[0].address_enc!.toString("utf8")).not.toContain("ولیعصر");
    expect(rows[0].notes_enc).not.toBeNull();
    expect(rows[0].phone_bidx).toMatch(/^[0-9a-f]{32}$/);

    const fetched = await dbLib.withTenant(biz.id, () => customers.getCustomer(biz.id, created.id));
    expect(fetched?.phone).toBe("09121234567");
    expect(fetched?.notes).toBe("همیشه بدون شکر");
  });

  it("finds a customer by their phone written any way, through the blind index", async () => {
    await dbLib.withTenant(biz.id, () =>
      customers.createCustomer(biz.id, { name: "علی رضایی", phone: "0912 765 4321" }),
    );
    for (const spelling of ["09127654321", "+989127654321", "0912 765 4321"]) {
      const found = await dbLib.withTenant(biz.id, () => customers.searchCustomers(biz.id, spelling));
      expect(found.map((c) => c.name)).toContain("علی رضایی");
    }
  });

  it("still finds a customer by the last four digits — the till workflow that survives step 3", async () => {
    // The one partial search a blind index cannot do, kept alive by
    // `phone_last4`. Asserted here rather than trusted, because right now the
    // plaintext `phone ILIKE` would answer this query too and hide a broken
    // `phone_last4` until the release that drops the plaintext column.
    const created = await dbLib.withTenant(biz.id, () =>
      customers.createCustomer(biz.id, { name: "چهار رقم", phone: "09129998877" }),
    );
    const { rows } = await raw.query<{ phone_last4: string | null }>(
      "SELECT phone_last4 FROM parties WHERE id = $1",
      [created.id],
    );
    expect(rows[0].phone_last4).toBe("8877");

    for (const typed of ["8877", "۸۸۷۷"]) {
      const found = await dbLib.withTenant(biz.id, () => customers.searchCustomers(biz.id, typed));
      expect(found.map((c) => c.name)).toContain("چهار رقم");
    }

    // …and the accepted loss is real: a prefix is not a search.
    const byPrefix = await dbLib.withTenant(biz.id, () =>
      query4(created.id),
    );
    expect(byPrefix).toBe(true);
  });

  it("re-encrypts on update instead of leaving a stale ciphertext", async () => {
    const created = await dbLib.withTenant(biz.id, () =>
      customers.createCustomer(biz.id, { name: "به‌روزرسانی", phone: "09120000001" }),
    );
    const updated = await dbLib.withTenant(biz.id, () =>
      customers.updateCustomer(biz.id, created.id, { phone: "09120000002" }),
    );
    expect(updated?.phone).toBe("09120000002");
    const again = await dbLib.withTenant(biz.id, () => customers.getCustomer(biz.id, created.id));
    expect(again?.phone).toBe("09120000002");
  });
});

describe("the backfill", () => {
  it("encrypts rows written straight to SQL, and is a no-op the second time", async () => {
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, phone, address, notes)
       VALUES ($1, 'Legacy Row', '09125550000', 'somewhere', 'legacy note') RETURNING id`,
      [biz.id],
    );
    const id = rows[0].id;

    const first = await backfill.backfillBusiness(biz.id);
    expect(first.encrypted).toBeGreaterThan(0);

    const after = await raw.query<{ phone_enc: Buffer | null; phone_bidx: string | null }>(
      "SELECT phone_enc, phone_bidx FROM parties WHERE id = $1",
      [id],
    );
    expect(after.rows[0].phone_enc).not.toBeNull();
    expect(after.rows[0].phone_bidx).not.toBeNull();

    // Resumable means "does not redo what is done": a second pass finds nothing.
    const second = await backfill.backfillBusiness(biz.id);
    expect(second.encrypted).toBe(0);

    const read = await dbLib.withTenant(biz.id, () => customers.getCustomer(biz.id, id));
    expect(read?.phone).toBe("09125550000");
    expect(read?.notes).toBe("legacy note");
  });

  it("repairs a row an unaware writer changed with a raw UPDATE", async () => {
    // The 0125 trigger nulls the ciphertext when a writer that knows nothing
    // about encryption changes the plaintext. The row then reads correct (from
    // the plaintext twin) rather than stale, and the next backfill re-encrypts
    // it — the property that lets the older writers in crm-service and the
    // integrations sync keep working untouched.
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, phone) VALUES ($1, 'Trigger Row', '09125551111') RETURNING id`,
      [biz.id],
    );
    const id = rows[0].id;
    await backfill.backfillBusiness(biz.id);

    await raw.query("UPDATE parties SET phone = '09125552222' WHERE id = $1", [id]);
    const invalidated = await raw.query<{
      phone_enc: Buffer | null;
      phone_bidx: string | null;
      phone_last4: string | null;
    }>("SELECT phone_enc, phone_bidx, phone_last4 FROM parties WHERE id = $1", [id]);
    expect(invalidated.rows[0].phone_enc).toBeNull();
    expect(invalidated.rows[0].phone_bidx).toBeNull();
    expect(invalidated.rows[0].phone_last4).toBeNull();

    const read = await dbLib.withTenant(biz.id, () => customers.getCustomer(biz.id, id));
    expect(read?.phone).toBe("09125552222");

    await backfill.backfillBusiness(biz.id);
    const reencrypted = await raw.query<{ phone_enc: Buffer | null }>(
      "SELECT phone_enc FROM parties WHERE id = $1",
      [id],
    );
    expect(reencrypted.rows[0].phone_enc).not.toBeNull();
  });

  it("fires the trigger for an upsert too, not only a plain UPDATE", async () => {
    // `INSERT … ON CONFLICT DO UPDATE` is the shape most unaware writers
    // actually use — crm-service's merge path among them. Postgres runs the
    // conflict branch as a real UPDATE, so the BEFORE UPDATE trigger should
    // apply, but "should" is not "does": prove it on the write shape the real
    // writers use rather than only on the one the test found convenient.
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, phone) VALUES ($1, 'Upsert Row', '09125554444') RETURNING id`,
      [biz.id],
    );
    const id = rows[0].id;
    await backfill.backfillBusiness(biz.id);
    const before = await raw.query<{ phone_enc: Buffer | null }>(
      "SELECT phone_enc FROM parties WHERE id = $1",
      [id],
    );
    expect(before.rows[0].phone_enc).not.toBeNull();

    await raw.query(
      `INSERT INTO parties (id, business_id, name, phone) VALUES ($1, $2, 'Upsert Row', '09125555555')
       ON CONFLICT (id) DO UPDATE SET phone = EXCLUDED.phone`,
      [id, biz.id],
    );

    const after = await raw.query<{ phone: string; phone_enc: Buffer | null; phone_bidx: string | null }>(
      "SELECT phone, phone_enc, phone_bidx FROM parties WHERE id = $1",
      [id],
    );
    expect(after.rows[0].phone).toBe("09125555555");
    expect(after.rows[0].phone_enc).toBeNull();
    expect(after.rows[0].phone_bidx).toBeNull();

    // And the row still reads correctly — the invalidation must never leave a
    // reader serving the pre-upsert number.
    const read = await dbLib.withTenant(biz.id, () => customers.getCustomer(biz.id, id));
    expect(read?.phone).toBe("09125555555");
    await backfill.backfillBusiness(biz.id);
  });

  it("encrypts reservations, whose tenancy runs through location_id rather than business_id", async () => {
    // Different RLS shape, different predicate in the backfill, and the place
    // an aliasing mistake in the batched UPDATE would hide.
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO reservations (location_id, customer_name, customer_phone, party_size, reserved_at)
       VALUES ($1, 'میهمان', '09126667777', 2, now() + interval '1 day') RETURNING id`,
      [biz.locationId],
    );
    await backfill.backfillBusiness(biz.id);

    const after = await raw.query<{ customer_phone_enc: Buffer | null; customer_phone_bidx: string | null }>(
      "SELECT customer_phone_enc, customer_phone_bidx FROM reservations WHERE id = $1",
      [rows[0].id],
    );
    expect(after.rows[0].customer_phone_enc).not.toBeNull();
    expect(after.rows[0].customer_phone_enc!.toString("latin1")).not.toContain("09126667777");

    // The blind index is the business's, not the branch's: the same number
    // saved as a customer must hash to the same value on a reservation, or
    // "find this caller's booking" breaks across branches.
    const dek = (await businessKeys.getBusinessDek(biz.id))!;
    const { phoneBlindIndex } = await import("../src/lib/field-crypto");
    expect(after.rows[0].customer_phone_bidx).toBe(phoneBlindIndex("09126667777", dek));

    const decrypted = await dbLib.withTenant(biz.id, () =>
      import("../src/lib/reservation-service").then((m) =>
        m.decryptReservationPhones(biz.id, [
          { customer_phone: null, customer_phone_enc: after.rows[0].customer_phone_enc },
        ]),
      ),
    );
    expect(decrypted[0].customer_phone).toBe("09126667777");
  });

  it("dry-run, then real, then nothing left: the resumability claim, run three times", async () => {
    await raw.query(
      `INSERT INTO parties (business_id, name, phone, address)
       VALUES ($1, 'Three Pass', '09125558888', 'jaie digar')`,
      [biz.id],
    );

    const dry = await backfill.backfillBusiness(biz.id, { dryRun: true });
    expect(dry.encrypted).toBeGreaterThan(0);

    const real = await backfill.backfillBusiness(biz.id);
    expect(real.encrypted).toBe(dry.encrypted);

    const again = await backfill.backfillBusiness(biz.id);
    expect(again.scanned).toBe(0);
    expect(again.encrypted).toBe(0);
  });

  it("drains a table larger than one batch", async () => {
    // The loop advances only because a written row stops matching
    // `col_enc IS NULL`. With a batch smaller than the table, a mistake there
    // is an infinite loop rather than a wrong answer — worth one real pass.
    for (let i = 0; i < 7; i++) {
      await raw.query(
        `INSERT INTO parties (business_id, name, phone) VALUES ($1, $2, $3)`,
        [biz.id, `Batch ${i}`, `0912666${String(i).padStart(4, "0")}`],
      );
    }
    const result = await backfill.backfillBusiness(biz.id, { batchSize: 2 });
    expect(result.encrypted).toBeGreaterThanOrEqual(7);
    expect((await backfill.backfillBusiness(biz.id)).encrypted).toBe(0);
  });

  it("leaves the database untouched on a dry run", async () => {
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, phone) VALUES ($1, 'Dry Run', '09125553333') RETURNING id`,
      [biz.id],
    );
    const result = await backfill.backfillBusiness(biz.id, { dryRun: true });
    expect(result.encrypted).toBeGreaterThan(0);
    const after = await raw.query<{ phone_enc: Buffer | null }>(
      "SELECT phone_enc FROM parties WHERE id = $1",
      [rows[0].id],
    );
    expect(after.rows[0].phone_enc).toBeNull();
    await backfill.backfillBusiness(biz.id);
  });
});

describe("duplicate detection after the phone_e164 → phone_bidx move", () => {
  it("finds a duplicate pair through the blind index, with encryption on", async () => {
    // crm-service and crm-overview now match on
    // `coalesce(phone_bidx, phone_e164)`. With a key configured every row has
    // a `phone_bidx`, so this exercises the new half of that expression — the
    // half the existing CRM integration test (which runs without a master
    // key) never reaches.
    const crm = await import("../src/lib/crm-service");
    const overview = await import("../src/lib/crm-overview");

    const dupBiz = await raw.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Dup Co', $1) RETURNING id",
      [`crypto-dup-${randomUUID().slice(0, 8)}`],
    );
    const dupId = dupBiz.rows[0].id;
    await raw.query("INSERT INTO locations (business_id, name) VALUES ($1, 'Main')", [dupId]);

    // Two spellings of one number, written through the service so both get a
    // blind index — the point being that they hash to the same value.
    await dbLib.withTenant(dupId, () =>
      customers.createCustomer(dupId, { name: "مشتری اول", phone: "09121110000" }),
    );
    await dbLib.withTenant(dupId, () =>
      customers.createCustomer(dupId, { name: "مشتری دوم", phone: "+98 912 111 0000" }),
    );

    const { rows: stored } = await raw.query<{ phone_bidx: string }>(
      "SELECT phone_bidx FROM parties WHERE business_id = $1",
      [dupId],
    );
    expect(new Set(stored.map((r) => r.phone_bidx)).size).toBe(1);

    const candidates = await dbLib.withTenant(dupId, () => crm.findDuplicates(dupId, { limit: 10 }));
    expect(candidates.some((c) => c.reason === "phone")).toBe(true);

    // The count beside the list has to agree with the list.
    const summary = await dbLib.withTenant(dupId, () => overview.crmOverview(dupId));
    expect(summary.duplicates).toBeGreaterThan(0);
  });
});

describe("phone_kind — 'can this number receive an SMS', once the number is ciphertext", () => {
  it("classifies on create and re-classifies on update", async () => {
    const mobile = await dbLib.withTenant(biz.id, () =>
      customers.createCustomer(biz.id, { name: "همراه", phone: "09123334444" }),
    );
    const landline = await dbLib.withTenant(biz.id, () =>
      customers.createCustomer(biz.id, { name: "ثابت", phone: "02112345678" }),
    );
    const noPhone = await dbLib.withTenant(biz.id, () =>
      customers.createCustomer(biz.id, { name: "بی‌شماره" }),
    );

    const kindOf = async (id: string) => {
      const { rows } = await raw.query<{ phone_kind: string | null }>(
        "SELECT phone_kind FROM parties WHERE id = $1",
        [id],
      );
      return rows[0].phone_kind;
    };
    expect(await kindOf(mobile.id)).toBe("mobile");
    expect(await kindOf(landline.id)).toBe("landline");
    // NULL, not 'unknown': nothing to classify is not the same as a number we
    // could not read, and only the second one is worth investigating.
    expect(await kindOf(noPhone.id)).toBeNull();

    await dbLib.withTenant(biz.id, () =>
      customers.updateCustomer(biz.id, mobile.id, { phone: "02133334444" }),
    );
    expect(await kindOf(mobile.id)).toBe("landline");
  });

  it("is nulled by the 0125 trigger and refilled by the backfill", async () => {
    // Same contract as phone_enc/phone_bidx/phone_last4: a writer that knows
    // nothing about encryption must not be able to leave a stale
    // classification behind, because a stale one is worse than none — it would
    // keep counting a number that is no longer there.
    const created = await dbLib.withTenant(biz.id, () =>
      customers.createCustomer(biz.id, { name: "طبقه‌بندی کهنه", phone: "09125556666" }),
    );
    await raw.query("UPDATE parties SET phone = '02155556666' WHERE id = $1", [created.id]);

    const stale = await raw.query<{ phone_kind: string | null; phone_bidx: string | null }>(
      "SELECT phone_kind, phone_bidx FROM parties WHERE id = $1",
      [created.id],
    );
    expect(stale.rows[0].phone_kind).toBeNull();
    expect(stale.rows[0].phone_bidx).toBeNull();

    await backfill.backfillBusiness(biz.id);
    const repaired = await raw.query<{ phone_kind: string | null }>(
      "SELECT phone_kind FROM parties WHERE id = $1",
      [created.id],
    );
    expect(repaired.rows[0].phone_kind).toBe("landline");
  });

  it("counts a mobile as SMS-reachable and a landline as not", async () => {
    // The bug this column exists for: `phone_e164 IS NOT NULL` means "parses
    // as an Iranian number", and a landline parses. Both rows below have a
    // phone_e164 and a phone_bidx, so neither of the two previous spellings of
    // this predicate could tell them apart.
    const crm = await import("../src/lib/crm-service");
    const overview = await import("../src/lib/crm-overview");

    const smsBiz = await raw.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('SMS Co', $1) RETURNING id",
      [`crypto-sms-${randomUUID().slice(0, 8)}`],
    );
    const smsId = smsBiz.rows[0].id;
    await raw.query("INSERT INTO locations (business_id, name) VALUES ($1, 'Main')", [smsId]);

    const mobile = await dbLib.withTenant(smsId, () =>
      customers.createCustomer(smsId, { name: "موبایل", phone: "09121112222" }),
    );
    const landline = await dbLib.withTenant(smsId, () =>
      customers.createCustomer(smsId, { name: "تلفن ثابت", phone: "02188889999" }),
    );
    await dbLib.withTenant(smsId, () => customers.createCustomer(smsId, { name: "بدون تلفن" }));
    for (const id of [mobile.id, landline.id]) {
      await raw.query("UPDATE parties SET sms_consent = true WHERE id = $1", [id]);
    }
    // Consent alone is not reachability, and the raw UPDATE above just proved
    // it does not disturb the classification (it does not touch `phone`).

    const coverage = await dbLib.withTenant(smsId, () => crm.consentCoverage(smsId));
    expect(coverage.total).toBe(3);
    expect(coverage.smsGranted).toBe(2);
    expect(coverage.withMobile).toBe(1);
    expect(coverage.smsReachable).toBe(1);

    const summary = await dbLib.withTenant(smsId, () => overview.crmOverview(smsId));
    expect(summary.consent.smsReachable).toBe(1);

    // Both halves of the predicate, separately.
    //
    // First the half that has to survive step 3: with `phone_e164` gone the
    // count may only come from `phone_kind`. (Nulling `phone_e164` alone does
    // not fire the 0125 trigger, which watches `phone` — so this leaves the
    // classification intact, which is the point.)
    await raw.query("UPDATE parties SET phone_e164 = NULL WHERE business_id = $1", [smsId]);
    const onKindAlone = await dbLib.withTenant(smsId, () => crm.consentCoverage(smsId));
    expect(onKindAlone.withMobile).toBe(1);
    expect(onKindAlone.smsReachable).toBe(1);

    // Then the fallback, for rows the backfill has not reached: no
    // classification, canonical number restored, and the shape rule in
    // `mobileReachableSql` has to reach the same verdict as `phone.ts` did.
    await raw.query(
      `UPDATE parties SET phone_kind = NULL,
              phone_e164 = CASE WHEN id = $2 THEN '+989121112222' ELSE '+982188889999' END
        WHERE business_id = $1 AND phone IS NOT NULL`,
      [smsId, mobile.id],
    );
    const onFallback = await dbLib.withTenant(smsId, () => crm.consentCoverage(smsId));
    expect(onFallback.withMobile).toBe(1);
    expect(onFallback.smsReachable).toBe(1);
  });
});

describe("the other two phone lookups converted in step 3's preparation", () => {
  it("the AI's find_customers matches an encrypted row through the blind index", async () => {
    const aiTools = await import("../src/lib/ai-tools");
    await dbLib.withTenant(biz.id, () =>
      customers.createCustomer(biz.id, { name: "جست‌وجوی هوشمند", phone: "09127778899" }),
    );

    for (const typed of ["09127778899", "+98 912 777 8899", "8899"]) {
      const result = await dbLib.withTenant(biz.id, () =>
        aiTools.runReadTool("find_customers", { query: typed }, biz.id, undefined, undefined, SYSTEM_AI_READ_PERMISSIONS),
      );
      const found = JSON.stringify(result);
      expect(found).toContain("جست‌وجوی هوشمند");
    }
  });

  it("the WooCommerce sync recognises a shopper whether or not their row is encrypted yet", async () => {
    // The reason `phoneMatchSql` falls back on `phone_e164` only for a row
    // with no blind index: mid-backfill, a miss here does not degrade a
    // suggestion, it creates a second copy of a real person.
    const sync = await import("../src/lib/integrations/sync-service");

    const encrypted = await dbLib.withTenant(biz.id, () =>
      customers.createCustomer(biz.id, { name: "خریدار رمزشده", phone: "09124445566" }),
    );
    const legacy = await raw.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, phone, phone_e164)
       VALUES ($1, 'خریدار قدیمی', '09126667788', '+989126667788') RETURNING id`,
      [biz.id],
    );
    const legacyId = legacy.rows[0].id;
    const { rows: legacyRow } = await raw.query<{ phone_bidx: string | null }>(
      "SELECT phone_bidx FROM parties WHERE id = $1",
      [legacyId],
    );
    expect(legacyRow[0].phone_bidx).toBeNull(); // the not-yet-backfilled state

    const connection = { id: randomUUID(), business_id: biz.id } as unknown as Parameters<
      typeof sync.resolveOrderCustomerId
    >[0];

    for (const [phone, expected] of [
      ["09124445566", encrypted.id],
      ["+98 912 444 5566", encrypted.id],
      ["09126667788", legacyId],
    ] as const) {
      const resolved = await dbLib.withTenant(biz.id, () =>
        sync.resolveOrderCustomerId(connection, { customer_id: 0, billing: { phone } }),
      );
      expect(resolved).toBe(expected);
    }
  });
});

describe("tenant export", () => {
  it("decrypts on the way out and never emits ciphertext", async () => {
    const tenantExport = await import("../src/lib/tenant-export");
    const tables = await tenantExport.exportTenantData(biz.id);
    const exported = tables.find((t) => t.name === "parties")!;

    expect(exported.columns).not.toContain("phone_enc");
    expect(exported.columns).not.toContain("phone_bidx");
    const phones = exported.rows.map((r) => r.phone);
    expect(phones).toContain("09121234567");
    for (const row of exported.rows) {
      expect(Buffer.isBuffer(row.phone)).toBe(false);
    }
  });
});
