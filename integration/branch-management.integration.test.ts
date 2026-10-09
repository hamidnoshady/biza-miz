/**
 * Phase 14 exit criteria, against a real database.
 *
 *   1. A business with several branches shows correct per-branch and
 *      consolidated numbers, and the two reconcile.
 *   2. A member assigned to branch B cannot read branch A's orders, stock or
 *      till, even within their own business.
 *   3. Switching branches never leaks stale data from the previous one.
 *   4. Cross-branch inventory transfers balance on both sides of the ledger —
 *      already built (Phase 6/17); this suite only confirms the exit
 *      criterion is real by pointing at the existing coverage, not by
 *      rebuilding it. See operational-accounting.integration.test.ts's
 *      "ships, cancels, receives exactly once, and preserves transfer value".
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { BRANCH_COLORS } from "../src/lib/branch-color";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;

let dbLib: typeof import("../src/lib/db");
let setupState: typeof import("../src/lib/setup-state");
let branchService: typeof import("../src/lib/branch-service");
let reportsService: typeof import("../src/lib/reports-service");
let authEdge: typeof import("../src/lib/auth-edge");

const biz = { id: "", mainLocationId: "", northLocationId: "" };

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

function session(overrides: Partial<import("../src/lib/auth-edge").SessionPayload>) {
  return {
    sub: "",
    role: "owner" as const,
    businessId: biz.id,
    locationId: null,
    fullName: "Test",
    platformUserId: null,
    ...overrides,
  };
}

beforeAll(async () => {
  databaseName = `pos_branch_${randomUUID().replaceAll("-", "")}`;

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
  setupState = await import("../src/lib/setup-state");
  branchService = await import("../src/lib/branch-service");
  reportsService = await import("../src/lib/reports-service");
  authEdge = await import("../src/lib/auth-edge");
  void authEdge;

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

function asBusiness<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

beforeEach(async () => {
  await db.query("DELETE FROM businesses");

  // Phase 17 gave the default 'free' plan a 1-branch cap; this suite is
  // specifically about having several branches, which is a plan-limit
  // concern this suite isn't testing, so it runs on the uncapped tier.
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, plan) VALUES ('Multi-Branch Co', $1, 'business') RETURNING id",
    [`mb-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  // Colours are set explicitly because this fixture inserts branches with raw
  // SQL, which no production path does: createBranch() picks the next free
  // palette entry, and migration 0149 backfilled existing rows the same way.
  // Leaving both to the column default would give two branches the same
  // 'slate' and misrepresent what a real two-branch business looks like.
  const main = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name, color) VALUES ($1, 'Main', 'slate') RETURNING id",
    [biz.id],
  );
  biz.mainLocationId = main.rows[0].id;

  const north = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name, color) VALUES ($1, 'North', 'rose') RETURNING id",
    [biz.id],
  );
  biz.northLocationId = north.rows[0].id;
});

async function createMember(role: "owner" | "manager" | "cashier", locationId: string | null) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, location_id, pin_hash)
     VALUES ($1, $2, 'Member', $3, 'x') RETURNING id`,
    [biz.id, role, locationId],
  );
  return rows[0].id;
}

describe("branch access is confined to assignment", () => {
  it("restricts a member assigned to one branch, and it never resolves to the other", async () => {
    const cashierId = await createMember("cashier", biz.northLocationId);

    await asBusiness(biz.id, async () => {
      const resolved = await setupState.resolveActiveLocation(session({ sub: cashierId, role: "cashier" }));
      expect(resolved?.id).toBe(biz.northLocationId);

      const { locations, canSwitch } = await setupState.accessibleLocationsFor(
        session({ sub: cashierId, role: "cashier" }),
      );
      expect(locations.map((l) => l.id)).toEqual([biz.northLocationId]);
      expect(canSwitch).toBe(false);
    });
  });

  it("reports the business's branch count separately from the member's reachable set", async () => {
    // The switcher needs both numbers. `locations` is narrowed to what the
    // member may reach, so a cashier pinned to North looks identical to a
    // member of a one-branch business by its length — but the first must be
    // told which branch they are in and the second must not be given a
    // permanent header chip answering a question they never have.
    const cashierId = await createMember("cashier", biz.northLocationId);

    await asBusiness(biz.id, async () => {
      const pinned = await setupState.accessibleLocationsFor(
        session({ sub: cashierId, role: "cashier" }),
      );
      expect(pinned.locations).toHaveLength(1);
      expect(pinned.canSwitch).toBe(false);
      expect(pinned.businessLocationCount).toBe(2);
    });

    // An owner of the same business sees both, and may switch.
    const ownerId = await createMember("owner", null);
    await asBusiness(biz.id, async () => {
      const roaming = await setupState.accessibleLocationsFor(session({ sub: ownerId }));
      expect(roaming.locations).toHaveLength(2);
      expect(roaming.canSwitch).toBe(true);
      expect(roaming.businessLocationCount).toBe(2);
    });

    // Deactivating one leaves a genuinely single-branch business: the count
    // follows, because it is only ever the active branches.
    await branchService.deactivateBranch(biz.id, biz.northLocationId, null);
    await asBusiness(biz.id, async () => {
      const single = await setupState.accessibleLocationsFor(session({ sub: ownerId }));
      expect(single.businessLocationCount).toBe(1);
      expect(single.canSwitch).toBe(false);
    });
  });

  it("lets an owner reach and resolve to every branch", async () => {
    const ownerId = await createMember("owner", null);

    await asBusiness(biz.id, async () => {
      const { locations, canSwitch } = await setupState.accessibleLocationsFor(session({ sub: ownerId }));
      expect(locations.map((l) => l.id).sort()).toEqual(
        [biz.mainLocationId, biz.northLocationId].sort(),
      );
      expect(canSwitch).toBe(true);
    });
  });

  it("switching never leaks the previous branch's data — resolution always reflects the requested branch", async () => {
    const ownerId = await createMember("owner", null);

    await db.query(
      `INSERT INTO orders (location_id, order_number, type, status, total)
       VALUES ($1, 1, 'takeaway', 'completed', 1000)`,
      [biz.mainLocationId],
    );
    await db.query(
      `INSERT INTO orders (location_id, order_number, type, status, total)
       VALUES ($1, 1, 'takeaway', 'completed', 2000)`,
      [biz.northLocationId],
    );

    await asBusiness(biz.id, async () => {
      const mainSession = session({ sub: ownerId, activeLocationId: biz.mainLocationId });
      const north = session({ sub: ownerId, activeLocationId: biz.northLocationId });

      const resolvedMain = await setupState.resolveActiveLocation(mainSession);
      expect(resolvedMain?.id).toBe(biz.mainLocationId);

      const resolvedNorth = await setupState.resolveActiveLocation(north);
      expect(resolvedNorth?.id).toBe(biz.northLocationId);

      // Each resolution is independent — asking for North right after Main
      // does not carry Main's id forward.
      const resolvedMainAgain = await setupState.resolveActiveLocation(mainSession);
      expect(resolvedMainAgain?.id).toBe(biz.mainLocationId);
    });
  });

  it("falls back to an accessible branch when the requested one is not (or no longer) reachable", async () => {
    const cashierId = await createMember("cashier", biz.northLocationId);

    await asBusiness(biz.id, async () => {
      // Token names Main, but this cashier is fixed to North.
      const spoofed = session({
        sub: cashierId,
        role: "cashier",
        activeLocationId: biz.mainLocationId,
      });
      const resolved = await setupState.resolveActiveLocation(spoofed);
      expect(resolved?.id).toBe(biz.northLocationId);
    });
  });
});

describe("branch lifecycle", () => {
  it("copies the menu structure into a new branch, without inventory or recipes", async () => {
    const category = await db.query<{ id: string }>(
      "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'Drinks') RETURNING id",
      [biz.mainLocationId],
    );
    const group = await db.query<{ id: string }>(
      "INSERT INTO modifier_groups (location_id, name) VALUES ($1, 'Size') RETURNING id",
      [biz.mainLocationId],
    );
    await db.query("INSERT INTO modifiers (location_id, group_id, name) VALUES ($1, $2, 'Large')", [
      biz.mainLocationId,
      group.rows[0].id,
    ]);
    const item = await db.query<{ id: string }>(
      `INSERT INTO menu_items (location_id, category_id, name, price)
       VALUES ($1, $2, 'Latte', 50000) RETURNING id`,
      [biz.mainLocationId, category.rows[0].id],
    );
    await db.query(
      "INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id) VALUES ($1, $2)",
      [item.rows[0].id, group.rows[0].id],
    );
    await db.query(
      "INSERT INTO inventory_items (location_id, name, unit) VALUES ($1, 'Milk', 'l')",
      [biz.mainLocationId],
    );

    const { locationId: newBranchId } = await branchService.createBranch({
      businessId: biz.id,
      name: "South",
      copyMenuFromLocationId: biz.mainLocationId,
      actorId: null,
    });

    const items = await db.query<{ name: string; price: string }>(
      "SELECT name, price FROM menu_items WHERE location_id = $1",
      [newBranchId],
    );
    expect(items.rows).toEqual([{ name: "Latte", price: "50000" }]);

    const modifiers = await db.query<{ name: string }>(
      `SELECT m.name FROM modifiers m
         JOIN modifier_groups g ON g.id = m.group_id
        WHERE g.location_id = $1`,
      [newBranchId],
    );
    expect(modifiers.rows.map((r) => r.name)).toEqual(["Large"]);

    const links = await db.query(
      `SELECT 1 FROM menu_item_modifier_groups mg
         JOIN menu_items mi ON mi.id = mg.menu_item_id
        WHERE mi.location_id = $1`,
      [newBranchId],
    );
    expect(links.rowCount).toBe(1);

    // Deliberately not copied: inventory is physically local to a branch.
    const inventory = await db.query("SELECT 1 FROM inventory_items WHERE location_id = $1", [
      newBranchId,
    ]);
    expect(inventory.rowCount).toBe(0);
  });

  it("refuses to deactivate the last active branch", async () => {
    await branchService.deactivateBranch(biz.id, biz.northLocationId, null);
    await expect(branchService.deactivateBranch(biz.id, biz.mainLocationId, null)).rejects.toThrow(
      "last_active_branch",
    );
  });

  it("refuses to deactivate a branch with an open order or open table session", async () => {
    await db.query(
      `INSERT INTO orders (location_id, order_number, type, status, total)
       VALUES ($1, 1, 'dine_in', 'open', 0)`,
      [biz.northLocationId],
    );
    await expect(branchService.deactivateBranch(biz.id, biz.northLocationId, null)).rejects.toThrow(
      "branch_has_open_orders",
    );

    await db.query("UPDATE orders SET status = 'completed', closed_at = now() WHERE location_id = $1", [
      biz.northLocationId,
    ]);
    await db.query(
      "INSERT INTO table_sessions (location_id, opened_at) VALUES ($1, now())",
      [biz.northLocationId],
    );
    await expect(branchService.deactivateBranch(biz.id, biz.northLocationId, null)).rejects.toThrow(
      "branch_has_open_sessions",
    );
  });

  it("a deactivated branch drops out of accessible/default resolution immediately", async () => {
    const ownerId = await createMember("owner", null);
    await branchService.deactivateBranch(biz.id, biz.northLocationId, null);

    await asBusiness(biz.id, async () => {
      const { locations } = await setupState.accessibleLocationsFor(session({ sub: ownerId }));
      expect(locations.map((l) => l.id)).toEqual([biz.mainLocationId]);

      const resolved = await setupState.resolveActiveLocation(
        session({ sub: ownerId, activeLocationId: biz.northLocationId }),
      );
      expect(resolved?.id).toBe(biz.mainLocationId);
    });
  });

  it("refuses a second branch whose name only differs in digit script or spacing", async () => {
    await expect(
      asBusiness(biz.id, () =>
        branchService.createBranch({ businessId: biz.id, name: "  Main ", actorId: null }),
      ),
    ).rejects.toMatchObject({ message: "branch_name_taken", status: 409 });

    await asBusiness(biz.id, () =>
      branchService.createBranch({ businessId: biz.id, name: "شعبه ۲", actorId: null }),
    );
    await expect(
      asBusiness(biz.id, () =>
        branchService.createBranch({ businessId: biz.id, name: "شعبه 2", actorId: null }),
      ),
    ).rejects.toMatchObject({ message: "branch_name_taken" });
  });

  it("refuses a timezone Postgres could not bucket a business day by", async () => {
    await expect(
      asBusiness(biz.id, () =>
        branchService.createBranch({
          businessId: biz.id,
          name: "Bad Zone",
          timezone: "Mars/Olympus",
          actorId: null,
        }),
      ),
    ).rejects.toMatchObject({ message: "invalid_timezone", status: 400 });

    // Nothing was written, so no branch can be left in a state where every
    // report for it raises inside app_business_date().
    const { rows } = await db.query("SELECT 1 FROM locations WHERE name = 'Bad Zone'");
    expect(rows).toHaveLength(0);
  });

  it("renames, re-addresses and re-zones a branch — and refuses a blank rename", async () => {
    await asBusiness(biz.id, () =>
      branchService.updateBranch({
        businessId: biz.id,
        locationId: biz.northLocationId,
        actorId: null,
        name: "  North   Star ",
        address: " خیابان ولیعصر ",
        timezone: "Asia/Dubai",
      }),
    );

    const { rows } = await db.query<{ name: string; address: string; timezone: string }>(
      "SELECT name, address, timezone FROM locations WHERE id = $1",
      [biz.northLocationId],
    );
    expect(rows[0]).toEqual({
      name: "North Star",
      address: "خیابان ولیعصر",
      timezone: "Asia/Dubai",
    });

    // A whitespace-only rename used to be folded into coalesce() and reported
    // as success while changing nothing.
    await expect(
      asBusiness(biz.id, () =>
        branchService.updateBranch({
          businessId: biz.id,
          locationId: biz.northLocationId,
          actorId: null,
          name: "   ",
        }),
      ),
    ).rejects.toMatchObject({ message: "missing_fields", status: 400 });

    const after = await db.query<{ name: string }>("SELECT name FROM locations WHERE id = $1", [
      biz.northLocationId,
    ]);
    expect(after.rows[0].name).toBe("North Star");
  });

  it("refuses a rename onto another branch's name, but allows a branch to keep its own", async () => {
    await expect(
      asBusiness(biz.id, () =>
        branchService.updateBranch({
          businessId: biz.id,
          locationId: biz.northLocationId,
          actorId: null,
          name: "Main",
        }),
      ),
    ).rejects.toMatchObject({ message: "branch_name_taken", status: 409 });

    // Re-saving a branch under its own name is an edit of the other fields,
    // not a duplicate.
    await asBusiness(biz.id, () =>
      branchService.updateBranch({
        businessId: biz.id,
        locationId: biz.northLocationId,
        actorId: null,
        name: "North",
        phone: "02112345678",
      }),
    );
    const { rows } = await db.query<{ phone: string }>("SELECT phone FROM locations WHERE id = $1", [
      biz.northLocationId,
    ]);
    expect(rows[0].phone).toBe("02112345678");
  });

  it("records what changed in the audit log, not merely that something did", async () => {
    await asBusiness(biz.id, () =>
      branchService.updateBranch({
        businessId: biz.id,
        locationId: biz.northLocationId,
        actorId: null,
        timezone: "Asia/Dubai",
      }),
    );
    const { rows } = await db.query<{ payload: { timezone?: string } | null }>(
      `SELECT payload FROM audit_log
        WHERE business_id = $1 AND action = 'branch.updated' AND entity_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [biz.id, biz.northLocationId],
    );
    expect(rows[0].payload).toMatchObject({ timezone: "Asia/Dubai" });
  });

  it("rejects an edit that changes nothing rather than writing a no-op audit row", async () => {
    await expect(
      asBusiness(biz.id, () =>
        branchService.updateBranch({
          businessId: biz.id,
          locationId: biz.northLocationId,
          actorId: null,
        }),
      ),
    ).rejects.toMatchObject({ message: "nothing_to_change", status: 400 });
  });

  it("answers 404 rather than crashing when the branch id is not a uuid", async () => {
    // `WHERE id = $1` against a uuid column raises invalid_text_representation
    // for a non-uuid, which surfaced as a 500 and «خطای غیرمنتظره».
    for (const call of [
      () => branchService.updateBranch({ businessId: biz.id, locationId: "nope", actorId: null, name: "X" }),
      () => branchService.deactivateBranch(biz.id, "nope", null),
      () => branchService.reactivateBranch(biz.id, "nope", null),
    ]) {
      await expect(asBusiness(biz.id, call)).rejects.toMatchObject({
        message: "not_found",
        status: 404,
      });
    }

    await expect(
      asBusiness(biz.id, () =>
        branchService.createBranch({
          businessId: biz.id,
          name: "Copied",
          copyMenuFromLocationId: "not-a-uuid",
          actorId: null,
        }),
      ),
    ).rejects.toMatchObject({ message: "source_branch_not_found", status: 404 });
  });

  it("refuses to toggle a branch into the state it is already in", async () => {
    await expect(
      asBusiness(biz.id, () => branchService.reactivateBranch(biz.id, biz.mainLocationId, null)),
    ).rejects.toMatchObject({ message: "branch_already_active", status: 409 });

    await branchService.deactivateBranch(biz.id, biz.northLocationId, null);
    await expect(
      asBusiness(biz.id, () => branchService.deactivateBranch(biz.id, biz.northLocationId, null)),
    ).rejects.toMatchObject({ message: "branch_already_inactive", status: 409 });
  });

  it("holds reactivation to the plan's branch ceiling, exactly as creation is", async () => {
    // Creation refusing what reactivation waved through was the hole: a
    // business could exceed its cap by deactivating one branch and
    // reactivating another, or simply after a downgrade.
    await branchService.deactivateBranch(biz.id, biz.northLocationId, null);
    await db.query("UPDATE businesses SET plan = 'free' WHERE id = $1", [biz.id]);

    await expect(
      asBusiness(biz.id, () => branchService.reactivateBranch(biz.id, biz.northLocationId, null)),
    ).rejects.toMatchObject({ message: "branch_limit_exceeded", status: 403 });

    await db.query("UPDATE businesses SET plan = 'business' WHERE id = $1", [biz.id]);
    await asBusiness(biz.id, () =>
      branchService.reactivateBranch(biz.id, biz.northLocationId, null),
    );
    const { rows } = await db.query<{ is_active: boolean }>(
      "SELECT is_active FROM locations WHERE id = $1",
      [biz.northLocationId],
    );
    expect(rows[0].is_active).toBe(true);
  });

  it("never lets concurrent deactivations empty a business of active branches", async () => {
    await Promise.allSettled([
      asBusiness(biz.id, () => branchService.deactivateBranch(biz.id, biz.mainLocationId, null)),
      asBusiness(biz.id, () => branchService.deactivateBranch(biz.id, biz.northLocationId, null)),
    ]);

    const { rows } = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM locations WHERE business_id = $1 AND is_active",
      [biz.id],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it("gives each new branch a colour no sibling is using, without being asked", async () => {
    // An owner who never opens the picker must still end up with branches the
    // switcher can tell apart — that is the entire point of the colour.
    for (const name of ["Colour A", "Colour B", "Colour C"]) {
      await asBusiness(biz.id, () =>
        branchService.createBranch({ businessId: biz.id, name, actorId: null }),
      );
    }

    const branches = await asBusiness(biz.id, () => branchService.listBranches(biz.id));
    const colors = branches.map((b) => b.color);
    expect(new Set(colors).size).toBe(branches.length);
    expect(colors.every((color) => BRANCH_COLORS.includes(color))).toBe(true);
  });

  it("honours an explicitly chosen colour and refuses one outside the palette", async () => {
    await asBusiness(biz.id, () =>
      branchService.createBranch({
        businessId: biz.id,
        name: "Violet Branch",
        color: "violet",
        actorId: null,
      }),
    );
    const branches = await asBusiness(biz.id, () => branchService.listBranches(biz.id));
    expect(branches.find((b) => b.name === "Violet Branch")?.color).toBe("violet");

    // A raw hex would hit 0149's CHECK and surface as a 500; it is refused
    // with a Persian-labelled code instead.
    await expect(
      asBusiness(biz.id, () =>
        branchService.createBranch({
          businessId: biz.id,
          name: "Hex Branch",
          color: "#ff0000",
          actorId: null,
        }),
      ),
    ).rejects.toMatchObject({ message: "invalid_color", status: 400 });

    const after = await db.query("SELECT 1 FROM locations WHERE name = 'Hex Branch'");
    expect(after.rows).toHaveLength(0);
  });

  it("re-colours a branch, and the switcher's source of truth reflects it", async () => {
    await asBusiness(biz.id, () =>
      branchService.updateBranch({
        businessId: biz.id,
        locationId: biz.northLocationId,
        actorId: null,
        color: "teal",
      }),
    );

    const branches = await asBusiness(biz.id, () => branchService.listBranches(biz.id));
    expect(branches.find((b) => b.id === biz.northLocationId)?.color).toBe("teal");

    // accessibleLocationsFor is what /api/locations/active (and therefore the
    // header switcher) reads, so the colour has to travel on that path too.
    const ownerId = await createMember("owner", null);
    await asBusiness(biz.id, async () => {
      const { locations } = await setupState.accessibleLocationsFor(session({ sub: ownerId }));
      expect(locations.find((l) => l.id === biz.northLocationId)?.color).toBe("teal");
    });
  });

  it("lists each branch with what would block its deactivation", async () => {
    await db.query(
      `INSERT INTO orders (location_id, order_number, type, status, total)
       VALUES ($1, 1, 'dine_in', 'open', 0)`,
      [biz.northLocationId],
    );
    await db.query("INSERT INTO table_sessions (location_id, opened_at) VALUES ($1, now())", [
      biz.northLocationId,
    ]);
    await createMember("cashier", biz.northLocationId);

    const branches = await asBusiness(biz.id, () => branchService.listBranches(biz.id));
    const north = branches.find((b) => b.id === biz.northLocationId);
    expect(north).toMatchObject({ openOrderCount: 1, openSessionCount: 1, memberCount: 1 });

    const main = branches.find((b) => b.id === biz.mainLocationId);
    expect(main).toMatchObject({ openOrderCount: 0, openSessionCount: 0, memberCount: 0 });
  });
});

describe("consolidated reporting reconciles with per-branch numbers", () => {
  it("sums branches to exactly the independently-computed consolidated total", async () => {
    for (const [locationId, total] of [
      [biz.mainLocationId, 10_000],
      [biz.northLocationId, 25_000],
    ] as const) {
      await db.query(
        `INSERT INTO orders (location_id, order_number, type, status, total, closed_at)
         VALUES ($1, 1, 'takeaway', 'completed', $2, now())`,
        [locationId, total],
      );
    }

    await asBusiness(biz.id, async () => {
      const overview = await reportsService.getBusinessOverview(biz.id);
      expect(overview.branches).toHaveLength(2);

      const summed = overview.branches.reduce((sum, b) => sum + b.total, 0);
      expect(summed).toBe(overview.consolidated.total);
      expect(overview.consolidated.total).toBe(35_000);

      const north = overview.branches.find((b) => b.locationId === biz.northLocationId);
      expect(north?.total).toBe(25_000);
    });
  });

  it("still reconciles once a branch has been deactivated (history isn't dropped)", async () => {
    await db.query(
      `INSERT INTO orders (location_id, order_number, type, status, total, closed_at)
       VALUES ($1, 1, 'takeaway', 'completed', 5000, now())`,
      [biz.northLocationId],
    );
    await branchService.deactivateBranch(biz.id, biz.northLocationId, null);

    await asBusiness(biz.id, async () => {
      const overview = await reportsService.getBusinessOverview(biz.id);
      const north = overview.branches.find((b) => b.locationId === biz.northLocationId);
      expect(north?.isActive).toBe(false);
      expect(north?.total).toBe(5000);
      expect(overview.consolidated.total).toBe(
        overview.branches.reduce((sum, b) => sum + b.total, 0),
      );
    });
  });
});

/*
 * The branch an automated action writes to — `branch-service.resolveBranchRef`,
 * which is what issue #832 §15 asked the assistant's channels to stop guessing.
 *
 * Before it, `ai-autopilot-executors.ts` had its own copy of «oldest active
 * branch» and passed that to `recordExpense` and `createDraft` whatever the model
 * had been told: «اجارهٔ شعبهٔ شمال» landed on Main, and nothing disagreed with the
 * requester because the number and the date were right. Three things make the
 * resolver the right shape rather than a new invention: it reads the business's
 * own list, so a branch id from another tenant is simply absent (a refusal, not a
 * widened write); it compares names with `isSameBranchName`, the key the branch
 * form enforces uniqueness with, so a lookup cannot match two names the business
 * would refuse to create twice; and an ambiguous name is its own answer, because a
 * coin flip inside a posting is worse than a question.
 */
describe("branch reference resolution", () => {
  it("accepts the id or the name of a branch of this business", async () => {
    await asBusiness(biz.id, async () => {
      expect(await branchService.resolveBranchRef(biz.id, biz.northLocationId)).toEqual({
        ok: true,
        locationId: biz.northLocationId,
        matched: "requested",
      });
      expect(await branchService.resolveBranchRef(biz.id, " North ")).toEqual({
        ok: true,
        locationId: biz.northLocationId,
        matched: "requested",
      });
    });
  });

  it("reads a name the way the branch form would", async () => {
    // The comparison is the uniqueness key, so the variants a person types —
    // Arabic yeh, a stray diacritic, wrong case, digits in either script — reach
    // the same branch, and «شعبه ۲» and «شعبه 2» are never two answers.
    const { rows: named } = await db.query<{ id: string }>(
      `INSERT INTO locations (business_id, name, color) VALUES ($1, 'شعبه ۲', 'amber') RETURNING id`,
      [biz.id],
    );
    await asBusiness(biz.id, async () => {
      for (const spelling of ["شعبه ۲", "شعبه 2", "شعبه  2", " شعبهٔ 2 "]) {
        expect(await branchService.resolveBranchRef(biz.id, spelling), spelling).toMatchObject({
          ok: true,
          locationId: named[0].id,
        });
      }
    });
  });

  it("falls back to the oldest active branch only when nothing was asked for", async () => {
    const { rows: eldest } = await db.query<{ id: string }>(
      `INSERT INTO locations (business_id, name, color, created_at)
       VALUES ($1, 'Eldest', 'teal', now() - interval '1 year') RETURNING id`,
      [biz.id],
    );
    await asBusiness(biz.id, async () => {
      for (const unasked of [null, undefined, "", "   "]) {
        expect(await branchService.resolveBranchRef(biz.id, unasked)).toEqual({
          ok: true,
          locationId: eldest[0].id,
          matched: "default",
        });
      }
      // The rule the two writing actions use for "no branch named" is this one, so
      // they cannot drift from it.
      expect(await branchService.defaultBranchId(biz.id)).toBe(eldest[0].id);
    });
  });

  it("refuses another business's branch, a closed branch, and a name two branches share", async () => {
    const other = await db.query<{ id: string }>(
      `INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id`,
      [`other-${randomUUID().slice(0, 8)}`],
    );
    const { rows: foreign } = await db.query<{ id: string }>(
      `INSERT INTO locations (business_id, name, color) VALUES ($1, 'North', 'slate') RETURNING id`,
      [other.rows[0].id],
    );
    await db.query(
      `INSERT INTO locations (business_id, name, color) VALUES ($1, 'Duplicate', 'slate'), ($1, 'Duplicate', 'amber')`,
      [biz.id],
    );

    await asBusiness(biz.id, async () => {
      // A foreign id is not "the other tenant's North"; it is no branch at all.
      // The answer is deliberately the same as for a name nobody has, so a probe
      // cannot tell "exists elsewhere" from "does not exist".
      const rejected = await branchService.resolveBranchRef(biz.id, foreign[0].id);
      expect(rejected).toMatchObject({ ok: false, reason: "unknown" });
      // What a refusal offers instead is this business's own list — never the fact
      // that the id was somebody else's branch.
      if (!rejected.ok) expect(rejected.branchNames).toHaveLength(4);
      expect(await branchService.resolveBranchRef(biz.id, "هیچ شعبه‌ای")).toMatchObject({
        ok: false,
        reason: "unknown",
      });
      // Two branches answering to one name: the automation asks rather than picks.
      const ambiguous = await branchService.resolveBranchRef(biz.id, "duplicate");
      expect(ambiguous).toMatchObject({ ok: false, reason: "ambiguous" });
      if (!ambiguous.ok) expect(ambiguous.branchNames).toEqual(["Duplicate", "Duplicate"]);
    });

    // A deactivated branch is not a branch an action may be filed against, even
    // though its id is still a row in `locations`.
    await branchService.deactivateBranch(biz.id, biz.northLocationId, null);
    await asBusiness(biz.id, async () => {
      expect(await branchService.resolveBranchRef(biz.id, biz.northLocationId)).toMatchObject({
        ok: false,
        reason: "unknown",
      });
      expect(await branchService.resolveBranchRef(biz.id, "North")).toMatchObject({
        ok: false,
        reason: "unknown",
      });
    });
  });
});
