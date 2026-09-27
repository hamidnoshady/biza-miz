/**
 * The shared party record, against a real database.
 *
 * `parties` is the table four apps now read, and the properties that matter are the
 * ones only SQL can show:
 *
 * 1. **One identity per business.** A customer's national ID is unique inside their
 *    own business and freely reusable in the next one; the accounting code is
 *    allocated per business and per role, from the prefix the chart of accounts
 *    expects, and a code a person typed by hand is refused when it is taken.
 * 2. **A tab the request did not mention is a tab nobody touched.** The whole
 *    partial-write story of `updateParty` — the ledger keeps its bank details when
 *    the POS fixes a phone number — is one `jsonb` merge, and a merge that is wrong
 *    loses a person's IBAN silently.
 * 3. **A party with history cannot be deleted.** `removeParty` archives instead of
 *    deleting, and the test proves it with a real row in a real referencing table
 *    rather than with a mock that would accept either answer.
 * 4. **The role filter is a view, not a permission, and it is real.** A store's
 *    supplier list must not contain the CRM's customers, and archiving a party must
 *    hide it from every app at once.
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
let dbLib: typeof import("../src/lib/db");
let parties: typeof import("../src/lib/parties-service");

const biz = { id: "", locationId: "" };
const other = { id: "", locationId: "" };

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
  databaseName = `pos_parties_${randomUUID().replaceAll("-", "")}`;
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
  parties = await import("../src/lib/parties-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  // Children first: `parties.category_id` and `suppliers.party_id` both point at
  // rows this suite creates, and `users.business_id` holds the membership an
  // employee party is linked to.
  await db.query("DELETE FROM suppliers");
  await db.query("DELETE FROM party_categories");
  await db.query("DELETE FROM parties");
  await db.query("DELETE FROM media_assets");
  await db.query("DELETE FROM user_locations");
  await db.query("DELETE FROM users");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");

  for (const [target, name] of [
    [biz, "Party Co"],
    [other, "Rival Co"],
  ] as const) {
    const business = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, 'food_service') RETURNING id",
      [name, `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 8)}`],
    );
    target.id = business.rows[0].id;
    const location = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
      [target.id],
    );
    target.locationId = location.rows[0].id;
  }
});

describe("creating a party", () => {
  it("allocates the accounting code from the role's prefix, per business", async () => {
    const first = await parties.createParty(biz.id, { role: "Customer", displayName: "نانوایی شرق" });
    const second = await parties.createParty(biz.id, { role: "Customer", displayName: "نانوایی غرب" });
    const supplier = await parties.createParty(biz.id, { role: "Supplier", displayName: "شرکت لبنیات" });
    const employee = await parties.createParty(biz.id, { role: "Employee", displayName: "مریم رضایی" });

    expect(first.accountingCode).toBe("100001");
    expect(second.accountingCode).toBe("100002");
    // Each role counts in its own series — the ledger reads the prefix, not a shared counter.
    expect(supplier.accountingCode).toBe("200001");
    expect(employee.accountingCode).toBe("300001");
    expect(first.accountingCodeMode).toBe("Automatic");

    // And the next business starts from the top of its own series again.
    const rival = await parties.createParty(other.id, { role: "Customer", displayName: "نانوایی رقیب" });
    expect(rival.accountingCode).toBe("100001");
  });

  it("keeps a manual code, and refuses one that is taken", async () => {
    await parties.createParty(biz.id, {
      role: "Supplier",
      displayName: "قصابی مرکزی",
      accountingCode: "200042",
      accountingCodeMode: "Manual",
    });
    await expect(
      parties.createParty(biz.id, {
        role: "Supplier",
        displayName: "قصابی شمال",
        accountingCode: "200042",
        accountingCodeMode: "Manual",
      }),
    ).rejects.toMatchObject({ code: "accounting_code_taken" });
    // A manual code is kept, not replaced by the next free automatic one.
    const row = await db.query<{ code: string }>(
      "SELECT accounting_code AS code FROM parties WHERE business_id = $1 AND name = $2",
      [biz.id, "قصابی مرکزی"],
    );
    expect(row.rows[0].code).toBe("200042");
  });

  it("requires a manual mode to carry a code", async () => {
    await expect(
      parties.createParty(biz.id, { role: "Customer", displayName: "بی‌کد", accountingCodeMode: "Manual" }),
    ).rejects.toMatchObject({ code: "accounting_code_required" });
  });

  it("derives the display name from the parts when none was given", async () => {
    const created = await parties.createParty(biz.id, {
      role: "Customer",
      firstName: "حسین",
      lastName: "کاظمی",
    });
    expect(created.displayName).toBe("حسین کاظمی");
  });

  it("normalizes a Persian mobile into the searchable column", async () => {
    const created = await parties.createParty(biz.id, {
      role: "Customer",
      displayName: "با موبایل فارسی",
      contactInfo: { mobile: "۰۹۱۲۳۴۵۶۷۸۹" },
    });
    // What was typed is what is kept: the canonical forms the search compares on
    // (`phone_e164`, the blind index, the last four) are derived beside it, which is
    // how the number stayed searchable without rewriting anybody's digits.
    expect(created.phone).toBe("۰۹۱۲۳۴۵۶۷۸۹");

    // The POS types Latin digits, the CRM's search box accepts whatever a person
    // pastes; both must find the row.
    expect((await parties.searchParties(biz.id, "09123456789")).map((row) => row.id)).toContain(created.id);
    expect((await parties.searchParties(biz.id, "۰۹۱۲۳۴۵۶۷۸۹")).map((row) => row.id)).toContain(created.id);
    expect((await parties.searchParties(biz.id, "+98 912 345 6789")).map((row) => row.id)).toContain(created.id);
  });

  it("keeps a national ID unique inside one business and free in the next", async () => {
    await parties.createParty(biz.id, {
      role: "Customer",
      displayName: "صاحب کد ملی",
      generalInfo: { nationalId: "0084575980" },
    });
    await expect(
      parties.createParty(biz.id, {
        role: "Customer",
        displayName: "همین آدم دوباره",
        generalInfo: { nationalId: "0084575980" },
      }),
    ).rejects.toMatchObject({ code: "national_id_taken" });

    const rival = await parties.createParty(other.id, {
      role: "Customer",
      displayName: "مشابه در کسب‌وکار دیگر",
      generalInfo: { nationalId: "0084575980" },
    });
    expect(rival.generalInfo.nationalId).toBe("0084575980");
  });
});

describe("profile image validation (server-side trust boundary)", () => {
  // A real PNG signature — the byte-signature check (hasMatchingMediaSignature,
  // shared with the Media Library) only inspects the header, so this is
  // enough without pulling in a real decodable image for the test.
  const pngBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32, 7),
  ]);
  const realPngDataUrl = `data:image/png;base64,${pngBytes.toString("base64")}`;

  it("accepts a data URL whose bytes really are the image it claims to be", async () => {
    const party = await parties.createParty(biz.id, {
      role: "Customer",
      displayName: "آواتار معتبر",
      profileImage: realPngDataUrl,
    });
    expect(party.profileImage).toBe(realPngDataUrl);
  });

  it("accepts an https:// linked avatar (no bytes to check)", async () => {
    const party = await parties.createParty(biz.id, {
      role: "Customer",
      displayName: "آواتار لینک‌شده",
      profileImage: "https://example.com/avatar.png",
    });
    expect(party.profileImage).toBe("https://example.com/avatar.png");
  });

  it("refuses a data URL declaring image/png whose bytes are not a PNG at all — the trust boundary this session added", async () => {
    const fakePng = `data:image/png;base64,${Buffer.from("this is not a png").toString("base64")}`;
    await expect(
      parties.createParty(biz.id, { role: "Customer", displayName: "آواتار جعلی", profileImage: fakePng }),
    ).rejects.toMatchObject({ code: "invalid_image", field: "profileImage" });
  });

  it("refuses a value that is not a data URL or an http(s) link at all", async () => {
    await expect(
      parties.createParty(biz.id, {
        role: "Customer",
        displayName: "آواتار بی‌شکل",
        profileImage: "javascript:alert(1)",
      }),
    ).rejects.toMatchObject({ code: "invalid_image", field: "profileImage" });
  });

  it("also enforces the byte signature on update, not just create", async () => {
    const created = await parties.createParty(biz.id, { role: "Customer", displayName: "به‌روزرسانی آواتار" });
    const fakeJpeg = `data:image/jpeg;base64,${Buffer.from("not a jpeg either").toString("base64")}`;
    await expect(
      parties.updateParty(biz.id, created.id, { profileImage: fakeJpeg }),
    ).rejects.toMatchObject({ code: "invalid_image", field: "profileImage" });
  });
});

/**
 * Migration 0181 closes the storage half of the CRM avatar gap this report
 * disclosed: an uploaded avatar is now a real Media Library asset, not a
 * second base64 store living inside `parties`. `profileImageAssetId` must be
 * tenant-scoped like every other cross-reference in this app
 * (`invalid_image`'s new failure mode), the two storage mechanisms must be
 * mutually exclusive on one row, and the FK's `ON DELETE SET NULL` must
 * survive the asset it points at actually being deleted — the party outlives
 * its own avatar photo.
 */
describe("party avatar — canonical Media Library asset (migration 0181)", () => {
  async function insertAsset(businessId: string, fileName = "avatar.png"): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO media_assets (business_id, kind, file_name, mime_type, byte_size, storage_key, sha256)
       VALUES ($1, 'image', $2, 'image/png', 2048, $3, repeat('a', 64)) RETURNING id`,
      [businessId, fileName, `media/${businessId}/${randomUUID()}/${fileName}`],
    );
    return rows[0].id;
  }

  it("links the party to the avatar asset and getMediaAssetUsage finds it back", async () => {
    const assetId = await insertAsset(biz.id);
    const party = await parties.createParty(biz.id, {
      role: "Customer",
      displayName: "آواتار کتابخانه‌ای",
      profileImageAssetId: assetId,
    });
    expect(party.profileImageAssetId).toBe(assetId);

    const { rows } = await db.query<{ profile_image_asset_id: string }>(
      "SELECT profile_image_asset_id FROM parties WHERE id = $1",
      [party.id],
    );
    expect(rows[0].profile_image_asset_id).toBe(assetId);

    const mediaService = await import("../src/lib/media-service");
    const usage = await mediaService.getMediaAssetUsage(assetId);
    expect(usage.parties).toEqual([{ id: party.id, name: "آواتار کتابخانه‌ای" }]);
    expect(mediaService.mediaAssetUsageIsEmpty(usage)).toBe(false);
  });

  it("clears the legacy inline profileImage when an asset is linked in the same write", async () => {
    const assetId = await insertAsset(biz.id);
    const party = await parties.createParty(biz.id, {
      role: "Customer",
      displayName: "بدون تصویر تودرتو",
      // Sent together, as a client mid-migration to the new picker might:
      // the asset always wins, and the row never carries both at once.
      profileImage: "https://example.com/old-avatar.png",
      profileImageAssetId: assetId,
    });
    expect(party.profileImageAssetId).toBe(assetId);
    expect(party.profileImage).toBeNull();
  });

  it("clears a previously-set asset id when a later edit picks the legacy link path instead", async () => {
    const assetId = await insertAsset(biz.id);
    const created = await parties.createParty(biz.id, {
      role: "Customer",
      displayName: "تغییر به لینک",
      profileImageAssetId: assetId,
    });
    const updated = await parties.updateParty(biz.id, created.id, {
      profileImageAssetId: null,
      profileImage: "https://example.com/new-avatar.png",
    });
    expect(updated?.profileImageAssetId).toBeNull();
    expect(updated?.profileImage).toBe("https://example.com/new-avatar.png");
  });

  it("leaves an untouched avatar alone when an unrelated field is edited", async () => {
    const assetId = await insertAsset(biz.id);
    const created = await parties.createParty(biz.id, {
      role: "Customer",
      displayName: "آواتار پایدار",
      profileImageAssetId: assetId,
    });
    const updated = await parties.updateParty(biz.id, created.id, { notes: "یادداشت تازه" });
    expect(updated?.profileImageAssetId).toBe(assetId);
    expect(updated?.notes).toBe("یادداشت تازه");
  });

  it("rejects an avatar asset belonging to a different business", async () => {
    const foreignAssetId = await insertAsset(other.id);
    await expect(
      parties.createParty(biz.id, {
        role: "Customer",
        displayName: "شخص دیگر",
        profileImageAssetId: foreignAssetId,
      }),
    ).rejects.toMatchObject({ code: "invalid_image", field: "profileImage" });
  });

  it("rejects a profileImageAssetId that does not exist at all", async () => {
    await expect(
      parties.createParty(biz.id, {
        role: "Customer",
        displayName: "شخص بی‌تصویر",
        profileImageAssetId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "invalid_image", field: "profileImage" });
  });

  it("rejects a document-kind asset — an avatar must actually be an image", async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO media_assets (business_id, kind, file_name, mime_type, byte_size, storage_key, sha256)
       VALUES ($1, 'document', 'contract.pdf', 'application/pdf', 4096, $2, repeat('c', 64)) RETURNING id`,
      [biz.id, `media/${biz.id}/${randomUUID()}/contract.pdf`],
    );
    await expect(
      parties.createParty(biz.id, {
        role: "Customer",
        displayName: "شخص با سند",
        profileImageAssetId: rows[0].id,
      }),
    ).rejects.toMatchObject({ code: "invalid_image", field: "profileImage" });
  });

  it("also validates the asset on update, not just create", async () => {
    const created = await parties.createParty(biz.id, { role: "Customer", displayName: "به‌روزرسانی نامعتبر" });
    await expect(
      parties.updateParty(biz.id, created.id, { profileImageAssetId: randomUUID() }),
    ).rejects.toMatchObject({ code: "invalid_image", field: "profileImage" });
  });

  it("survives the avatar asset later being deleted — the party keeps its record, just loses the photo", async () => {
    const assetId = await insertAsset(biz.id);
    const created = await parties.createParty(biz.id, {
      role: "Customer",
      displayName: "قابل حذف",
      profileImageAssetId: assetId,
    });

    await db.query("DELETE FROM media_assets WHERE id = $1", [assetId]);

    const { rows } = await db.query<{ name: string; profile_image_asset_id: string | null }>(
      "SELECT name, profile_image_asset_id FROM parties WHERE id = $1",
      [created.id],
    );
    expect(rows[0].profile_image_asset_id).toBeNull();
    expect(rows[0].name).toBe("قابل حذف");
  });
});

describe("updating a party", () => {
  it("leaves a tab the request did not name alone", async () => {
    const created = await parties.createParty(biz.id, {
      role: "Supplier",
      displayName: "مبلغی",
      contactInfo: { mobile: "02188776655", email: "sales@example.ir" },
      financialInfo: { bankName: "ملی", iban: "IR830540102380270014203457" },
      generalInfo: { taxPercentage: 12 },
    });

    const fixed = await parties.updateParty(biz.id, created.id, { phone: "02122334455" });
    expect(fixed?.phone).toBe("02122334455");
    // The two facts the POS does not know about, still there.
    expect(fixed?.financialInfo.iban).toBe("IR830540102380270014203457");
    expect(fixed?.generalInfo.taxPercentage).toBe(12);
    expect(fixed?.contactInfo.email).toBe("sales@example.ir");
  });

  it("treats a tab sent empty as cleared", async () => {
    const created = await parties.createParty(biz.id, {
      role: "Customer",
      displayName: "بی‌آدرس",
      addressInfo: { city: "تهران", street: "ولیعصر" },
    });
    const cleared = await parties.updateParty(biz.id, created.id, { addressInfo: {} });
    expect(cleared?.addressInfo.city ?? "").toBe("");
    expect(cleared?.address ?? "").toBe("");
  });

  it("does not reactivate an archived party as a side effect of an edit", async () => {
    const created = await parties.createParty(biz.id, { role: "Customer", displayName: "بایگانی" });
    await parties.updateParty(biz.id, created.id, { status: false });
    const edited = await parties.updateParty(biz.id, created.id, { notes: "تلفن جدید بعد از بایگانی" });
    expect(edited?.status).toBe(false);
    expect(edited?.notes).toBe("تلفن جدید بعد از بایگانی");
  });
});

describe("listing a party", () => {
  beforeEach(async () => {
    await parties.createParty(biz.id, { role: "Customer", displayName: "مشتری الف" });
    await parties.createParty(biz.id, { role: "Supplier", displayName: "تأمین‌کننده ب" });
    await parties.createParty(biz.id, { role: "Employee", displayName: "کارمند پ" });
  });

  it("filters by role, which is a view and not a permission", async () => {
    const all = await parties.listParties(biz.id, {});
    expect(all.total).toBe(3);
    const suppliers = await parties.listParties(biz.id, { roles: ["Supplier"] });
    expect(suppliers.parties.map((row) => row.displayName)).toEqual(["تأمین‌کننده ب"]);
    const staff = await parties.listParties(biz.id, { roles: ["Employee", "Supplier"] });
    expect(staff.total).toBe(2);
  });

  it("hides archived parties by default and shows them on request", async () => {
    const customer = await parties.createParty(biz.id, { role: "Customer", displayName: "بایگانی‌شده" });
    await parties.updateParty(biz.id, customer.id, { status: false });

    const active = await parties.listParties(biz.id, { roles: ["Customer"] });
    expect(active.parties.map((row) => row.displayName)).toEqual(["مشتری الف"]);
    const withArchived = await parties.listParties(biz.id, { roles: ["Customer"], includeInactive: true });
    expect(withArchived.total).toBe(2);
    // A search — the picker a cashier uses mid-sale — never offers an archived row.
    expect(await parties.searchParties(biz.id, "بایگانی‌شده")).toEqual([]);
  });

  it("paginates", async () => {
    const page1 = await parties.listParties(biz.id, { page: 1, pageSize: 2 });
    const page2 = await parties.listParties(biz.id, { page: 2, pageSize: 2 });
    expect(page1.parties).toHaveLength(2);
    expect(page2.parties).toHaveLength(1);
    expect(page1.total).toBe(3);
    expect(page1.parties[1].id).not.toBe(page2.parties[0].id);
  });
});

describe("removing a party", () => {
  it("hard-deletes one with no history", async () => {
    const created = await parties.createParty(biz.id, { role: "Customer", displayName: "اشتباه تایپی" });
    expect(await parties.removeParty(biz.id, created.id)).toBe("deleted");
    expect(await parties.getParty(biz.id, created.id)).toBeNull();
  });

  it("archives one a branch still buys from", async () => {
    const supplier = await parties.createParty(biz.id, { role: "Supplier", displayName: "شیرینی سرای" });
    await db.query("INSERT INTO suppliers (location_id, name, party_id) VALUES ($1, $2, $3)", [
      biz.locationId,
      "شیرینی سرای",
      supplier.id,
    ]);

    expect(await parties.removeParty(biz.id, supplier.id)).toBe("archived");
    const kept = await parties.getParty(biz.id, supplier.id);
    expect(kept?.status).toBe(false);
    // The alias and the party both survive: a purchase order from last year has to
    // still resolve the name it was written under.
    const alias = await db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM suppliers WHERE party_id = $1",
      [supplier.id],
    );
    expect(alias.rows[0].count).toBe("1");
  });

  it("says not_found rather than pretending", async () => {
    expect(await parties.removeParty(biz.id, randomUUID())).toBe("not_found");
  });
});

describe("personnel", () => {
  it("links one party per staff account, idempotently", async () => {
    // `users` is the membership table in this schema (one row per person per
    // business), which is what an employee party's `employee_user_id` points at.
    const user = await db.query<{ id: string }>(
      "INSERT INTO users (business_id, full_name, email, role, pin_hash) VALUES ($1, $2, $3, 'waiter', $4) RETURNING id",
      [biz.id, "کارمند تست", `waiter-${randomUUID().slice(0, 8)}@example.ir`, "$2b$10$notarealhashnotarealhashnotarealhashno"],
    );
    const userId = user.rows[0].id;

    const first = await parties.ensureEmployeeParty(biz.id, userId, { displayName: "علی رضایی" });
    const again = await parties.ensureEmployeeParty(biz.id, userId, { displayName: "علی رضایی" });
    expect(first?.id).toBe(again?.id);
    expect(first?.role).toBe("Employee");
    expect(first?.employeeUserId).toBe(userId);

    const rows = await db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM parties WHERE business_id = $1 AND employee_user_id = $2",
      [biz.id, userId],
    );
    expect(rows.rows[0].count).toBe("1");
  });

  it("renames the file when the member is renamed — one person, one name", async () => {
    // The team screen is where a member's name is managed, and its layout
    // promises the membership above and the personnel file below are two
    // views of one person. Before the repair half existed, a rename in the
    // team left the payroll file under the old name forever.
    const user = await db.query<{ id: string }>(
      "INSERT INTO users (business_id, full_name, role, pin_hash) VALUES ($1, $2, 'kitchen', $3) RETURNING id",
      [biz.id, "آشپز قدیم", "$2b$10$notarealhashnotarealhashnotarealhashno"],
    );
    const userId = user.rows[0].id;

    const created = await parties.ensureEmployeeParty(biz.id, userId, { displayName: "آشپز قدیم" });
    const renamed = await parties.ensureEmployeeParty(biz.id, userId, { displayName: "آشپز جدید" });

    expect(renamed?.id).toBe(created?.id);
    expect(renamed?.displayName).toBe("آشپز جدید");
    expect(renamed?.employeeUserId).toBe(userId);

    // Still exactly one file — the rename is an update, not a second row.
    const rows = await db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM parties WHERE business_id = $1 AND employee_user_id = $2",
      [biz.id, userId],
    );
    expect(rows.rows[0].count).toBe("1");
  });

  it("leaves the file's name alone when the caller names none", async () => {
    // A suspend or a permission change sends no name; the call doubles as the
    // repair path now, so it must not stamp the party with a blank or a stale
    // label. It still creates the file when it is missing.
    const user = await db.query<{ id: string }>(
      "INSERT INTO users (business_id, full_name, role, pin_hash) VALUES ($1, $2, 'waiter', $3) RETURNING id",
      [biz.id, "گارسون ثابت", "$2b$10$notarealhashnotarealhashnotarealhashno"],
    );
    const userId = user.rows[0].id;

    const created = await parties.ensureEmployeeParty(biz.id, userId, { displayName: "گارسون ثابت" });
    const untouched = await parties.ensureEmployeeParty(biz.id, userId, {});
    expect(untouched?.id).toBe(created?.id);
    expect(untouched?.displayName).toBe("گارسون ثابت");

    const blank = await parties.ensureEmployeeParty(biz.id, userId, { displayName: "  " });
    expect(blank?.displayName).toBe("گارسون ثابت");
  });
});

describe("categories", () => {
  it("compares names case- and space-insensitively, per business", async () => {
    const created = await parties.createPartyCategory(biz.id, { name: "خواروبار", role: "Supplier" });
    expect(created?.role).toBe("Supplier");
    await expect(parties.createPartyCategory(biz.id, { name: " خواروبار " })).rejects.toMatchObject({
      code: "category_exists",
    });
    // Another tenant may use the same name; it is not a shared namespace.
    await expect(parties.createPartyCategory(other.id, { name: "خواروبار" })).resolves.toMatchObject({
      name: "خواروبار",
    });
  });

  it("deactivates a category in use instead of orphaning the party", async () => {
    const category = await parties.createPartyCategory(biz.id, { name: "رستوران" });
    const party = await parties.createParty(biz.id, { role: "Customer", displayName: "عضو دسته" });
    await parties.updateParty(biz.id, party.id, { categoryId: category!.id });

    expect(await parties.removePartyCategory(biz.id, category!.id)).toBe("kept");
    const kept = await parties.getParty(biz.id, party.id);
    expect(kept?.categoryId).toBe(category!.id);
    expect(kept?.categoryName).toBe("رستوران");

    // Unused, it goes away entirely.
    const spare = await parties.createPartyCategory(biz.id, { name: "بی‌استفاده" });
    expect(await parties.removePartyCategory(biz.id, spare!.id)).toBe("deleted");
  });
});

describe("one person, several roles (migration 0148)", () => {
  it("stores the set beside the primary role, and keeps them consistent", async () => {
    const party = await parties.createParty(biz.id, {
      displayName: "کافه بامداد",
      roles: ["Customer", "Supplier"],
    });
    expect(party.roles).toEqual(["Customer", "Supplier"]);
    // The primary role is a member of its own set, and it is what the
    // accounting-code prefix was taken from (۱ = مشتری).
    expect(party.roles).toContain(party.role);
    expect(party.accountingCode?.startsWith("1")).toBe(true);

    const stored = await db.query<{ role: string; roles: string[] }>(
      "SELECT role, roles FROM parties WHERE id = $1",
      [party.id],
    );
    // Sorted and de-duplicated by the trigger, in storage spelling.
    expect(stored.rows[0].roles).toEqual(["customer", "supplier"]);
    expect(stored.rows[0].roles).toContain(stored.rows[0].role);
  });

  it("lists one record under every word it answers to", async () => {
    const both = await parties.createParty(biz.id, {
      displayName: "علی رضایی",
      roles: ["Customer", "Supplier"],
    });
    await parties.createParty(biz.id, { role: "Customer", displayName: "فقط مشتری" });
    await parties.createParty(biz.id, { role: "Supplier", displayName: "فقط تأمین‌کننده" });

    const customers = await parties.listParties(biz.id, { roles: ["Customer"] });
    const suppliers = await parties.listParties(biz.id, { roles: ["Supplier"] });
    // The same id in both lists — one file, one balance, not two rows.
    expect(customers.parties.map((p) => p.id)).toContain(both.id);
    expect(suppliers.parties.map((p) => p.id)).toContain(both.id);
    expect(customers.total).toBe(2);
    expect(suppliers.total).toBe(2);

    // And the picker search agrees with the directory listing.
    const found = await parties.searchParties(biz.id, "علی", { roles: ["Supplier"] });
    expect(found.map((p) => p.id)).toContain(both.id);
  });

  it("backfills a pre-0148 row: a scalar role alone still reads as its own set", async () => {
    // A writer that knows nothing about `roles` — an importer, the POS
    // quick-add, anything written before the column existed.
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, role) VALUES ($1, 'واردشده', 'supplier') RETURNING id`,
      [biz.id],
    );
    const party = await parties.getParty(biz.id, rows[0].id);
    expect(party?.roles).toEqual(["Supplier"]);
    const listed = await parties.listParties(biz.id, { roles: ["Supplier"] });
    expect(listed.parties.map((p) => p.id)).toContain(rows[0].id);
  });

  it("does not demote a multi-role party when an old caller edits one field", async () => {
    const party = await parties.createParty(biz.id, {
      displayName: "نانوایی شرق",
      roles: ["Customer", "Supplier"],
    });
    // The POS quick-add fixing a phone number: it sends `role` and knows
    // nothing about the set. Losing «تأمین‌کننده» here would silently drop the
    // party out of the purchasing picker.
    await parties.updateParty(biz.id, party.id, { role: "Customer", phone: "09120000000" });
    const after = await parties.getParty(biz.id, party.id);
    expect(after?.roles).toEqual(["Customer", "Supplier"]);

    // A write that names no role at all leaves the set entirely alone.
    await parties.updateParty(biz.id, party.id, { notes: "یادداشت" });
    expect((await parties.getParty(biz.id, party.id))?.roles).toEqual(["Customer", "Supplier"]);
  });

  it("keeps the personnel link while the party still holds the employee role", async () => {
    const user = await db.query<{ id: string }>(
      "INSERT INTO users (business_id, full_name, email, role, pin_hash) VALUES ($1, $2, $3, 'cashier', $4) RETURNING id",
      [
        biz.id,
        "مریم رضایی",
        `cashier-${randomUUID().slice(0, 8)}@example.ir`,
        "$2b$10$notarealhashnotarealhashnotarealhashno",
      ],
    );
    const userId = user.rows[0].id;
    const party = await parties.ensureEmployeeParty(biz.id, userId, { displayName: "مریم رضایی" });
    expect(party?.employeeUserId).toBe(userId);

    // Staff who also buy from the shop: adding «مشتری» must not sever the
    // membership the payroll screen reads.
    await parties.updateParty(biz.id, party!.id, { roles: ["Employee", "Customer"] });
    const after = await parties.getParty(biz.id, party!.id);
    expect(after?.roles).toEqual(["Customer", "Employee"]);
    expect(after?.employeeUserId).toBe(userId);

    // Dropping the employee role does sever it — one membership, one file.
    await parties.updateParty(biz.id, party!.id, { roles: ["Customer"] });
    expect((await parties.getParty(biz.id, party!.id))?.employeeUserId).toBeNull();
  });

  it("refuses an unknown role rather than defaulting it", async () => {
    await expect(
      parties.createParty(biz.id, { displayName: "نامعتبر", roles: ["Wizard"] }),
    ).rejects.toMatchObject({ code: "invalid_role" });
  });
});
