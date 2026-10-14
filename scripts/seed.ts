/**
 * Seeds the minimum data needed to log in:
 *   - one business + one location
 *   - one Owner user (email/password from SEED_OWNER_* env vars)
 *   - one sample Cashier with PIN 1234 (to exercise PIN quick-login)
 *
 * Idempotent: re-running skips anything that already exists.
 *
 * Usage: npm run db:seed
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { BCRYPT_COST } from "../src/lib/password-hashing";
import { Client } from "pg";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  const email = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
  const password = process.env.SEED_OWNER_PASSWORD ?? "owner1234";
  const name = process.env.SEED_OWNER_NAME ?? "مالک نمونه";

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const isDefault = password === "owner1234" || email === "owner@example.com";
  if (isDefault) {
    if (process.env.NODE_ENV === "production") {
      console.error("Refusing to seed with default credentials in production.");
      process.exit(1);
    }
    const anyRealBusiness = await client.query(
      "SELECT id FROM businesses WHERE slug != 'cafe-nemoone' LIMIT 1",
    );
    if (anyRealBusiness.rowCount && anyRealBusiness.rowCount > 0) {
      console.error(
        "Refusing to seed with default credentials into an already-initialized database.",
      );
      process.exit(1);
    }
  }

  try {
    await client.query("BEGIN");

    // Seeding creates a tenant, so it necessarily runs outside tenant scope.
    // Harmless when connected as the owner (who is not subject to RLS anyway)
    // and required when connected as the unprivileged app role.
    await client.query("SELECT set_config('app.rls_bypass', 'on', true)");

    let businessId: string;
    const existingBusiness = await client.query(
      "SELECT id FROM businesses LIMIT 1",
    );
    if (existingBusiness.rowCount) {
      businessId = existingBusiness.rows[0].id;
      console.log("Business already exists, reusing.");
    } else {
      const res = await client.query(
        "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
        ["کافه نمونه", "cafe-nemoone"],
      );
      businessId = res.rows[0].id;
      console.log("Created business «کافه نمونه».");
    }

    let locationId: string;
    const existingLocation = await client.query(
      "SELECT id FROM locations WHERE business_id = $1 LIMIT 1",
      [businessId],
    );
    if (existingLocation.rowCount) {
      locationId = existingLocation.rows[0].id;
      console.log("Location already exists, reusing.");
    } else {
      const res = await client.query(
        "INSERT INTO locations (business_id, name) VALUES ($1, $2) RETURNING id",
        [businessId, "شعبه مرکزی"],
      );
      locationId = res.rows[0].id;
      console.log("Created location «شعبه مرکزی».");
    }

    const existingOwner = await client.query(
      "SELECT id FROM users WHERE business_id = $1 AND email = $2",
      [businessId, email],
    );
    if (existingOwner.rowCount) {
      console.log(`Owner ${email} already exists, skipping.`);
    } else {
      // Phase 12: the login identity is global (platform_users) and the row in
      // `users` is this person's membership of this business.
      const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
      const identity = await client.query(
        `INSERT INTO platform_users (email, password_hash, full_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
         RETURNING id`,
        [email, passwordHash, name],
      );
      await client.query(
        `INSERT INTO users (business_id, platform_user_id, role, full_name, email, password_hash)
         VALUES ($1, $2, 'owner', $3, $4, $5)`,
        [businessId, identity.rows[0].id, name, email, passwordHash],
      );
      console.log(
        `Created owner ${email} (password from SEED_OWNER_PASSWORD).`,
      );
    }

    const existingCashier = await client.query(
      "SELECT id FROM users WHERE business_id = $1 AND role = 'cashier' LIMIT 1",
      [businessId],
    );
    if (existingCashier.rowCount) {
      console.log("Sample cashier already exists, skipping.");
    } else {
      await client.query(
        `INSERT INTO users (business_id, location_id, role, full_name, pin_hash)
         VALUES ($1, $2, 'cashier', $3, $4)`,
        [
          businessId,
          locationId,
          "صندوق‌دار نمونه",
          await bcrypt.hash("1234", BCRYPT_COST),
        ],
      );
      console.log("Created sample cashier with PIN 1234.");
    }

    const existingTable = await client.query(
      "SELECT id FROM dining_tables WHERE location_id = $1 LIMIT 1",
      [locationId],
    );
    if (existingTable.rowCount) {
      console.log("Sample tables already exist, skipping.");
    } else {
      for (const name of ["میز ۱", "میز ۲", "میز ۳"]) {
        await client.query(
          "INSERT INTO dining_tables (location_id, name, capacity) VALUES ($1, $2, 4)",
          [locationId, name],
        );
      }
      console.log("Created 3 sample dining tables.");
    }

    const existingCategory = await client.query(
      "SELECT id FROM menu_categories WHERE location_id = $1 LIMIT 1",
      [locationId],
    );
    if (existingCategory.rowCount) {
      console.log("Sample menu already exists, skipping.");
    } else {
      const hotDrinks = await client.query(
        "INSERT INTO menu_categories (location_id, name, sort_order) VALUES ($1, 'نوشیدنی گرم', 0) RETURNING id",
        [locationId],
      );
      const food = await client.query(
        "INSERT INTO menu_categories (location_id, name, sort_order) VALUES ($1, 'غذا', 1) RETURNING id",
        [locationId],
      );

      const espresso = await client.query(
        `INSERT INTO menu_items (location_id, category_id, name, price, sort_order)
         VALUES ($1, $2, 'اسپرسو', 850000, 0) RETURNING id`,
        [locationId, hotDrinks.rows[0].id],
      );
      await client.query(
        `INSERT INTO menu_items (location_id, category_id, name, price, sort_order)
         VALUES ($1, $2, 'کاپوچینو', 1200000, 1)`,
        [locationId, hotDrinks.rows[0].id],
      );
      await client.query(
        `INSERT INTO menu_items (location_id, category_id, name, price, sort_order)
         VALUES ($1, $2, 'پاستا آلفردو', 3200000, 0)`,
        [locationId, food.rows[0].id],
      );

      const milkGroup = await client.query(
        `INSERT INTO modifier_groups (location_id, name, min_select, max_select)
         VALUES ($1, 'نوع شیر', 0, 1) RETURNING id`,
        [locationId],
      );
      await client.query(
        `INSERT INTO modifiers (location_id, group_id, name, price_delta, sort_order) VALUES
           ($1, $2, 'شیر معمولی', 0, 0),
           ($1, $2, 'شیر بادام', 150000, 1),
           ($1, $2, 'شیر جو دوسر', 150000, 2)`,
        [locationId, milkGroup.rows[0].id],
      );
      await client.query(
        `INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id) VALUES ($1, $2)`,
        [espresso.rows[0].id, milkGroup.rows[0].id],
      );
      console.log(
        "Created sample menu (2 categories, 3 items, 1 modifier group).",
      );
    }

    // The seed exists to skip the wizard (README: "to skip the wizard and get
    // a ready-to-login demo"), and onboarding routing now keys on the formal
    // completion marker alone (issue #808 §1/§2). Without this row the seeded
    // owner would be sent into /setup on every login. Written idempotently so
    // re-running the seed neither errors nor rewrites an existing stamp.
    await client.query(
      `INSERT INTO settings (business_id, location_id, key, value)
       VALUES ($1, NULL, 'setup.progress', jsonb_build_object(
         'steps', jsonb_build_object('seeded', to_jsonb(now()::text)),
         'completedAt', to_jsonb(now()::text)))
       ON CONFLICT (business_id, location_id, key) DO NOTHING`,
      [businessId],
    );

    await client.query("COMMIT");
    console.log("Seed complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
