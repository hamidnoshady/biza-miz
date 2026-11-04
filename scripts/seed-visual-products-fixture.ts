/**
 * Issue #1207 — the products-screen fixture for the visual baselines.
 *
 * A second, deliberately separate business is needed rather than more rows in
 * the café's: the products workspace is gated to the trade-goods industries
 * (`PRODUCT_WORKSPACE_INDUSTRIES`), and `/accounting/products` redirects a
 * `food_service` business away. Changing the demo business's industry instead
 * would repaint every other baseline — sidebar, menus, everything — which is
 * exactly the "re-record to clear a red run" this suite forbids.
 *
 * So: one extra tenant with a fixed identity, and the harness logs in as its
 * owner for the products screens only (`images/products-*.png`). Every value
 * below is hard-coded for the same reason the rest of this file is: a fixture
 * that varies produces a baseline that disagrees with itself.
 *
 * What the rows are chosen to freeze, one screen element each:
 *
 *   - «موجود» with a quantity and a shelf price (the ordinary row);
 *   - «محصول اصلی» + «تنوع» with attribute chips, so the family/variant split
 *     from #1207 §B cannot silently become one word again;
 *   - «ناموجود» and a draft row, so both badge tones appear;
 *   - a shared SKU (`zza05023`, the code in the owner's own evidence), so
 *     «احتمال تکراری» is on screen instead of being a state nobody sees;
 *   - no store mapping anywhere, which is the «بدون پیوند ووکامرس» column and
 *     the «انتشار در فروشگاه» action — deliberately *not* a fake Woo connection,
 *     because seeding one would mean inventing encrypted credentials and a
 *     remote product the fixture cannot own.
 */
import { Client } from "pg";
import bcrypt from "bcryptjs";

/** The owner the harness signs in as for the products screens. */
export const PRODUCTS_OWNER_EMAIL = "products-owner@example.com";

/** The café seed's cost, reused so both fixtures hash alike. */
const BCRYPT_COST = 10;

interface FixtureItem {
  /** Stable natural key: the name is also what the list sorts and shows. */
  name: string;
  sku: string;
  kind: "simple" | "variant_parent" | "variant_child";
  parent?: string;
  barcode?: string;
  unit: string;
  /** Absent for a family: it has no stock of its own. */
  quantity?: string;
  unitCost?: number;
  unitPrice?: number;
  publishStatus?: "published" | "draft";
  isSellable?: boolean;
  attributes?: { name: string; value: string }[];
}

/** The shared code from the owner's evidence — two rows, one SKU. */
export const DUPLICATE_SKU = "zza05023";

const ITEMS: FixtureItem[] = [
  {
    name: "تی‌شرت نخی مردانه",
    sku: "TS-COT-1",
    kind: "simple",
    barcode: "6260000000015",
    unit: "عدد",
    quantity: "12",
    unitCost: 480_000,
    unitPrice: 890_000,
  },
  {
    name: "شلوار جین زنانه",
    sku: "JN-WMN",
    kind: "variant_parent",
    unit: "عدد",
  },
  {
    name: "شلوار جین زنانه — ۳۸ آبی",
    sku: "JN-WMN-38-B",
    kind: "variant_child",
    parent: "شلوار جین زنانه",
    unit: "عدد",
    quantity: "4",
    unitCost: 1_250_000,
    unitPrice: 2_100_000,
    attributes: [
      { name: "سایز", value: "۳۸" },
      { name: "رنگ", value: "آبی" },
    ],
  },
  {
    name: "کلاه بافتنی پشمی",
    sku: "HT-WOL-1",
    kind: "simple",
    unit: "عدد",
    quantity: "0",
    unitCost: 210_000,
    unitPrice: 390_000,
  },
  {
    name: "دفتر یادداشت جلد چرمی",
    sku: "NB-LTH-1",
    kind: "simple",
    unit: "عدد",
    quantity: "7",
    unitCost: 320_000,
    unitPrice: 640_000,
    publishStatus: "draft",
  },
  // The pair from the owner's 2026-10-31 evidence: two rows, one SKU. It
  // photographs «احتمال تکراری» — and, because neither row carries a mapping,
  // it is the "asked, never merged" state rather than an automatic decision.
  {
    name: "اسپری دوفاز ضد موخوره",
    sku: DUPLICATE_SKU,
    kind: "simple",
    unit: "عدد",
    quantity: "9",
    unitCost: 610_000,
    unitPrice: 1_027_000,
  },
  {
    name: "اسپری دوفاز ضد موخوره",
    sku: DUPLICATE_SKU,
    kind: "simple",
    unit: "عدد",
    quantity: "2",
    unitCost: 610_000,
    unitPrice: 1_027_000,
  },
];

/**
 * Seed the products tenant and its catalogue. Returns the business id so the
 * caller can count what it wrote. Idempotent: every row is keyed on a stable
 * natural key and skipped when it already exists.
 */
export async function seedProductsFixture(client: Client, t0: string): Promise<{ businessId: string; items: number }> {
  const business = await client.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry) VALUES ('فروشگاه نمونهٔ محصولات', 'visual-products', 'accessories')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  );
  const businessId = business.rows[0].id;

  // No unique key on (business_id, name), so "insert if absent" is spelled out
  // rather than trusted to ON CONFLICT: a second run must not add a second
  // branch (which would also change the branch count the shell renders).
  const existingLocation = await client.query<{ id: string }>(
    "SELECT id FROM locations WHERE business_id = $1 ORDER BY created_at LIMIT 1",
    [businessId],
  );
  const locationId =
    existingLocation.rows[0]?.id ??
    (
      await client.query<{ id: string }>(
        "INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ مرکزی') RETURNING id",
        [businessId],
      )
    ).rows[0].id;

  // The owner the harness signs in as. Same two-table shape as `scripts/seed.ts`:
  // the login identity is global, the `users` row is this person's membership.
  const passwordHash = await bcrypt.hash(process.env.SEED_OWNER_PASSWORD ?? "owner1234", BCRYPT_COST);
  const identity = await client.query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name)
     VALUES ($1, $2, 'مالک نمونهٔ محصولات')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [PRODUCTS_OWNER_EMAIL, passwordHash],
  );
  const existingOwner = await client.query(
    "SELECT id FROM users WHERE business_id = $1 AND email = $2",
    [businessId, PRODUCTS_OWNER_EMAIL],
  );
  if (!existingOwner.rowCount) {
    await client.query(
      `INSERT INTO users (business_id, location_id, platform_user_id, role, full_name, email, password_hash)
       VALUES ($1, $2, $3, 'owner', 'مالک نمونهٔ محصولات', $4, $5)`,
      [businessId, locationId, identity.rows[0].id, PRODUCTS_OWNER_EMAIL, passwordHash],
    );
  }

  // Skip the wizard, exactly as `scripts/seed.ts` does: onboarding routes on
  // this completion marker alone.
  await client.query(
    `INSERT INTO settings (business_id, location_id, key, value)
     VALUES ($1, NULL, 'setup.progress', jsonb_build_object(
       'steps', jsonb_build_object('seeded', to_jsonb($2::text)),
       'completedAt', to_jsonb($2::text)))
     ON CONFLICT (business_id, location_id, key) DO NOTHING`,
    [businessId, t0],
  );

  const ids = new Map<string, string>();
  // The duplicate pair is keyed on the SKU, not the name (the two rows share
  // both), so it is written by its own block below rather than here.
  const isDuplicatePair = (row: FixtureItem) => row.sku === DUPLICATE_SKU;
  // Families first: a child needs its parent's id.
  for (const item of ITEMS.filter((row) => row.kind !== "variant_child" && !isDuplicatePair(row))) {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM items WHERE location_id = $1 AND name = $2 AND kind = $3",
      [locationId, item.name, item.kind],
    );
    const id =
      existing.rows[0]?.id ??
      (
        await client.query<{ id: string }>(
          `INSERT INTO items (location_id, name, sku, kind, barcode, unit, is_sellable, publish_status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id`,
          [
            locationId,
            item.name,
            item.sku,
            item.kind,
            item.barcode ?? null,
            item.unit,
            item.isSellable ?? true,
            item.publishStatus ?? "published",
            t0,
          ],
        )
      ).rows[0].id;
    ids.set(`${item.name}|${item.kind}`, id);
    await ensureStock(client, id, item);
  }

  for (const item of ITEMS.filter((row) => row.kind === "variant_child")) {
    const parentId = ids.get(`${item.parent}|variant_parent`)!;
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM items WHERE location_id = $1 AND name = $2",
      [locationId, item.name],
    );
    const id =
      existing.rows[0]?.id ??
      (
        await client.query<{ id: string }>(
          `INSERT INTO items (location_id, parent_item_id, name, sku, kind, unit, is_sellable, publish_status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'variant_child', $5, true, 'published', $6, $6) RETURNING id`,
          [locationId, parentId, item.name, item.sku, item.unit, t0],
        )
      ).rows[0].id;
    ids.set(`${item.name}|variant_child`, id);
    for (const attribute of item.attributes ?? []) {
      await client.query(
        `INSERT INTO item_variant_attributes (item_id, name, value) VALUES ($1, $2, $3)
         ON CONFLICT (item_id, name) DO NOTHING`,
        [id, attribute.name, attribute.value],
      );
    }
    await ensureStock(client, id, item);
  }

  // The duplicate pair: the second row of that name is the one that makes the
  // shared SKU visible. Both exist only when neither exists yet, so a re-run
  // cannot turn the pair into a triple.
  const duplicateRows = await client.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM items WHERE location_id = $1 AND sku = $2",
    [locationId, DUPLICATE_SKU],
  );
  if (Number(duplicateRows.rows[0].n) === 0) {
    for (const item of ITEMS.filter(isDuplicatePair)) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO items (location_id, name, sku, kind, unit, is_sellable, publish_status, created_at, updated_at)
         VALUES ($1, $2, $3, 'simple', $4, true, 'published', $5, $5) RETURNING id`,
        [locationId, item.name, item.sku, item.unit, t0],
      );
      await ensureStock(client, inserted.rows[0].id, item);
    }
  }

  const counted = await client.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM items WHERE location_id = $1",
    [locationId],
  );
  return { businessId, items: Number(counted.rows[0].n) };
}

/** One stock row per sellable item; a family deliberately gets none. */
async function ensureStock(client: Client, itemId: string, item: FixtureItem): Promise<void> {
  if (item.quantity === undefined) return;
  await client.query(
    `INSERT INTO item_stock (item_id, quantity, unit_cost, unit_price, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (item_id) DO NOTHING`,
    [itemId, item.quantity, item.unitCost ?? null, item.unitPrice ?? null],
  );
}
