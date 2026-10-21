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
import { NextRequest } from "next/server";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { Role } from "../src/lib/auth-edge";

/**
 * The routes read the session cookie through `next/headers`, which exists only inside
 * a request. This jar is that request: the item-route case below drives
 * `GET`/`PUT /api/parties/[id]` with a real signed session, so what it proves is the
 * *route's* behaviour — including that it hands the audience to the write — and not
 * only the service's. Same pattern as `hybrid-credential-sync.integration.test.ts`.
 */
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  }),
  headers: async () => new Headers(),
}));

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let parties: typeof import("../src/lib/parties-service");
/**
 * Issue #947 (TEAM-F04/F05) — the membership → personnel-file guarantee. The
 * per-route `ensureEmployeeParty` writer is gone: the file is created and kept in
 * step by the canonical sync, which reads the identity from the *membership* row.
 * These cases therefore drive the users row and let the service derive the rest.
 */
let personnel: typeof import("../src/lib/personnel-file");

const biz = { id: "", locationId: "" };
const other = { id: "", locationId: "" };


/**
 * The personnel file of a member, through the canonical sync (issue #947).
 *
 * Returns the party as the *service* sees it — the full record, not the audience
 * projection a request gets — because these cases are about what is stored.
 */
async function syncPersonnelFile(
  userId: string,
): Promise<Awaited<ReturnType<typeof import("../src/lib/parties-service").getParty>>> {
  const result = await personnel.ensurePersonnelFileForMembership(biz.id, userId);
  return result.fileId ? parties.getParty(biz.id, result.fileId) : null;
}

/**
 * A membership in the primary business under test.
 *
 * The cases below are about the *file*, so the account is seeded with raw SQL: going
 * through `createMembership` would drag the deployment profile, the member ceiling and
 * the credential rules into tests that are not about any of them (the team suite owns
 * those). `role: "waiter"` is the shape that has always existed — a staff membership
 * with no login identity.
 */
async function seedMember(fields: {
  name: string;
  email?: string | null;
  phone?: string | null;
  /** The membership's preset. Defaults to the PIN-only waiter the suites above use. */
  role?: string;
}): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, full_name, email, phone_e164, role, pin_hash)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      biz.id,
      fields.name,
      fields.email ?? null,
      fields.phone ?? null,
      fields.role ?? "waiter",
      "$2b$10$notarealhashnotarealhashnotarealhashno",
    ],
  );
  return user.rows[0].id;
}

/**
 * Signs one member into the cookie jar the routes read.
 *
 * The token carries the role the *row* holds — `authorize()` resolves the effective
 * permission set from the membership itself, and the point of these cases is that the
 * audience follows those permissions rather than the role name in a claim.
 */
async function signInAs(userId: string, options: { role: Role; fullName?: string } = { role: "manager" }) {
  const { signSession, SESSION_COOKIE } = await import("../src/lib/auth");
  const employee = await import("../src/lib/employee-service");
  const business = await db.query<{ slug: string }>("SELECT slug FROM businesses WHERE id = $1", [biz.id]);
  const { session } = await employee.createSession(userId, biz.id, { deviceLabel: "parties-suite" });
  jar.set(
    SESSION_COOKIE,
    await signSession({
      sub: userId,
      role: options.role,
      businessId: biz.id,
      businessSlug: business.rows[0].slug,
      locationId: null,
      fullName: options.fullName ?? "مدیر",
      employeeSessionId: session.id,
    }),
  );
}

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
  personnel = await import("../src/lib/personnel-file");

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

  it("assumes no VAT rate for a new party and keeps a stored one through a save without it (audit F05)", async () => {
    // No rate typed → «follows the business rate» (null), never an assumed 9%.
    const plain = await parties.createParty(biz.id, { role: "Customer", displayName: "بدون نرخ" });
    expect(plain.generalInfo.taxPercentage).toBeNull();

    // A member without ledger.view saves the identity tab with the rate
    // stripped (buildNonAccountingPayload); the stored 12% must survive it.
    const rated = await parties.createParty(biz.id, {
      role: "Supplier",
      displayName: "با نرخ",
      generalInfo: { taxPercentage: 12 },
    });
    const saved = await parties.updateParty(biz.id, rated.id, {
      generalInfo: { nationalId: "", economicCode: "1234567890" },
    });
    expect(saved?.generalInfo.taxPercentage).toBe(12);
    expect(saved?.generalInfo.economicCode).toBe("1234567890");

    // An explicit 0 is an exemption, distinct from «follows the business rate».
    const exempt = await parties.updateParty(biz.id, rated.id, { generalInfo: { taxPercentage: 0 } });
    expect(exempt?.generalInfo.taxPercentage).toBe(0);
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

  it("archives a membership-linked personnel file instead of hard-deleting it", async () => {
    /**
     * Issue #854 (P2.6): the personnel file of a member is linked through
     * `employee_user_id`, and nothing downstream of the delete would have
     * complained — the membership's foreign key is ON DELETE SET NULL on the
     * *party's* column. So the history check itself must count the link, or a
     * member's file disappears out from under a live membership.
     */
    const user = await db.query<{ id: string }>(
      "INSERT INTO users (business_id, full_name, role, pin_hash) VALUES ($1, $2, 'waiter', $3) RETURNING id",
      [biz.id, "پروندهٔ متصل به عضویت", "$2b$10$notarealhashnotarealhashnotarealhashno"],
    );
    const file = await syncPersonnelFile(user.rows[0].id);
    expect(file?.id).toBeTruthy();

    expect(await parties.removeParty(biz.id, file!.id)).toBe("archived");
    const kept = await parties.getParty(biz.id, file!.id);
    expect(kept).not.toBeNull();
    expect(kept?.status).toBe(false);
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

    // Issue #854 (pass 4, gap 5): the file is named after the membership —
    // the member owns the identity fields, the repair path only follows.
    const first = await syncPersonnelFile(userId);
    const again = await syncPersonnelFile(userId);
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

    const created = await syncPersonnelFile(userId);
    // Issue #854 (pass 4, gap 5): the team screen renames the membership
    // first (`updateMembership`), and only then does the file follow — the
    // membership is the canonical owner of the name, so that is the order.
    // Issue #947 (F05): the sync reads the new name from the row itself, so no
    // caller can rename the account and leave the file under the old name.
    await db.query("UPDATE users SET full_name = 'آشپز جدید' WHERE id = $1", [userId]);
    const renamed = await syncPersonnelFile(userId);

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

  it("never stamps the file with a label the request omitted", async () => {
    /*
     * A suspend, a permission change or a phone edit names no name at all. The
     * sync's identity comes from the membership row, so there is nothing to omit:
     * the file keeps the member's real name (issue #947, F05 — the old shape took
     * a display name from the request body, which is how a partial edit could
     * stamp the file with a stale or blank label).
     */
    const user = await db.query<{ id: string }>(
      "INSERT INTO users (business_id, full_name, role, pin_hash) VALUES ($1, $2, 'waiter', $3) RETURNING id",
      [biz.id, "گارسون ثابت", "$2b$10$notarealhashnotarealhashnotarealhashno"],
    );
    const userId = user.rows[0].id;

    const created = await syncPersonnelFile(userId);
    const untouched = await syncPersonnelFile(userId);
    expect(untouched?.id).toBe(created?.id);
    expect(untouched?.displayName).toBe("گارسون ثابت");
  });

  it("creates no file for a nameless membership, and records what it owes", async () => {
    /*
     * A payroll row named «کارمند» is worse than no row: the name would follow the
     * person into a payslip. So a membership with no name gets no file — and the
     * debt is written down (`personnel_file_drift`) rather than swallowed, which is
     * the half of issue #947 F05 the old empty `catch` threw away.
     */
    const user = await db.query<{ id: string }>(
      "INSERT INTO users (business_id, full_name, role, pin_hash) VALUES ($1, '   ', 'waiter', $2) RETURNING id",
      [biz.id, "$2b$10$notarealhashnotarealhashnotarealhashno"],
    );
    const userId = user.rows[0].id;

    const result = await personnel.ensurePersonnelFileForMembership(biz.id, userId);
    expect(result.ok).toBe(false);
    expect(result.fileId).toBeNull();
    expect(
      (await db.query("SELECT 1 FROM parties WHERE business_id = $1 AND employee_user_id = $2", [biz.id, userId]))
        .rowCount,
    ).toBe(0);

    const drift = await personnel.listPersonnelFileDrift(biz.id);
    expect(drift.map((row) => row.userId)).toContain(userId);
    expect(drift.find((row) => row.userId === userId)?.lastError).toBe("membership_name_missing");

    // The debt is cleared by naming the person and syncing again — the same path a
    // rename takes.
    await db.query("UPDATE users SET full_name = 'بی‌نام سابق' WHERE id = $1", [userId]);
    const repaired = await personnel.ensurePersonnelFileForMembership(biz.id, userId);
    expect(repaired.ok).toBe(true);
    expect((await personnel.listPersonnelFileDrift(biz.id)).map((row) => row.userId)).not.toContain(userId);
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
    const party = await syncPersonnelFile(userId);
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

describe("canonical identity ownership for linked personnel files (issue #854 pass 4)", () => {
  /**
   * The membership (and the global identity behind it) owns the login
   * identity fields — name, email, phone — and the personnel party owns the
   * HR-only columns. A linked party edit that would grow an identity
   * disagreeing with the membership is refused; the membership → party
   * direction (`ensurePersonnelFileForMembership`) is the only way those fields travel.
   */

  async function seedMember(fields: { name: string; email?: string | null; phone?: string | null }) {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, full_name, email, phone_e164, role, pin_hash)
       VALUES ($1, $2, $3, $4, 'waiter', $5) RETURNING id`,
      [
        biz.id,
        fields.name,
        fields.email ?? null,
        fields.phone ?? null,
        "$2b$10$notarealhashnotarealhashnotarealhashno",
      ],
    );
    return user.rows[0].id;
  }

  it("refuses a linked edit that conflicts with the membership's login identity", async () => {
    const userId = await seedMember({
      name: "کارمند هویت",
      email: `identity-${randomUUID().slice(0, 8)}@example.ir`,
      phone: "+989120001111",
    });
    const file = await syncPersonnelFile(userId);
    expect(file?.id).toBeTruthy();

    await expect(
      parties.updateParty(biz.id, file!.id, { email: "conflict@example.ir" }),
    ).rejects.toMatchObject({ code: "identity_email_managed_by_membership", field: "email" });

    await expect(
      parties.updateParty(biz.id, file!.id, { phone: "09120002222" }),
    ).rejects.toMatchObject({ code: "identity_phone_managed_by_membership", field: "phone" });

    await expect(
      parties.updateParty(biz.id, file!.id, { displayName: "اسم دیگر" }),
    ).rejects.toMatchObject({ code: "identity_name_managed_by_membership", field: "displayName" });

    // Setting a phone when the membership has none is still a conflicting
    // copy — the login phone is the membership's to set.
    const noPhone = await seedMember({ name: "بی‌شماره" });
    const noPhoneFile = await syncPersonnelFile(noPhone);
    await expect(
      parties.updateParty(biz.id, noPhoneFile!.id, { phone: "09120003333" }),
    ).rejects.toMatchObject({ code: "identity_phone_managed_by_membership", field: "phone" });

    // Nothing half-applied behind a refusal.
    const unchanged = await parties.getParty(biz.id, file!.id);
    expect(unchanged?.displayName).toBe("کارمند هویت");
  });

  it("allows an edit that brings the file in line with the membership (the repair direction)", async () => {
    const email = `repair-${randomUUID().slice(0, 8)}@example.ir`;
    const userId = await seedMember({ name: "کارمند تعمیر", email, phone: "+989120004444" });
    const file = await syncPersonnelFile(userId);

    // Drift that predates the rule (e.g. a pre-0137 copy the member outgrew):
    await db.query("UPDATE parties SET email = 'stale@example.ir' WHERE id = $1", [file!.id]);

    // Writing the membership's own values back is the repair, and passes.
    const repaired = await parties.updateParty(biz.id, file!.id, {
      email,
      phone: "09120004444",
      displayName: "کارمند تعمیر",
    });
    expect(repaired?.email).toBe(email);
    expect(repaired?.displayName).toBe("کارمند تعمیر");
  });

  it("never locks an unrelated edit behind pre-existing identity drift", async () => {
    const userId = await seedMember({ name: "کارمند یادداشت", email: `notes-${randomUUID().slice(0, 8)}@example.ir` });
    const file = await syncPersonnelFile(userId);
    await db.query("UPDATE parties SET email = 'drifted@example.ir' WHERE id = $1", [file!.id]);

    const noted = await parties.updateParty(biz.id, file!.id, { notes: "یادداشت منابع انسانی" });
    expect(noted?.notes).toBe("یادداشت منابع انسانی");
    // The drifted column is untouched, neither silently fixed nor enforced.
    expect(noted?.email).toBe("drifted@example.ir");
  });

  it("applies the same rule when a creation links itself to a membership", async () => {
    const userId = await seedMember({ name: "کارمند ساخت", email: `create-${randomUUID().slice(0, 8)}@example.ir` });

    await expect(
      parties.createParty(biz.id, {
        role: "Employee",
        personType: "Real",
        displayName: "کارمند ساخت",
        email: "somebody-else@example.ir",
        employeeUserId: userId,
      }),
    ).rejects.toMatchObject({ code: "identity_email_managed_by_membership", field: "email" });
  });

  it("leaves unlinked parties free to own their own identity fields", async () => {
    const customer = await parties.createParty(biz.id, {
      displayName: "مشتری آزاد",
      roles: ["Customer"],
    });
    const updated = await parties.updateParty(biz.id, customer.id, {
      email: `free-${randomUUID().slice(0, 8)}@example.ir`,
      phone: "09120005555",
      displayName: "مشتری آزاد (ویرایش)",
    });
    expect(updated?.displayName).toBe("مشتری آزاد (ویرایش)");
    expect(updated?.email).toContain("@example.ir");
    expect(updated?.phone).toBeTruthy();
  });
});

/**
 * Issue #947 (TEAM-F02) — the personnel link is tenant-safe, at both layers.
 *
 * `parties.employee_user_id` is a foreign key into `users`, and `users` is
 * per-business: the same table holds every tenant's memberships. A `uuid`-only FK
 * therefore accepts *anybody's* membership id, and nothing in the generic body parser
 * asked whose it was. The service refuses it (`assertEmployeeLinkTarget`), and
 * migration 0221 adds the composite key `(business_id, employee_user_id) → users(
 * business_id, id)` so a bulk import or a future writer that forgot the call still
 * cannot cross tenants.
 *
 * Both layers are tested here, and separately: a test that only exercised the service
 * would pass with the constraint dropped, and the constraint is the half that protects
 * the code nobody has written yet.
 */
describe("personnel links are tenant-safe (issue #947, TEAM-F02)", () => {
  /** A membership of the *other* business — the id every case here is about. */
  async function seedForeignMember(name: string) {
    const member = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, full_name, role, pin_hash)
       VALUES ($1, $2, 'waiter', $3) RETURNING id`,
      [other.id, name, "$2b$10$notarealhashnotarealhashnotarealhashno"],
    );
    return member.rows[0].id;
  }

  it("refuses to create a file linked to another business's membership", async () => {
    const foreignId = await seedForeignMember("کارمند رقیب");
    await expect(
      parties.createParty(biz.id, {
        role: "Employee",
        roles: ["Employee"],
        personType: "Real",
        displayName: "کارمند رقیب",
        employeeUserId: foreignId,
      }),
    ).rejects.toMatchObject({ code: "employee_link_unknown", field: "employeeUserId" });
  });

  it("refuses a relink onto another business's membership, and leaves the old link alone", async () => {
    /*
     * The relink is the subtler half of the finding: the update path could write a
     * *replacement* link, and the canonical-identity guard returned early when its
     * same-business lookup found nothing («a dangling link owns nothing») — an answer
     * that is right for a link that no longer resolves and wrong for one being
     * proposed.
     */
    const userId = await seedMember({ name: "کارمند خودی" });
    const file = await syncPersonnelFile(userId);
    const foreignId = await seedForeignMember("کارمند رقیب دوم");

    await expect(
      parties.updateParty(biz.id, file!.id, { employeeUserId: foreignId }),
    ).rejects.toMatchObject({ code: "employee_link_unknown" });

    const stored = await parties.getParty(biz.id, file!.id);
    expect(stored?.employeeUserId).toBe(userId);
  });

  it("refuses a second file for the same membership", async () => {
    // 0137's unique index as a sentence rather than a raw `23505`: one person, one
    // file, whichever door tries to create the second.
    const userId = await seedMember({ name: "کارمند یکتا" });
    await syncPersonnelFile(userId);
    await expect(
      parties.createParty(biz.id, {
        role: "Employee",
        roles: ["Employee"],
        personType: "Real",
        displayName: "کارمند یکتا (دوم)",
        employeeUserId: userId,
      }),
    ).rejects.toMatchObject({ code: "employee_link_taken" });
  });

  it("keeps the database itself refusing a cross-business link", async () => {
    /*
     * The constraint layer, driven with raw SQL on purpose — this is the path a bulk
     * import, a restore or a future writer takes, none of which calls the service.
     * Postgres reports it as a foreign-key violation (23503) on
     * `parties_employee_same_business`, which is the guarantee being asserted; the
     * service's sentence is a courtesy on top of it.
     */
    const foreignId = await seedForeignMember("کارمند رقیب سوم");
    await expect(
      db.query(
        `INSERT INTO parties (business_id, name, roles, person_type, employee_user_id, accounting_code)
         VALUES ($1, 'پروندهٔ قاچاقی', ARRAY['employee']::text[], 'real', $2, $3)`,
        [biz.id, foreignId, `EMP-${randomUUID().slice(0, 8)}`],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("clears the link rather than deleting the file when the membership goes away", async () => {
    // ON DELETE SET NULL on the employee column only: the accounting file outlives the
    // account (its payslips do), and losing a payroll file because somebody removed a
    // login would be the worse failure.
    const userId = await seedMember({ name: "کارمند موقت" });
    const file = await syncPersonnelFile(userId);
    await db.query("DELETE FROM users WHERE id = $1", [userId]);

    const stored = await parties.getParty(biz.id, file!.id);
    expect(stored?.employeeUserId).toBeNull();
    expect(stored?.displayName).toBe("کارمند موقت");
  });
});

/**
 * Issue #947 (TEAM-F01) — what a read may return, against a real row.
 *
 * `partyForAudience` is one function and this is the only place it meets a stored
 * record: the audience decides whether an Employee's identifiers, address, notes and
 * bank block leave the server, and the case below pins both directions (withheld for a
 * till reader, complete for the team screen) plus the two rules that are easy to get
 * wrong in a projection — the operational contact pair stays readable, and a withheld
 * field is *named* rather than silently blank.
 */
describe("party field projection by audience (issue #947, TEAM-F01)", () => {
  const cashierAudience = { personnel: false, financial: false };
  const teamAudience = { personnel: true, financial: true };

  async function seedEmployeeFile() {
    /*
     * The membership holds the number first: a linked file's phone follows the account
     * (#854's canonical-identity rule), so seeding the file with a number the membership
     * does not have would be refused — which is itself the rule the next describe block
     * exercises.
     */
    const userId = await seedMember({
      name: "کارمند حساس",
      email: `pii-${randomUUID().slice(0, 8)}@example.ir`,
      phone: "+989120007777",
    });
    const file = await parties.createParty(biz.id, {
      role: "Employee",
      roles: ["Employee"],
      personType: "Real",
      displayName: "کارمند حساس",
      phone: "+989120007777",
      generalInfo: { nationalId: "0084575980" },
      addressInfo: { street: "خیابان پرسنلی", city: "تهران" },
      contactInfo: { mobile: "09120007777" },
      financialInfo: { iban: "IR820540102680020817909002" },
      notes: "یادداشت منابع انسانی",
      employeeUserId: userId,
    });
    return file;
  }

  it("withholds the sensitive half from a reader without a personnel key", async () => {
    const file = await seedEmployeeFile();
    const projected = await parties.getParty(biz.id, file.id, cashierAudience);
    expect(projected).not.toBeNull();

    // Withheld, and named.
    expect(projected!.generalInfo.nationalId).toBe("");
    expect(projected!.address).toBeNull();
    expect(projected!.notes).toBeNull();
    expect(projected!.financialInfo).toEqual({});
    expect(projected!.contactInfo).toEqual({});
    expect(projected!.restrictedFields).toEqual(
      expect.arrayContaining(["generalInfo.nationalId", "address", "notes", "financialInfo"]),
    );

    // Still readable: the operational pair every screen needs (the shift lead calls
    // this number) and the name the row is listed under.
    expect(projected!.displayName).toBe("کارمند حساس");
    expect(projected!.phone).toBe("+989120007777");

    // The same row read by a personnel audience really does carry the values, so the
    // test above is proving a projection rather than an empty fixture.
    const full = await parties.getParty(biz.id, file.id, teamAudience);
    expect(full!.generalInfo.nationalId).toBe("0084575980");
    expect(full!.notes).toBe("یادداشت منابع انسانی");
    expect(full!.financialInfo.iban).toBe("IR820540102680020817909002");
    expect(full!.restrictedFields ?? []).toEqual([]);
  });

  it("applies the same projection to the listing and the search", async () => {
    // The finding's own path: `?role=Employee` is the collection read, and a search is
    // the same rows through another query. One projection, three readers.
    await seedEmployeeFile();
    const listed = await parties.listParties(biz.id, { roles: ["Employee"], audience: cashierAudience });
    expect(listed.parties.length).toBe(1);
    expect(listed.parties[0].generalInfo.nationalId).toBe("");
    expect(listed.parties[0].financialInfo).toEqual({});

    const searched = await parties.searchParties(biz.id, "حساس", { audience: cashierAudience });
    expect(searched.length).toBe(1);
    expect(searched[0].generalInfo.nationalId).toBe("");
  });

  it("leaves a customer's own fields alone — the restriction is about Employee files", async () => {
    /*
     * The narrow scope of the rule, asserted so a later change cannot quietly turn it
     * into «hide the address from everyone»: a customer's address and notes are CRM
     * data, and the CRM's readers have always seen them.
     */
    const customer = await parties.createParty(biz.id, {
      role: "Customer",
      roles: ["Customer"],
      displayName: "مشتری نشانی‌دار",
      addressInfo: { street: "خیابان مشتری", city: "تهران" },
      notes: "یادداشت CRM",
      generalInfo: { nationalId: "0084575980" },
    });
    const projected = await parties.getParty(biz.id, customer.id, cashierAudience);
    expect(projected!.addressInfo).toMatchObject({ street: "خیابان مشتری" });
    expect(projected!.notes).toBe("یادداشت CRM");
    expect(projected!.generalInfo.nationalId).toBe("0084575980");
  });

  it("keeps the internal default wide, so a write never round-trips blanks", async () => {
    // `getParty`'s default audience is the full record: every mutation re-reads the row
    // it is about to write back, and a projected read there would persist the blanks
    // over the real data.
    const file = await seedEmployeeFile();
    const read = await parties.getParty(biz.id, file.id);
    expect(read!.financialInfo.iban).toBe("IR820540102680020817909002");
    expect(read!.generalInfo.nationalId).toBe("0084575980");
    expect(read!.restrictedFields ?? []).toEqual([]);
  });

  /*
   * The write half of the projection, and the reason it is not optional.
   *
   * A save is a round trip: the form reads the record, the person edits one field and
   * *every* field goes back. The projection withholds the personnel half, so the form
   * holds blanks — and a blank is indistinguishable from a cleared field. These cases
   * drive the real pair of production functions the browser uses
   * (`formStateFromParty` → `buildPartyPayload`, see party-form.tsx) rather than a
   * hand-written body, because the whole failure is «what the form actually sends».
   */
  async function saveFromProjectedForm(
    partyId: string,
    audience: typeof cashierAudience,
    edit: (state: import("../src/lib/parties").PartyFormState) => void = () => {},
  ) {
    const lib = await import("../src/lib/parties");
    const projected = await parties.getParty(biz.id, partyId, audience);
    const state = lib.formStateFromParty(projected);
    edit(state);
    /*
     * The browser posts this object as JSON and the route parses it (`PartyPayload` is
     * the *wire* shape, `PartyInput` the parsed one); calling the service directly skips
     * the parse, so the two types are bridged here rather than by loosening either.
     */
    const body = lib.buildPartyPayload(state) as unknown as Parameters<typeof parties.updateParty>[2];
    return parties.updateParty(biz.id, partyId, body, { audience });
  }

  it("does not let a withheld field be erased by the save that round-trips it", async () => {
    const file = await seedEmployeeFile();
    await saveFromProjectedForm(file.id, cashierAudience);

    // Read back with the full audience: the row is what it was. Without the write-side
    // guard this save wrote `national_id = NULL`, `address = NULL`, `notes = NULL`,
    // `address_info = '{}'` and `contact_info = '{}'` — a manager fixing a category
    // would have destroyed the personnel file behind them.
    const after = await parties.getParty(biz.id, file.id);
    expect(after!.generalInfo.nationalId).toBe("0084575980");
    expect(after!.notes).toBe("یادداشت منابع انسانی");
    expect(after!.address).toBe("خیابان پرسنلی");
    expect(after!.addressInfo).toMatchObject({ street: "خیابان پرسنلی" });
    expect(after!.contactInfo).toMatchObject({ mobile: "09120007777" });
    expect(after!.phone).toBe("+989120007777");
    expect(after!.financialInfo.iban).toBe("IR820540102680020817909002");
  });

  it("projects the CRM customer file for a person who is also staff", async () => {
    /*
     * The same rule at the CRM's own door. `/api/crm/customers/[id]/file` is gated on
     * `parties.view`, and a member of staff who is also a customer is *one* `parties`
     * row — so without this the address and the notes the directory withholds for that
     * row were two clicks away in the CRM.
     */
    const crm = await import("../src/lib/crm-service");
    const dual = await parties.createParty(biz.id, {
      role: "Customer",
      roles: ["Customer", "Employee"],
      displayName: "کارمند مشتری",
      addressInfo: { street: "خیابان دو نقش" },
      notes: "یادداشت پرسنلی",
    });

    const withheld = await crm.getCustomerFile(biz.id, dual.id, cashierAudience);
    expect(withheld).not.toBeNull();
    expect(withheld!.address).toBeNull();
    expect(withheld!.notes).toBeNull();
    expect(withheld!.restrictedFields).toEqual(["address", "notes"]);

    // Still the operational record the CRM exists for.
    expect(withheld!.name).toBe("کارمند مشتری");
    expect(withheld!.stats.orderCount).toBe(0);

    // The personnel reader sees the same file whole, and a plain customer is untouched
    // for both audiences — the restriction is about who may read, not about the CRM.
    const whole = await crm.getCustomerFile(biz.id, dual.id, teamAudience);
    expect(whole!.address).toBe("خیابان دو نقش");
    expect(whole!.notes).toBe("یادداشت پرسنلی");

    const plain = await parties.createParty(biz.id, {
      role: "Customer",
      roles: ["Customer"],
      displayName: "مشتری ساده",
      addressInfo: { street: "خیابان مشتری" },
      notes: "یادداشت مشتری",
    });
    const plainFile = await crm.getCustomerFile(biz.id, plain.id, cashierAudience);
    expect(plainFile!.address).toBe("خیابان مشتری");
    expect(plainFile!.notes).toBe("یادداشت مشتری");
    expect(plainFile!.restrictedFields).toBeUndefined();
  });

  it("still lands every field a permitted writer sends — including a deliberate clear", async () => {
    /*
     * The positive control. A guard that simply refused to write a field once it had a
     * value would pass the case above and break «پاک‌کردن کد ملی» for the member who is
     * allowed to do it, so the same form, saved by a permitted audience, must delete.
     */
    const file = await seedEmployeeFile();
    await saveFromProjectedForm(file.id, teamAudience, (state) => {
      state.notes = "";
      state.generalInfo = { ...state.generalInfo, nationalId: "" };
    });

    const after = await parties.getParty(biz.id, file.id);
    expect(after!.notes).toBeNull();
    expect(after!.generalInfo.nationalId).toBe("");
  });

  it("leaves a customer editable for the same restricted writer", async () => {
    /*
     * The rule is tied to the *record*, not to the caller: a customer's national ID and
     * notes were never withheld (`partyForAudience` scopes the personnel half to
     * Employee files), so the CRM's own editor must keep working for the manager who
     * holds `parties.manage` without `team.view`.
     */
    const customer = await parties.createParty(biz.id, {
      role: "Customer",
      roles: ["Customer"],
      displayName: "مشتری نگه‌بان",
      generalInfo: { nationalId: "0084575980" },
      notes: "یادداشت قدیمی",
    });
    const projected = await parties.getParty(biz.id, customer.id, cashierAudience);
    expect(projected!.generalInfo.nationalId).toBe("0084575980");

    await saveFromProjectedForm(customer.id, cashierAudience, (state) => {
      state.notes = "یادداشت تازه";
      state.displayName = "مشتری به‌روز";
    });

    const after = await parties.getParty(biz.id, customer.id);
    expect(after!.notes).toBe("یادداشت تازه");
    expect(after!.displayName).toBe("مشتری به‌روز");
    expect(after!.generalInfo.nationalId).toBe("0084575980");
  });
});

/**
 * The same projection through the *routes* (issue #947, TEAM-F01).
 *
 * The cases above call the service; these two call `GET`/`PUT /api/parties/[id]` with a
 * signed session, because the read projection is only as good as the write that follows
 * it: the route has to hand the caller's audience to the save, and a route that forgets
 * is exactly the bug that erases a personnel file from a screen that never showed it.
 */
describe("the item route's projection round trip (issue #947, TEAM-F01)", () => {
  async function routes() {
    const collection = await import("../src/app/api/parties/route");
    const item = await import("../src/app/api/parties/[id]/route");
    return { ...collection, ...item };
  }

  function itemRequest(id: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
    return [new NextRequest(`http://localhost/api/parties/${id}`, init), { params: Promise.resolve({ id }) }] as const;
  }

  async function seedFileWithSensitiveData() {
    const userId = await seedMember({
      name: "کارمند دُورکاری",
      email: `route-${randomUUID().slice(0, 8)}@example.ir`,
      phone: "+989120009999",
    });
    return parties.createParty(biz.id, {
      role: "Employee",
      roles: ["Employee"],
      personType: "Real",
      displayName: "کارمند دُورکاری",
      phone: "+989120009999",
      generalInfo: { nationalId: "0084575980" },
      addressInfo: { street: "خیابان مسیر", city: "تهران" },
      contactInfo: { mobile: "09120009999" },
      notes: "یادداشت حساس مسیر",
      employeeUserId: userId,
    });
  }

  it("withholds on the item read and does not erase on the save that follows", async () => {
    const file = await seedFileWithSensitiveData();
    // `parties.manage` without `team.view` — the manager preset. It is the shape the
    // finding is about: allowed to edit the record, not allowed to read the personnel
    // half of it.
    await signInAs(await seedMember({ name: "مدیر میانی", email: `mgr-${randomUUID().slice(0, 8)}@example.ir`, role: "manager" }), {
      role: "manager",
      fullName: "مدیر میانی",
    });
    const { GET, PUT } = await routes();

    const read = await GET(...itemRequest(file.id));
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { party: { generalInfo: { nationalId: string }; notes: string | null; restrictedFields?: string[] } };
    expect(readBody.party.generalInfo.nationalId).toBe("");
    expect(readBody.party.notes).toBeNull();
    expect(readBody.party.restrictedFields).toEqual(expect.arrayContaining(["generalInfo.nationalId", "notes"]));

    // What the browser posts back after any ordinary edit to that record.
    const lib = await import("../src/lib/parties");
    const payload = lib.buildPartyPayload(lib.formStateFromParty(readBody.party));
    const saved = await PUT(
      ...itemRequest(file.id, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
    expect(saved.status).toBe(200);
    expect((await saved.json()) as { party: { generalInfo: { nationalId: string } } }).toMatchObject({
      party: { generalInfo: { nationalId: "" } },
    });

    // The row is intact, and the answer the route gave back is still the withheld one.
    const stored = await parties.getParty(biz.id, file.id);
    expect(stored!.generalInfo.nationalId).toBe("0084575980");
    expect(stored!.notes).toBe("یادداشت حساس مسیر");
    expect(stored!.address).toBe("خیابان مسیر");
  });

  it("cannot blank what the till is not allowed to read — identity or bank block", async () => {
    /*
     * The other end of the same round trip, and the persona the finding names: the
     * cashier holds `parties.manage` (the counter edits a customer between two orders)
     * and neither `team.view` nor `ledger.view`. So both halves of the projection are
     * withheld from them, and both have to survive the form they are handed.
     */
    const file = await parties.createParty(biz.id, {
      role: "Employee",
      roles: ["Employee"],
      personType: "Real",
      displayName: "کارمند صندوق",
      phone: "+989120007777",
      generalInfo: { nationalId: "0084575980" },
      addressInfo: { street: "خیابان حساس", city: "تهران" },
      contactInfo: { mobile: "09120007777" },
      notes: "یادداشت منابع انسانی",
      financialInfo: { bankName: "ملت", iban: "IR820540102680020817909002" },
    });

    await signInAs(
      await seedMember({ name: "صندوق‌دار", email: `till-${randomUUID().slice(0, 8)}@example.ir`, role: "cashier" }),
      { role: "cashier", fullName: "صندوق‌دار" },
    );
    const { GET, PUT } = await routes();

    const read = await GET(...itemRequest(file.id));
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as {
      party: {
        generalInfo: { nationalId: string };
        notes: string | null;
        financialInfo: Record<string, unknown>;
        restrictedFields?: string[];
      };
    };
    expect(readBody.party.generalInfo.nationalId).toBe("");
    expect(readBody.party.financialInfo).toEqual({});
    expect(readBody.party.restrictedFields).toEqual(
      expect.arrayContaining(["generalInfo.nationalId", "notes", "financialInfo"]),
    );

    // Exactly what the party form posts back for a caller who cannot edit accounting:
    // `buildNonAccountingPayload` is the branch the screen takes for this member.
    const lib = await import("../src/lib/parties");
    const payload = lib.buildNonAccountingPayload(lib.formStateFromParty(readBody.party));
    const saved = await PUT(
      ...itemRequest(file.id, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
    expect(saved.status).toBe(200);

    const stored = await parties.getParty(biz.id, file.id);
    expect(stored!.generalInfo.nationalId).toBe("0084575980");
    expect(stored!.notes).toBe("یادداشت منابع انسانی");
    expect(stored!.addressInfo).toMatchObject({ street: "خیابان حساس" });
    expect(stored!.financialInfo).toMatchObject({ bankName: "ملت" });
  });

  it("links a standalone personnel file to an account, and aligns its identity", async () => {
    /*
     * The controlled link flow (TEAM-F07). The guaranteed direction of the guarantee is
     * «an account creates its file»; this is the other one — a file that was created by
     * hand in the party directory, deliberately connected to the account that should own
     * it, with the server validating the target, auditing the change, and bringing the
     * file's name/mobile/email over from the membership in the same request.
     */
    const userId = await seedMember({
      name: "کارمند متصل",
      email: `linked-${randomUUID().slice(0, 8)}@example.ir`,
      phone: "+989120005555",
    });
    const standalone = await parties.createParty(biz.id, {
      role: "Employee",
      roles: ["Employee"],
      personType: "Real",
      displayName: "پروندهٔ دستی",
      phone: "+989120001111",
      addressInfo: { street: "خیابان پرونده" },
      notes: "یادداشت پرونده",
    });
    expect(standalone.employeeUserId).toBeNull();

    await signInAs(
      await seedMember({ name: "مدیر ثبت", email: `reg-${randomUUID().slice(0, 8)}@example.ir`, role: "admin" }),
      { role: "admin", fullName: "مدیر ثبت" },
    );
    const { PUT } = await routes();

    const saved = await PUT(
      ...itemRequest(standalone.id, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roles: ["Employee"], employeeUserId: userId }),
      }),
    );
    expect(saved.status).toBe(200);

    // Linked, and the three shared fields now follow the account — while the file's own
    // fields (address, notes, accounting) are exactly as the ledger held them.
    const linked = await parties.getParty(biz.id, standalone.id);
    expect(linked!.employeeUserId).toBe(userId);
    expect(linked!.displayName).toBe("کارمند متصل");
    expect(linked!.phone).toBe("+989120005555");
    expect(linked!.notes).toBe("یادداشت پرونده");
    expect(linked!.addressInfo).toMatchObject({ street: "خیابان پرونده" });

    // Audited with the actor and both ends of the relationship change.
    const audit = await db.query<{ user_id: string; payload: { before: string | null; after: string | null } }>(
      `SELECT user_id, payload FROM audit_log
        WHERE business_id = $1 AND action = 'team.personnel_link_changed'
        ORDER BY created_at DESC LIMIT 1`,
      [biz.id],
    );
    expect(audit.rows[0].payload).toMatchObject({ before: null, after: userId });
    expect(audit.rows[0].user_id).not.toBeNull();

    // A membership of another business is refused, and the existing link survives the
    // refusal (a rejected relink must not unlink).
    const foreign = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, full_name, role, pin_hash)
       VALUES ($1, 'Rival Staff', 'waiter', '$2b$10$notarealhashnotarealhashnotarealhashno') RETURNING id`,
      [other.id],
    );
    const refused = await PUT(
      ...itemRequest(standalone.id, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roles: ["Employee"], employeeUserId: foreign.rows[0].id }),
      }),
    );
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("employee_link_unknown");
    expect((await parties.getParty(biz.id, standalone.id))!.employeeUserId).toBe(userId);
  });

  it("still lets the personnel reader edit the same record through the same route", async () => {
    // The positive control for the route: the audience is derived per request, so the
    // same handler must hand a `team.view` holder the full record and land their edit.
    const file = await seedFileWithSensitiveData();
    await signInAs(await seedMember({ name: "سرپرست", email: `sup-${randomUUID().slice(0, 8)}@example.ir`, role: "admin" }), {
      role: "admin",
      fullName: "سرپرست",
    });
    const { GET, PUT } = await routes();

    const read = await GET(...itemRequest(file.id));
    const readBody = (await read.json()) as { party: { generalInfo: { nationalId: string }; notes: string | null } };
    expect(readBody.party.generalInfo.nationalId).toBe("0084575980");
    expect(readBody.party.notes).toBe("یادداشت حساس مسیر");

    const lib = await import("../src/lib/parties");
    const state = lib.formStateFromParty(readBody.party);
    state.notes = "یادداشت ویرایش‌شده";
    const saved = await PUT(
      ...itemRequest(file.id, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lib.buildPartyPayload(state)),
      }),
    );
    expect(saved.status).toBe(200);
    const stored = await parties.getParty(biz.id, file.id);
    expect(stored!.notes).toBe("یادداشت ویرایش‌شده");
    expect(stored!.generalInfo.nationalId).toBe("0084575980");
  });
});

/**
 * Issue #947 (TEAM-F04/F05) — the durable half of the guarantee.
 *
 * A membership change commits first and the file follows; a failure there is recorded
 * as a debt rather than raised into a request that already succeeded. These cases drive
 * the debt and its repayment: `retryPersonnelFileDrift` (the Team screen and the
 * reconciliation script) and the rule that a refresh writes only the three fields the
 * membership owns.
 */
describe("personnel-file drift and repair (issue #947, TEAM-F04/F05)", () => {
  it("creates exactly one file when two doors race for the same new member", async () => {
    /*
     * Real concurrency, real constraint: `assertEmployeeLinkTarget` is a check-then-write,
     * so two doors that both see «no file yet» both try to create one and 0137's partial
     * unique index (`idx_parties_employee_user`) decides. The loser must adopt the
     * winner's file — not report a debt over a problem that does not exist, and above all
     * not leave the member with two personnel files in the ledger.
     */
    const userId = await seedMember({
      name: "کارمند هم‌زمان",
      email: `race-${randomUUID().slice(0, 8)}@example.ir`,
      phone: "+989120006666",
    });

    const [first, second] = await Promise.all([
      personnel.ensurePersonnelFileForMembership(biz.id, userId),
      personnel.ensurePersonnelFileForMembership(biz.id, userId),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.fileId).toBe(second.fileId);
    expect(first.fileId).toBeTruthy();

    const files = await db.query<{ id: string; name: string }>(
      "SELECT id, name FROM parties WHERE business_id = $1 AND employee_user_id = $2",
      [biz.id, userId],
    );
    expect(files.rows).toHaveLength(1);
    expect(files.rows[0].name).toBe("کارمند هم‌زمان");

    // And no drift left behind: the race was resolved, not recorded as owed work.
    const drift = await personnel.listPersonnelFileDrift(biz.id);
    expect(drift.filter((row) => row.userId === userId)).toEqual([]);
  });

  it("adopts the winner's file when a held transaction gets there first", async () => {
    /*
     * The loser's branch, made deterministic rather than hoped for.
     *
     * A second connection inserts the member's file and holds the transaction open. The
     * sync cannot see an uncommitted row, so it reads «no file», tries to create one, and
     * *blocks on 0137's unique index* until the holder commits — at which point its own
     * insert is refused with `23505`. The barrier is proven (the contender must be seen
     * waiting on a lock) rather than assumed with a sleep, and what must follow is the
     * adoption: the same file, no second file, and no drift row claiming work is owed.
     */
    const userId = await seedMember({
      name: "کارمند قفل",
      email: `lock-${randomUUID().slice(0, 8)}@example.ir`,
      phone: "+989120006666",
    });
    /*
     * Warm the pool before the race. A cold pool opens its connection lazily, and on a
     * loaded machine that setup can take longer than the barrier below — the test would
     * then be measuring connection latency, not the lock. One ordinary `query()` call
     * first makes the contender's first statement immediate.
     */
    await personnel.listPersonnelFileDrift(biz.id);

    const holder = new Client({ connectionString: urlFor(databaseName) });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      const inserted = await holder.query<{ id: string }>(
        `INSERT INTO parties (business_id, role, roles, person_type, name,
                              accounting_code_mode, accounting_code, employee_user_id)
         VALUES ($1, 'employee', ARRAY['employee']::text[], 'real', $2, 'manual', 'EMP-9101', $3)
         RETURNING id`,
        [biz.id, "کارمند قفل", userId],
      );

      const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const contender = personnel.ensurePersonnelFileForMembership(biz.id, userId);

      /*
       * Prove the barrier rather than assume it: the contender must be seen *blocked by
       * this very connection* on its insert into `parties`. That is what makes this a
       * held-lock test instead of a race that passes because both sides happened to
       * interleave nicely.
       *
       * Polled from the suite's own client, not from the holder: a query inside the
       * holder's open transaction answers from its own snapshot and can miss the very
       * backend it is looking for.
       */
      let blocked = false;
      for (let attempt = 0; attempt < 200 && !blocked; attempt += 1) {
        const { rows } = await db.query<{ blocked: number }>(
          `SELECT count(*)::int AS blocked FROM pg_stat_activity a
            WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
              AND $1 = ANY(pg_blocking_pids(a.pid)) AND a.query LIKE 'INSERT INTO parties%'`,
          [holderPid],
        );
        blocked = rows[0].blocked > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(blocked).toBe(true);

      await holder.query("COMMIT");
      const result = await contender;
      expect(result.ok).toBe(true);
      expect(result.fileId).toBe(inserted.rows[0].id);

      // The index is the handle the whole design leans on: a *second* file for one
      // membership cannot exist, whoever tries.
      await expect(
        db.query(
          `INSERT INTO parties (business_id, role, roles, person_type, name,
                                accounting_code_mode, accounting_code, employee_user_id)
           VALUES ($1, 'employee', ARRAY['employee']::text[], 'real', 'دوم', 'manual', 'EMP-9102', $2)`,
          [biz.id, userId],
        ),
      ).rejects.toThrow(/idx_parties_employee_user|duplicate key/);

      const files = await db.query("SELECT id FROM parties WHERE business_id = $1 AND employee_user_id = $2", [
        biz.id,
        userId,
      ]);
      expect(files.rows).toHaveLength(1);
      const drift = await personnel.listPersonnelFileDrift(biz.id);
      expect(drift.filter((row) => row.userId === userId)).toEqual([]);
    } finally {
      await holder.end();
    }
  });

  it("records one debt per member, counts the attempts, and clears it on repair", async () => {
    const userId = await seedMember({ name: "   " });
    await personnel.ensurePersonnelFileForMembership(biz.id, userId);
    await personnel.ensurePersonnelFileForMembership(biz.id, userId);

    const owed = (await personnel.listPersonnelFileDrift(biz.id)).filter((row) => row.userId === userId);
    expect(owed).toHaveLength(1);
    expect(owed[0].attempts).toBeGreaterThanOrEqual(2);
    expect(owed[0].reason).toBe("file_missing");

    // Naming the member is the repair, and the retry is what performs it.
    await db.query("UPDATE users SET full_name = 'نام‌دار شده' WHERE id = $1", [userId]);
    const result = await personnel.retryPersonnelFileDrift(biz.id, { limit: 5 });
    expect(result.repaired).toBeGreaterThanOrEqual(1);
    expect((await personnel.listPersonnelFileDrift(biz.id)).map((row) => row.userId)).not.toContain(userId);

    const file = await parties.getPartyByEmployee(biz.id, userId);
    expect(file?.displayName).toBe("نام‌دار شده");
  });

  it("refreshes only the fields the membership owns", async () => {
    /*
     * The identity direction is membership → file for three fields and nothing else:
     * an HR record's address, notes, national ID and bank account are the ledger's, and
     * a rename must not touch them. This is F05's «preserve unrelated fields» as a
     * behavioural claim rather than a comment.
     */
    const userId = await seedMember({ name: "کارمند اولیه" });
    const created = await syncPersonnelFile(userId);
    await parties.updateParty(biz.id, created!.id, {
      generalInfo: { nationalId: "0084575980" },
      addressInfo: { street: "خیابان منابع انسانی" },
      financialInfo: { iban: "IR820540102680020817909002" },
      notes: "یادداشت منابع انسانی",
    });

    await db.query("UPDATE users SET full_name = 'کارمند دوم', phone_e164 = '+989120009999' WHERE id = $1", [
      userId,
    ]);
    const synced = await syncPersonnelFile(userId);

    expect(synced!.displayName).toBe("کارمند دوم");
    expect(synced!.phone).toBe("+989120009999");
    // Untouched:
    expect(synced!.addressInfo).toMatchObject({ street: "خیابان منابع انسانی" });
    expect(synced!.financialInfo.iban).toBe("IR820540102680020817909002");
    expect(synced!.notes).toBe("یادداشت منابع انسانی");
  });

  it("does not clear the file's email when the membership has none", async () => {
    // `updateParty` takes an explicit `null` literally, so «the membership has no
    // email» would have wiped the file's own address. The sync names only the fields it
    // actually has.
    const userId = await seedMember({ name: "کارمند بی‌ایمیل", email: `kept-${randomUUID().slice(0, 8)}@example.ir` });
    const created = await syncPersonnelFile(userId);
    expect(created!.email).toContain("@example.ir");

    await db.query("UPDATE users SET email = NULL WHERE id = $1", [userId]);
    const synced = await syncPersonnelFile(userId);
    expect(synced!.email).toContain("@example.ir");
  });

  it("refuses to invent a name, and says which member it is about", async () => {
    // The drift row is what a screen shows and what the script retries, so it has to
    // carry enough to act on: the member, the reason and the last error.
    const userId = await seedMember({ name: " " });
    await personnel.ensurePersonnelFileForMembership(biz.id, userId);
    const row = (await personnel.listPersonnelFileDrift(biz.id)).find((entry) => entry.userId === userId);
    expect(row).toMatchObject({ reason: "file_missing", lastError: "membership_name_missing" });
    expect(row?.lastAttemptAt).toBeTruthy();
  });
});

/**
 * The same projection on the way *out* of the app (issue #947, TEAM-F01).
 *
 * An export is a read, and one with the longest reach: it leaves the server as a file
 * that gets mailed around. The customer export is reachable with a bulk key
 * (`data.export` + `crm.export`) that the *manager* preset holds — and the manager has
 * no `team.view`. The rows must still be narrowed per caller, or the person directory
 * would be readable through a different door.
 */
describe("the bulk export's projection (issue #947, TEAM-F01)", () => {
  const FIELDS = ["name", "nationalId", "address", "notes"] as const;

  interface ExportedRow {
    name: string;
    nationalId: string | null;
    address: string | null;
    notes: string | null;
  }

  /**
   * The JSON format, because its keys are the entity's own field keys: a CSV's header
   * carries the Persian *labels*, and a test that matched on those would break the day
   * somebody improves the wording rather than the behaviour.
   */
  async function exportRows(audience?: { personnel: boolean; financial: boolean }): Promise<ExportedRow[]> {
    const exportService = await import("../src/lib/data-transfer/export-service");
    const built = await exportService.buildExport({
      businessId: biz.id,
      locationId: null,
      entityKey: "crm.customers",
      format: "json",
      fields: [...FIELDS],
      actorUserId: null,
      actorName: "آزمون خروجی",
      ...(audience ? { partyAudience: audience } : {}),
    });
    return JSON.parse(built.body.toString("utf8")) as ExportedRow[];
  }

  it("empties the personnel columns of an Employee row, and only for a caller without them", async () => {
    // A colleague who is also a customer — the row that makes this seam matter — next to
    // an ordinary one, so the case can tell «narrowed» apart from «everything is blank».
    await parties.createParty(biz.id, {
      role: "Customer",
      roles: ["Employee", "Customer"],
      personType: "Real",
      displayName: "کارمند مشتری",
      generalInfo: { nationalId: "0084575980" },
      addressInfo: { street: "خیابان کارمند" },
      notes: "یادداشت منابع انسانی",
    });
    await parties.createParty(biz.id, {
      role: "Customer",
      roles: ["Customer"],
      personType: "Real",
      displayName: "مشتری ساده",
      addressInfo: { street: "خیابان مشتری" },
      notes: "یادداشت مشتری",
    });

    const narrowed = await exportRows({ personnel: false, financial: true });
    const wide = await exportRows({ personnel: true, financial: true });
    const find = (rows: ExportedRow[], name: string) => rows.find((row) => row.name === name);

    // The Employee row is still *in* the export — its name and its accounting identity
    // are what the file is for — with the personnel columns empty.
    expect(find(narrowed, "کارمند مشتری")).toMatchObject({
      nationalId: "",
      address: "",
      notes: "",
    });
    expect(find(wide, "کارمند مشتری")).toMatchObject({
      nationalId: "0084575980",
      address: "خیابان کارمند",
    });
    // And an ordinary customer's row is untouched, whoever is exporting.
    expect(find(narrowed, "مشتری ساده")?.address).toBe("خیابان مشتری");
    expect(find(wide, "مشتری ساده")?.address).toBe("خیابان مشتری");
  });

  it("keeps the internal read wide for a caller that never came from a request", async () => {
    // A scheduled run resolves its audience from the schedule's creator, and a service
    // caller has none at all: both rely on «no audience named» meaning «the record as
    // stored», which is the pre-existing behaviour of every service read.
    await parties.createParty(biz.id, {
      role: "Customer",
      roles: ["Employee", "Customer"],
      personType: "Real",
      displayName: "کارمند بدون مصرف‌کننده",
      addressInfo: { street: "خیابان درست" },
    });

    const rows = await exportRows();
    expect(rows.find((row) => row.name === "کارمند بدون مصرف‌کننده")?.address).toBe("خیابان درست");
  });
});

/**
 * Issue #913 item 8 — the retail CustomerPicker asks the canonical
 * `/api/parties?q=` search, not a bounded listing: the 101st and 500th
 * customer must be findable by name, and the answer must stay inside the
 * caller's own business even when the next business has the same names.
 */
describe("CustomerPicker search — depth and business isolation (issue #913 item 8)", () => {
  const PREFIX = "مشتری شماره";
  const nameAt = (n: number) => `${PREFIX} ${String(n).padStart(3, "0")}`;

  /**
   * #1 is the NEWEST (one second old) and #count the oldest, so the display
   * order (created_at DESC) puts the 101st row at position 101 and the 500th
   * at position 500 — past any first-page/100-row clamp, reachable only by
   * server-side search over the whole directory.
   */
  async function seedCustomers(businessId: string, count: number): Promise<void> {
    await db.query(
      `INSERT INTO parties (business_id, name, roles, role, created_at)
       SELECT $1, $2 || ' ' || lpad(i::text, 3, '0'), ARRAY['customer']::text[], 'customer',
              now() - make_interval(secs => i)
         FROM generate_series(1, $3) i`,
      [businessId, PREFIX, count],
    );
  }

  async function idsNamed(businessId: string, name: string): Promise<string[]> {
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM parties WHERE business_id = $1 AND name = $2",
      [businessId, name],
    );
    return rows.map((row) => row.id);
  }

  it("finds the 101st and the 500th customer through server search", async () => {
    await seedCustomers(biz.id, 500);

    for (const position of [101, 500]) {
      const expected = await idsNamed(biz.id, nameAt(position));
      expect(expected).toHaveLength(1);
      const results = await parties.searchParties(biz.id, nameAt(position));
      expect(results.map((party) => party.id)).toContain(expected[0]);
    }

    // The rows really do sit past a first page: a 100-row listing only
    // reaches #101 on page 2 and #500 on page 5.
    const page2 = await parties.listParties(biz.id, { page: 2, pageSize: 100 });
    expect(page2.parties.map((party) => party.name)).toContain(nameAt(101));
    const page5 = await parties.listParties(biz.id, { page: 5, pageSize: 100 });
    expect(page5.parties.map((party) => party.name)).toContain(nameAt(500));
  });

  it("answers only from the caller's own business when the other directory holds the same names", async () => {
    await seedCustomers(biz.id, 120);
    await seedCustomers(other.id, 120);

    const [mine] = await idsNamed(biz.id, nameAt(101));
    const [theirs] = await idsNamed(other.id, nameAt(101));
    expect(mine).toBeTruthy();
    expect(theirs).toBeTruthy();
    expect(mine).not.toBe(theirs);

    const fromMine = await parties.searchParties(biz.id, nameAt(101));
    expect(fromMine.map((party) => party.id)).toEqual([mine]);
    const fromTheirs = await parties.searchParties(other.id, nameAt(101));
    expect(fromTheirs.map((party) => party.id)).toEqual([theirs]);
  });

  it("answers the picker's own GET (?withBalance=1&q=) with the deep match, session-scoped", async () => {
    await seedCustomers(biz.id, 150);
    await signInAs(
      await seedMember({
        name: "صندوقدار پشتیبان",
        email: `picker-${randomUUID().slice(0, 8)}@example.ir`,
        role: "cashier",
      }),
      { role: "cashier", fullName: "صندوقدار" },
    );

    const { GET } = await import("../src/app/api/parties/route");
    const res = await GET(
      new NextRequest(
        `http://localhost/api/parties?withBalance=1&q=${encodeURIComponent(nameAt(101))}`,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      customers: { id: string; name: string; balance?: number }[];
    };
    const expected = await idsNamed(biz.id, nameAt(101));
    expect(body.customers.map((customer) => customer.id)).toEqual(expected);
    expect(body.customers[0]).toMatchObject({ name: nameAt(101) });
    expect(body.customers[0].balance).toBeDefined();
  });
});
