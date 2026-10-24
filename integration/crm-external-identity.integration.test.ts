/**
 * The Website → CRM identity boundary.
 *
 * Two bugs are pinned here, both of which were silent in production:
 *
 * 1. **The online store wrote the customer directory directly.**
 *    `upsertCustomerFromWoo` INSERTed and UPDATEd `parties`, so a shopper
 *    typing into a checkout form rewrote the shop's own record of them, and
 *    the Website app owned data that `APP_DATA_RULES` assigns to the CRM.
 *
 * 2. **Ambiguous identity was resolved by `ORDER BY created_at LIMIT 1`.**
 *    When two customers shared a billing phone — a family, a couple, a shared
 *    work number — the sync attached the order to whichever record was older.
 *    Nothing threw. The purchase entered the wrong person's spend history, RFM
 *    score, and every segment and campaign built on them.
 *
 * The third property is not a bug fix but a rule that must never erode:
 * **buying something is not consent to be marketed to.** No import or sync
 * path may grant it, however the remote payload is phrased.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let identity: typeof import("../src/lib/crm-external-identity");
let sync: typeof import("../src/lib/integrations/sync-service");

const biz = { id: "", locationId: "", connectionId: "" };

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
  databaseName = `pos_extid_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  identity = await import("../src/lib/crm-external-identity");
  sync = await import("../src/lib/integrations/sync-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry)
     VALUES ('فروشگاه آنلاین', $1, 'food_service') RETURNING id`,
    [`extid-${randomUUID().slice(0, 8)}`],
  );
  biz.id = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ اصلی') RETURNING id`,
    [biz.id],
  );
  biz.locationId = location.rows[0].id;
  const connection = await db.query<{ id: string }>(
    `INSERT INTO integration_connections
       (business_id, provider, name, link_mode, base_url,
        webhook_secret_ciphertext, consumer_key_ciphertext, consumer_secret_ciphertext)
     VALUES ($1, 'woocommerce', 'فروشگاه', 'rest_api', 'https://shop.test', 'w', 'ck', 'cs')
     RETURNING id`,
    [biz.id],
  );
  biz.connectionId = connection.rows[0].id;
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

beforeEach(async () => {
  await db.query(`DELETE FROM integration_mappings WHERE business_id = $1 AND entity_type = 'customer'`, [biz.id]);
  await db.query(`DELETE FROM crm_external_profiles WHERE business_id = $1`, [biz.id]);
  await db.query(`DELETE FROM crm_audit_events WHERE business_id = $1`, [biz.id]);
  await db.query(`DELETE FROM parties WHERE business_id = $1`, [biz.id]);
});

async function makeCustomer(
  name: string,
  fields: { phone?: string; email?: string; address?: string } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, roles, phone, phone_e164, email, address)
     VALUES ($1, $2, ARRAY['customer']::text[], $3, $3, $4, $5) RETURNING id`,
    [biz.id, name, fields.phone ?? null, fields.email ?? null, fields.address ?? null],
  );
  return rows[0].id;
}

function wooCustomer(overrides: Record<string, unknown> = {}) {
  return {
    businessId: biz.id,
    connectionId: biz.connectionId,
    remoteId: "1001",
    name: "سارا محمدی",
    email: "sara@example.test",
    phone: "+989121112233",
    address: "تهران",
    ...overrides,
  };
}

describe("ambiguous external identity", () => {
  it("refuses to guess when two customers share a phone number", async () => {
    // A family on one mobile number. Both are real customers; neither is the
    // obvious owner of an online order placed with that number.
    const mother = await makeCustomer("مادر", { phone: "+989121112233" });
    const daughter = await makeCustomer("دختر", { phone: "+989121112233" });

    const result = await identity.reconcileExternalIdentity(wooCustomer(), {
      allowCreate: true,
    });

    // The whole point: no link, and specifically not a link to the older row.
    expect(result.partyId).toBeNull();
    expect(result.status).toBe("needs_review");
    expect(result.reason).toBe("ambiguous_identity");
    expect(result.created).toBe(false);

    // Both candidates are offered, so the review screen can present a choice
    // rather than making the reviewer go and search for them.
    const candidateIds = result.candidates.map((candidate) => candidate.partyId).sort();
    expect(candidateIds).toEqual([mother, daughter].sort());

    // And nothing was invented on the side.
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM parties WHERE business_id = $1`,
      [biz.id],
    );
    expect(Number(rows[0].count)).toBe(2);
  });

  it("does not re-guess on the next sync, and does not undo a human's parking", async () => {
    await makeCustomer("مادر", { phone: "+989121112233" });
    await makeCustomer("دختر", { phone: "+989121112233" });

    const first = await identity.reconcileExternalIdentity(wooCustomer(), { allowCreate: true });
    expect(first.status).toBe("needs_review");

    // A second sync run — the common case, since syncs are periodic.
    const second = await identity.reconcileExternalIdentity(wooCustomer(), { allowCreate: true });
    expect(second.partyId).toBeNull();
    expect(second.status).toBe("needs_review");
    expect(second.reason).toBe("awaiting_human_decision");
  });

  it("links automatically when exactly one customer matches", async () => {
    // One candidate is not a guess, and demanding confirmation for thousands
    // of these guarantees nobody confirms any of them.
    const only = await makeCustomer("سارا محمدی", { phone: "+989121112233" });

    const result = await identity.reconcileExternalIdentity(wooCustomer(), { allowCreate: true });

    expect(result.partyId).toBe(only);
    expect(result.status).toBe("auto_matched");
    expect(result.confidence).toBeGreaterThanOrEqual(90);
    expect(result.created).toBe(false);
  });

  it("a human's decision is what turns an ambiguous profile into a link", async () => {
    const mother = await makeCustomer("مادر", { phone: "+989121112233" });
    await makeCustomer("دختر", { phone: "+989121112233" });

    const parked = await identity.reconcileExternalIdentity(wooCustomer(), { allowCreate: true });
    expect(parked.partyId).toBeNull();

    const resolved = await identity.resolveExternalProfile(
      biz.id,
      parked.profileId,
      { action: "link", partyId: mother },
      { name: "مدیر فروشگاه" },
    );

    expect(resolved?.partyId).toBe(mother);
    expect(resolved?.status).toBe("confirmed");

    // The decision is attributable. Six months later somebody will ask why
    // this person's purchases are attached to that record.
    const { rows } = await db.query<{ kind: string; actor_name: string; party_id: string }>(
      `SELECT kind, actor_name, party_id FROM crm_audit_events
        WHERE business_id = $1 AND entity_id = $2`,
      [biz.id, parked.profileId],
    );
    expect(rows.map((row) => row.kind)).toContain("external.conflict_resolved");
    expect(rows[0].actor_name).toBe("مدیر فروشگاه");
    expect(rows[0].party_id).toBe(mother);
  });

  it("cannot be linked to another business's customer", async () => {
    // Both ids arrive from a browser. Tenancy has to be proven, not assumed.
    const other = await db.query<{ id: string }>(
      `INSERT INTO businesses (name, slug, industry)
       VALUES ('رقیب', $1, 'food_service') RETURNING id`,
      [`rival-${randomUUID().slice(0, 8)}`],
    );
    const stranger = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, roles)
       VALUES ($1, 'مشتری رقیب', ARRAY['customer']::text[]) RETURNING id`,
      [other.rows[0].id],
    );

    await makeCustomer("مادر", { phone: "+989121112233" });
    await makeCustomer("دختر", { phone: "+989121112233" });
    const parked = await identity.reconcileExternalIdentity(wooCustomer(), { allowCreate: true });

    const resolved = await identity.resolveExternalProfile(
      biz.id,
      parked.profileId,
      { action: "link", partyId: stranger.rows[0].id },
      { name: "مهاجم" },
    );
    expect(resolved).toBeNull();

    const { rows } = await db.query<{ party_id: string | null }>(
      `SELECT party_id FROM crm_external_profiles WHERE id = $1`,
      [parked.profileId],
    );
    expect(rows[0].party_id).toBeNull();
  });
});

describe("the store never overwrites the shop's own record", () => {
  it("fills a blank field but records a disagreement instead of clobbering", async () => {
    // The shop knows this person's address from a counter sale. A checkout
    // form typed a different one — that is a fact to review, not a correction.
    const customer = await makeCustomer("سارا محمدی", {
      phone: "+989121112233",
      address: "تهران، خیابان اول",
    });

    const result = await identity.reconcileExternalIdentity(
      wooCustomer({ address: "کرج، خیابان دوم", email: "sara@example.test" }),
      { allowCreate: true },
    );
    expect(result.partyId).toBe(customer);
    expect(result.status).toBe("conflict");

    const { rows } = await db.query<{ address: string; email: string }>(
      `SELECT address, email FROM parties WHERE id = $1`,
      [customer],
    );
    // Address disagreed: untouched.
    expect(rows[0].address).toBe("تهران، خیابان اول");
    // Email was blank: filled, because that is new information, not a
    // contradiction.
    expect(rows[0].email).toBe("sara@example.test");

    const { rows: profiles } = await db.query<{ conflicts: { field: string }[] }>(
      `SELECT conflicts FROM crm_external_profiles WHERE id = $1`,
      [result.profileId],
    );
    expect(profiles[0].conflicts.map((conflict) => conflict.field)).toEqual(["address"]);
  });

  it("does not report a conflict for the same phone written differently", async () => {
    // «۰۹۱۲…» versus «+98912…» is one number typed two ways. Flagging it would
    // put every customer in the review queue on every sync and bury the real
    // disagreements.
    const customer = await makeCustomer("سارا محمدی", { phone: "+989121112233" });
    const result = await identity.reconcileExternalIdentity(
      wooCustomer({ phone: "09121112233" }),
      { allowCreate: true },
    );

    expect(result.partyId).toBe(customer);
    expect(result.status).toBe("auto_matched");
  });

  it("only overwrites when a person explicitly accepts the remote value", async () => {
    const customer = await makeCustomer("سارا محمدی", {
      phone: "+989121112233",
      address: "تهران، خیابان اول",
    });
    const result = await identity.reconcileExternalIdentity(
      wooCustomer({ address: "کرج، خیابان دوم" }),
      { allowCreate: true },
    );

    await identity.resolveExternalProfile(
      biz.id,
      result.profileId,
      { action: "accept_conflicts" },
      { name: "مدیر" },
    );

    const { rows } = await db.query<{ address: string }>(
      `SELECT address FROM parties WHERE id = $1`,
      [customer],
    );
    expect(rows[0].address).toBe("کرج، خیابان دوم");
  });
});

describe("customer mapping and repeat sync integrity", () => {
  it("persists a visible conflict when an already-linked remote profile changes", async () => {
    await makeCustomer("سارا محمدی", {
      phone: "+989121112233",
      email: "sara@example.test",
      address: "تهران",
    });

    const first = await identity.reconcileExternalIdentity(wooCustomer(), { allowCreate: true });
    expect(first.status).toBe("auto_matched");

    const refreshed = await identity.reconcileExternalIdentity(
      wooCustomer({ name: "نام متفاوت", remoteUpdatedAt: "2026-10-12T10:00:00Z" }),
      { allowCreate: true },
    );
    expect(refreshed.status).toBe("conflict");

    // A legacy event without a source timestamp cannot replace a newer
    // timestamped snapshot simply because it arrived later.
    await identity.reconcileExternalIdentity(
      wooCustomer({ name: "stale event without date", remoteUpdatedAt: null }),
      { allowCreate: true },
    );
    const { rows } = await db.query<{
      status: string;
      conflicts: { field: string }[];
      remote_name: string;
      remote_updated_at: string;
    }>(
      `SELECT status, conflicts, remote_name, remote_updated_at::text AS remote_updated_at
         FROM crm_external_profiles WHERE id = $1`,
      [first.profileId],
    );
    expect(rows[0].status).toBe("conflict");
    expect(rows[0].remote_name).toBe("نام متفاوت");
    expect(rows[0].remote_updated_at).toContain("2026-10-12");
    expect(rows[0].conflicts.map((conflict) => conflict.field)).toContain("name");
  });

  it("keeps a deletion tombstone for stale versions but restores only a genuinely newer snapshot", async () => {
    const initial = await identity.reconcileExternalIdentity(
      wooCustomer({ remoteId: "9300", name: "Before remote deletion", remoteUpdatedAt: "2026-10-19T10:00:00Z" }),
      { allowCreate: true },
    );
    const deletedAt = new Date().toISOString();
    await identity.markWooCustomerDeleted(biz.id, biz.connectionId, "9300", deletedAt);

    const stale = await identity.reconcileExternalIdentity(
      wooCustomer({ remoteId: "9300", name: "Stale pre-deletion snapshot", remoteUpdatedAt: new Date(Date.parse(deletedAt) - 60_000).toISOString() }),
      { allowCreate: true },
    );
    expect(stale.remoteDeletedAt).toBeTruthy();

    const restoredAt = new Date(Date.parse(deletedAt) + 60_000).toISOString();
    const restored = await identity.reconcileExternalIdentity(
      wooCustomer({ remoteId: "9300", name: "Restored account", remoteUpdatedAt: restoredAt }),
      { allowCreate: true },
    );
    expect(restored.remoteDeletedAt).toBeFalsy();
    expect(restored.partyId).toBe(initial.partyId);
    const { rows } = await db.query<{ remote_name: string; remote_deleted_at: string | null }>(
      `SELECT remote_name, remote_deleted_at FROM crm_external_profiles WHERE id = $1`,
      [initial.profileId],
    );
    expect(rows[0].remote_name).toBe("Restored account");
    expect(rows[0].remote_deleted_at).toBeNull();
  });

  it("creates or removes the legacy Woo mapping in the same human decision", async () => {
    const profile = await identity.reconcileExternalIdentity(
      wooCustomer({ remoteId: "9001", name: "Shop record", email: null, phone: null }),
      { allowCreate: false },
    );
    const partyId = await makeCustomer("CRM record");

    await identity.resolveExternalProfile(
      biz.id,
      profile.profileId,
      { action: "link", partyId },
      { name: "مدیر فروشگاه" },
    );

    const { rows: linked } = await db.query<{ local_id: string }>(
      `SELECT local_id FROM integration_mappings
        WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'customer' AND remote_id = $3`,
      [biz.id, biz.connectionId, "9001"],
    );
    expect(linked[0]?.local_id).toBe(partyId);

    await identity.resolveExternalProfile(
      biz.id,
      profile.profileId,
      { action: "ignore" },
      { name: "مدیر فروشگاه" },
    );

    const { rows: ignoredMapping } = await db.query(
      `SELECT 1 FROM integration_mappings
        WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'customer' AND remote_id = $3`,
      [biz.id, biz.connectionId, "9001"],
    );
    expect(ignoredMapping).toHaveLength(0);
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'customer', '9001', $3)`,
      [biz.id, biz.connectionId, partyId],
    );
    expect(
      await sync.resolveOrderCustomerId(
        { id: biz.connectionId, business_id: biz.id } as never,
        { customer_id: 9001 },
      ),
    ).toBeNull();
  });

  it("does not let an order billing snapshot overwrite or auto-link an unresolved store profile", async () => {
    const localParty = await makeCustomer("Local billing owner", { email: "billing-owner@example.test" });
    const profile = await identity.reconcileExternalIdentity(
      wooCustomer({ remoteId: "9200", name: "Current store snapshot", email: null, phone: null }),
      { allowCreate: false },
    );

    const resolved = await sync.resolveOrderCustomerId(
      { id: biz.connectionId, business_id: biz.id } as never,
      {
        customer_id: 9200,
        billing: {
          first_name: "Historical",
          last_name: "Billing Owner",
          email: "billing-owner@example.test",
          phone: "",
        },
      } as never,
    );
    expect(resolved).toBeNull();

    const { rows } = await db.query<{ party_id: string | null; remote_name: string; remote_email: string | null }>(
      `SELECT party_id, remote_name, remote_email FROM crm_external_profiles WHERE id = $1`,
      [profile.profileId],
    );
    expect(rows[0]).toEqual({ party_id: null, remote_name: "Current store snapshot", remote_email: null });
    const { rows: partyRows } = await db.query<{ id: string }>(
      `SELECT id FROM parties WHERE business_id = $1`,
      [biz.id],
    );
    expect(partyRows.map((row) => row.id)).toEqual([localParty]);
  });

  it("keeps an empty-identity Woo account in the mirror without creating a fake party", async () => {
    await sync.upsertCustomerFromWoo(
      { id: biz.connectionId, business_id: biz.id } as never,
      {
        id: 713,
        email: "",
        first_name: "",
        last_name: "",
        billing: { phone: "" },
      },
    );

    const { rows: profiles } = await db.query<{ remote_name: string; status: string; party_id: string | null }>(
      `SELECT remote_name, status, party_id FROM crm_external_profiles
        WHERE business_id = $1 AND connection_id = $2 AND remote_id = '713'`,
      [biz.id, biz.connectionId],
    );
    expect(profiles[0]).toMatchObject({ remote_name: "", status: "unmapped", party_id: null });
    const { rows: parties } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM parties WHERE business_id = $1`,
      [biz.id],
    );
    expect(Number(parties[0].count)).toBe(0);
  });
});

describe("consent is never manufactured by a sync", () => {
  it("a new customer created from an online order has granted nothing", async () => {
    const result = await identity.reconcileExternalIdentity(
      wooCustomer({
        // Every shape of "they agreed" a store might send. None of them is
        // consent obtained by this business, and none may be honoured: the
        // audit trail has to say who obtained it and how.
        payload: {
          marketing_opt_in: true,
          accepts_marketing: true,
          meta_data: [{ key: "sms_consent", value: "yes" }],
        },
      }),
      { allowCreate: true },
    );

    expect(result.created).toBe(true);
    expect(result.partyId).not.toBeNull();

    const { rows } = await db.query<{ sms_consent: boolean; marketing_consent: boolean }>(
      `SELECT sms_consent, marketing_consent FROM parties WHERE id = $1`,
      [result.partyId],
    );
    expect(rows[0].sms_consent).toBe(false);
    expect(rows[0].marketing_consent).toBe(false);

    // And no consent event was fabricated either — an empty audit trail is the
    // honest record of a consent nobody ever gave.
    const { rows: events } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM crm_consent_events
        WHERE business_id = $1 AND customer_id = $2`,
      [biz.id, result.partyId],
    );
    expect(Number(events[0].count)).toBe(0);
  });

  it("syncing an existing customer cannot upgrade their consent", async () => {
    const customer = await makeCustomer("سارا محمدی", { phone: "+989121112233" });
    await db.query(
      `UPDATE parties SET sms_consent = false, marketing_consent = false WHERE id = $1`,
      [customer],
    );

    await identity.reconcileExternalIdentity(
      wooCustomer({ payload: { accepts_marketing: true } }),
      { allowCreate: true },
    );

    const { rows } = await db.query<{ sms_consent: boolean; marketing_consent: boolean }>(
      `SELECT sms_consent, marketing_consent FROM parties WHERE id = $1`,
      [customer],
    );
    expect(rows[0].sms_consent).toBe(false);
    expect(rows[0].marketing_consent).toBe(false);
  });
});

describe("order import", () => {
  it("does not invent a record for someone there is nothing to identify", async () => {
    // `allowCreate: false` is the guard for callers that must never add a
    // person. A record with no phone, no email and no name is a ghost: it can
    // never be matched, deduplicated or contacted, and it pollutes every count
    // in the CRM. The order's note already carries whatever the buyer typed.
    const result = await identity.reconcileExternalIdentity(
      wooCustomer({ remoteId: "guest:anonymous", name: "", email: null, phone: null }),
      { allowCreate: true },
    );

    expect(result.partyId).toBeNull();
    expect(result.reason).toBe("insufficient_identity");

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM parties WHERE business_id = $1`,
      [biz.id],
    );
    expect(Number(rows[0].count)).toBe(0);
  });

  it("creates a record for a genuinely new buyer, because that is not a guess", async () => {
    // The fix was never "stop creating customers" — an online buyer who
    // matches nobody is new, and linking the sale to them is what puts it in
    // the customer file, the RFM population and Growth's segments. The bug was
    // picking one when the system could not tell, and that is what
    // needs_review exists for.
    const result = await identity.reconcileExternalIdentity(
      wooCustomer({ remoteId: "2002", name: "مریم کریمی", phone: "+989123456789" }),
      { allowCreate: true },
    );

    expect(result.created).toBe(true);
    expect(result.partyId).not.toBeNull();
    expect(result.status).toBe("confirmed");

    // Provenance is stamped, so "how many customers did the store bring us?"
    // has a real answer rather than a guess based on who happens to have an
    // email address.
    const { rows } = await db.query<{ acquisition_source: string; name: string }>(
      `SELECT acquisition_source, name FROM parties WHERE id = $1`,
      [result.partyId],
    );
    expect(rows[0].acquisition_source).toBe("woocommerce");
    expect(rows[0].name).toBe("مریم کریمی");
  });

  it("does not create a second record when the buyer is parked for review", async () => {
    // The interaction that matters: ambiguity outranks creation. Faced with
    // two candidates the sync must park the profile, not sidestep the question
    // by making a third record — which would turn one ambiguous person into a
    // guaranteed duplicate.
    await makeCustomer("مادر", { phone: "+989121112233" });
    await makeCustomer("دختر", { phone: "+989121112233" });

    const result = await identity.reconcileExternalIdentity(wooCustomer(), { allowCreate: true });
    expect(result.status).toBe("needs_review");
    expect(result.created).toBe(false);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM parties WHERE business_id = $1`,
      [biz.id],
    );
    expect(Number(rows[0].count)).toBe(2);
  });

  it("attaches the order when the guest's phone matches exactly one customer", async () => {
    const known = await makeCustomer("مشتری قدیمی", { phone: "+989129998877" });
    const result = await identity.reconcileExternalIdentity(
      wooCustomer({ remoteId: "guest:+989129998877", phone: "+989129998877", email: null }),
      { allowCreate: true },
    );
    expect(result.partyId).toBe(known);
    expect(result.created).toBe(false);
  });
});
