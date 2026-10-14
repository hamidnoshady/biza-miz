/**
 * Phase 14 — branch (location) lifecycle within one business.
 *
 * Not to be confused with the Phase 9 `rollup_locations` registry: that is
 * cross-*server* (each branch's own on-premise server pushing to a central
 * one). This is cross-*row*, within one database, one business, RLS-scoped —
 * the multi-branch story for a business hosted on the shared platform.
 *
 * DB-touching, so not unit-tested directly per repo convention; the pure
 * access rules it composes with live in location-access.ts.
 */
import { randomUUID } from "node:crypto";
import { getPool, query } from "./db";
import { activeBranchCount } from "./plan-limits";
import { resolveLimitCeiling } from "./entitlement-service";
import {
  DEFAULT_BRANCH_TIMEZONE,
  branchFieldsError,
  isSameBranchName,
  normalizeBranchName,
  normalizeOptionalText,
} from "./branch-input";
import { type BranchColor, nextBranchColor, toBranchColor } from "./branch-color";
import { isUuid } from "./uuid";

export class BranchError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

export interface Branch {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  /** Palette key identifying the branch at a glance in the switcher (0149). */
  color: BranchColor;
  isActive: boolean;
  createdAt: string;
  /**
   * What the branch is currently holding, so the management screen can say
   * *why* a branch cannot be deactivated before the owner presses the button
   * and gets a 409 back. These are exactly the two conditions
   * `deactivateBranch` refuses on, plus the member count, which is the thing
   * an owner always asks next ("who am I locking out?").
   */
  openOrderCount: number;
  openSessionCount: number;
  memberCount: number;
}

interface BranchRow extends Record<string, unknown> {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  color: string;
  is_active: boolean;
  created_at: Date;
  open_order_count: string;
  open_session_count: string;
  member_count: string;
}

function toBranch(row: BranchRow): Branch {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    phone: row.phone,
    timezone: row.timezone,
    color: toBranchColor(row.color),
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    openOrderCount: Number(row.open_order_count),
    openSessionCount: Number(row.open_session_count),
    memberCount: Number(row.member_count),
  };
}

/** Every branch of a business, active and inactive, for the management screen. */
/**
 * The business's own active branches, in the order the switcher lists them.
 *
 * Deliberately not `listBranches`: that carries the open-order / open-session /
 * member counts the management screen needs to explain why a branch cannot be
 * deactivated, and a lookup that only has to name a branch has no business
 * running four aggregate subqueries for it.
 */
export async function activeBranchRefs(businessId: string): Promise<{ id: string; name: string }[]> {
  const { rows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at`,
    [businessId],
  );
  return rows;
}

/** The branch an automation writes to when nobody said otherwise: the oldest active one. */
export async function defaultBranchId(businessId: string): Promise<string | null> {
  const refs = await activeBranchRefs(businessId);
  return refs[0]?.id ?? null;
}

/**
 * A branch named the way a person or a model names one — by id, or by exactly one
 * active branch's name — resolved *within this business* and nowhere else.
 *
 * Three things make this the only right place for the rule: the comparison is
 * `isSameBranchName`, the same indistinguishable-to-a-reader key the branch form
 * enforces uniqueness with (so a lookup can never match two names the business
 * would refuse to create twice); an id that belongs to another tenant is simply
 * not in the list, so a foreign id is a refusal rather than a widened write; and
 * an ambiguous name is its own answer — two branches called «مرکزی» is a naming
 * mistake the owner should hear about, not a coin flip inside an automation that
 * is about to post a journal entry.
 */
export async function resolveBranchRef(
  businessId: string,
  ref: string | null | undefined,
): Promise<
  | { ok: true; locationId: string | null; matched: "requested" | "default" }
  | { ok: false; reason: "unknown" | "ambiguous"; branchNames: string[] }
> {
  const wanted = typeof ref === "string" ? ref.trim() : "";
  const branches = await activeBranchRefs(businessId);
  if (!wanted) return { ok: true, locationId: branches[0]?.id ?? null, matched: "default" };

  if (isUuid(wanted)) {
    const byId = branches.find((branch) => branch.id === wanted);
    if (byId) return { ok: true, locationId: byId.id, matched: "requested" };
  }
  const byName = branches.filter((branch) => isSameBranchName(branch.name, wanted));
  if (byName.length === 1) return { ok: true, locationId: byName[0].id, matched: "requested" };
  if (byName.length > 1) {
    return { ok: false, reason: "ambiguous", branchNames: byName.map((branch) => branch.name) };
  }
  return { ok: false, reason: "unknown", branchNames: branches.map((branch) => branch.name) };
}

export async function listBranches(businessId: string): Promise<Branch[]> {
  const { rows } = await query<BranchRow>(
    `SELECT l.id, l.name, l.address, l.phone, l.timezone, l.color, l.is_active, l.created_at,
            (SELECT count(*) FROM orders o
              WHERE o.location_id = l.id AND o.status IN ('open', 'held'))::text
              AS open_order_count,
            (SELECT count(*) FROM table_sessions ts
              WHERE ts.location_id = l.id AND ts.closed_at IS NULL)::text
              AS open_session_count,
            -- A member counts for the branch they are assigned to *or* pinned
            -- to by users.location_id — the same two sources location-access.ts
            -- resolves access from, so the number matches who actually works
            -- there rather than only who has an explicit assignment row.
            (SELECT count(DISTINCT u.id) FROM users u
              WHERE u.business_id = l.business_id AND u.is_active
                AND (u.location_id = l.id
                     OR EXISTS (SELECT 1 FROM user_locations ul
                                 WHERE ul.user_id = u.id AND ul.location_id = l.id)))::text
              AS member_count
       FROM locations l
      WHERE l.business_id = $1
      ORDER BY l.created_at`,
    [businessId],
  );
  return rows.map(toBranch);
}

/**
 * Serialises every branch lifecycle write for one business.
 *
 * Create, deactivate and reactivate all read a count (the plan ceiling, the
 * "last active branch" rule) and then write against it, so each pair of them
 * races: two creates can exceed a plan's cap, and two deactivations can leave
 * a business with zero active branches — a state nothing in the UI can undo,
 * because every screen needs a branch to resolve. One transaction-scoped
 * advisory lock per business makes all three mutually exclusive without
 * blocking anything else, the same pattern `business-provisioning.ts` and
 * `reservation-service.ts` already use. It is released on COMMIT or ROLLBACK.
 */
async function lockBranchMutations(
  client: import("pg").PoolClient,
  businessId: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `branch-lifecycle:${businessId}`,
  ]);
}

/**
 * Is another branch of this business already called that?
 *
 * Compared on `branchNameKey`, not on the raw string, so «شعبه ۲» and
 * «شعبه 2» collide — see branch-input.ts. Done in JS over the business's own
 * branches rather than as a unique index because the comparison is a Persian
 * text rule (yeh/kaf variants, digit scripts, ZWNJ) that a Postgres index
 * would have to duplicate in SQL, and a business has a handful of branches,
 * not thousands.
 */
async function branchNameTaken(
  exec: {
    query: <T extends Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ) => Promise<{ rows: T[] }>;
  },
  businessId: string,
  name: string,
  exceptLocationId?: string,
): Promise<boolean> {
  const { rows } = await exec.query<{ id: string; name: string }>(
    "SELECT id, name FROM locations WHERE business_id = $1",
    [businessId],
  );
  return rows.some(
    (row) => row.id !== exceptLocationId && isSameBranchName(row.name, name),
  );
}

export interface CreateBranchInput {
  businessId: string;
  name: string;
  address?: string | null;
  phone?: string | null;
  timezone?: string;
  /**
   * Palette key for the branch's identifying colour. Omitted means "choose a
   * distinct one for me" — see nextBranchColor.
   */
  color?: string | null;
  /** An existing, active branch of the same business to copy the menu structure from. */
  copyMenuFromLocationId?: string | null;
  actorId: string | null;
}

/**
 * Copies menu categories, items, modifier groups/modifiers and the links
 * between them from one branch to another, remapping every id.
 *
 * Deliberately does NOT copy inventory items, recipes, or the chart of
 * accounts: inventory is physically local to a branch (a fresh branch has no
 * stock on hand to link a recipe's cost basis to), and the chart of accounts
 * is business-scoped already (Phase 14 decision — every branch of a business
 * shares one). Printers aren't copied either: hardware is physically at a
 * location, not a configuration to clone.
 */
async function copyMenuStructure(
  client: import("pg").PoolClient,
  fromLocationId: string,
  toLocationId: string,
): Promise<void> {
  const { rows: categories } = await client.query<{
    id: string;
    name: string;
    sort_order: number;
    is_active: boolean;
    tax_rate: string;
  }>(
    // tax_rate travels with the category (0002): a copied menu whose VAT rates
    // silently reset to 0 would under-charge tax on every order the new branch
    // rings up, and nothing on screen would show the difference.
    "SELECT id, name, sort_order, is_active, tax_rate FROM menu_categories WHERE location_id = $1",
    [fromLocationId],
  );
  const categoryIdMap = new Map<string, string>();
  for (const category of categories) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO menu_categories (location_id, name, sort_order, is_active, tax_rate)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        toLocationId,
        category.name,
        category.sort_order,
        category.is_active,
        category.tax_rate,
      ],
    );
    categoryIdMap.set(category.id, rows[0].id);
  }

  const { rows: groups } = await client.query<{
    id: string;
    name: string;
    min_select: number;
    max_select: number;
    is_active: boolean;
    sort_order: number;
  }>(
    "SELECT id, name, min_select, max_select, is_active, sort_order FROM modifier_groups WHERE location_id = $1",
    [fromLocationId],
  );
  const groupIdMap = new Map<string, string>();
  for (const group of groups) {
    // is_active/sort_order (0165) travel with the group: a copied menu whose
    // groups came back online or reordered themselves would not match what
    // the source branch sells.
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO modifier_groups (location_id, name, min_select, max_select, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        toLocationId,
        group.name,
        group.min_select,
        group.max_select,
        group.is_active,
        group.sort_order,
      ],
    );
    groupIdMap.set(group.id, rows[0].id);
  }

  const { rows: modifiers } = await client.query<{
    id: string;
    group_id: string;
    name: string;
    price_delta: string;
    is_active: boolean;
    sort_order: number;
  }>(
    `SELECT id, group_id, name, price_delta, is_active, sort_order FROM modifiers
      WHERE location_id = $1`,
    [fromLocationId],
  );
  const validModifiers = modifiers.filter((m) => groupIdMap.has(m.group_id));

  if (validModifiers.length > 0) {
    // Ids are generated here rather than read back from RETURNING: a bulk
    // INSERT ... SELECT unnest(...) RETURNING id makes no promise that the
    // returned rows come back in the order they were supplied, so the old
    // code's positional pairing of `rows[i]` with `oldIds[i]` was true only by
    // luck. Nothing downstream needs the old→new modifier mapping today
    // (modifier_ingredients is deliberately not copied), so the rows are
    // simply inserted with ids of our own choosing, the way menu_items below
    // already does.
    const newIds = validModifiers.map(() => randomUUID());
    const groupIds = validModifiers.map((m) => groupIdMap.get(m.group_id)!);
    const names = validModifiers.map((m) => m.name);
    const priceDeltas = validModifiers.map((m) => m.price_delta);
    const isActives = validModifiers.map((m) => m.is_active);
    const sortOrders = validModifiers.map((m) => m.sort_order);

    await client.query(
      `INSERT INTO modifiers (id, location_id, group_id, name, price_delta, is_active, sort_order)
       SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::numeric[], $6::boolean[], $7::integer[])`,
      [
        newIds,
        validModifiers.map(() => toLocationId),
        groupIds,
        names,
        priceDeltas,
        isActives,
        sortOrders,
      ],
    );
  }

  const { rows: items } = await client.query<{
    id: string;
    category_id: string | null;
    name: string;
    description: string | null;
    sku: string | null;
    price: string;
    image_url: string | null;
    image_media_id: string | null;
    is_active: boolean;
    sort_order: number;
    target_margin_percent: string | null;
  }>(
    `SELECT id, category_id, name, description, sku, price, image_url, image_media_id,
            is_active, sort_order, target_margin_percent
       FROM menu_items WHERE location_id = $1`,
    [fromLocationId],
  );
  const { rows: allLinks } = await client.query<{
    menu_item_id: string;
    modifier_group_id: string;
    min_select_override: number | null;
    max_select_override: number | null;
    sort_order: number;
    is_active: boolean;
  }>(
    `SELECT mg.menu_item_id, mg.modifier_group_id, mg.min_select_override,
            mg.max_select_override, mg.sort_order, mg.is_active
       FROM menu_item_modifier_groups mg
       JOIN menu_items mi ON mg.menu_item_id = mi.id
      WHERE mi.location_id = $1`,
    [fromLocationId],
  );

  if (items.length > 0) {
    const itemIds: string[] = [];
    const locationIds: string[] = [];
    const categoryIds: (string | null)[] = [];
    const names: string[] = [];
    const descriptions: (string | null)[] = [];
    const skus: (string | null)[] = [];
    const prices: string[] = [];
    const imageUrls: (string | null)[] = [];
    // The catalogue photo (0149) points at a media_assets row in the shared
    // business library — cloning a branch must keep the picture on the tile,
    // not leave every copied item faceless.
    const imageMediaIds: (string | null)[] = [];
    const isActives: boolean[] = [];
    const sortOrders: number[] = [];
    // The per-item margin override (0035) is part of how the item is priced,
    // so a copied menu that dropped it would quietly fall back to the
    // business-wide default and suggest different prices at the new branch.
    const targetMargins: (string | null)[] = [];

    const itemIdMap = new Map<string, string>();

    for (const item of items) {
      const newId = randomUUID();
      itemIdMap.set(item.id, newId);

      itemIds.push(newId);
      locationIds.push(toLocationId);
      categoryIds.push(
        item.category_id ? (categoryIdMap.get(item.category_id) ?? null) : null,
      );
      names.push(item.name);
      descriptions.push(item.description);
      skus.push(item.sku);
      prices.push(item.price);
      imageUrls.push(item.image_url);
      imageMediaIds.push(item.image_media_id);
      isActives.push(item.is_active);
      sortOrders.push(item.sort_order);
      targetMargins.push(item.target_margin_percent);
    }

    await client.query(
      `INSERT INTO menu_items
         (id, location_id, category_id, name, description, sku, price, image_url, image_media_id,
          is_active, sort_order, target_margin_percent)
       SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::text[], $9::uuid[], $10::boolean[], $11::int[], $12::numeric[])`,
      [
        itemIds,
        locationIds,
        categoryIds,
        names,
        descriptions,
        skus,
        prices,
        imageUrls,
        imageMediaIds,
        isActives,
        sortOrders,
        targetMargins,
      ],
    );

    const linkItemIds: string[] = [];
    const linkGroupIds: string[] = [];
    // Per-item bounds overrides and the 0165 columns ride along with the
    // link: without them an item cloned as "0–1 milk" would suddenly demand
    // the group default ("1–3") at the new branch.
    const linkMinOverrides: (number | null)[] = [];
    const linkMaxOverrides: (number | null)[] = [];
    const linkSortOrders: number[] = [];
    const linkIsActives: boolean[] = [];

    for (const link of allLinks) {
      const newItemId = itemIdMap.get(link.menu_item_id);
      const newGroupId = groupIdMap.get(link.modifier_group_id);
      if (!newItemId || !newGroupId) continue;

      linkItemIds.push(newItemId);
      linkGroupIds.push(newGroupId);
      linkMinOverrides.push(link.min_select_override);
      linkMaxOverrides.push(link.max_select_override);
      linkSortOrders.push(link.sort_order);
      linkIsActives.push(link.is_active);
    }

    if (linkItemIds.length > 0) {
      await client.query(
        `INSERT INTO menu_item_modifier_groups
           (menu_item_id, modifier_group_id, min_select_override, max_select_override,
            sort_order, is_active)
         SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::int[], $4::int[], $5::int[], $6::boolean[])
         ON CONFLICT DO NOTHING`,
        [
          linkItemIds,
          linkGroupIds,
          linkMinOverrides,
          linkMaxOverrides,
          linkSortOrders,
          linkIsActives,
        ],
      );
    }
  }
}

/** Creates a branch, optionally seeded with another branch's menu structure. */
export async function createBranch(
  input: CreateBranchInput,
): Promise<{ locationId: string }> {
  const name = normalizeBranchName(input.name ?? "");
  const fieldError = branchFieldsError({
    name: input.name,
    address: input.address,
    phone: input.phone,
    // `undefined` means "the caller didn't choose", which lands on the default
    // below; anything present is validated, because an unknown zone makes
    // every report for this branch fail in Postgres later (see branch-input.ts).
    timezone: input.timezone,
    // Likewise absent = "pick one for me" (see below); present = must be in
    // the palette, or 0149's CHECK turns it into a 500.
    color: input.color,
  });
  if (fieldError) throw new BranchError(fieldError, 400);

  // A non-uuid source id would make the lookup below raise
  // `invalid input syntax for type uuid` — a 500 and «خطای غیرمنتظره» instead
  // of the honest "that branch doesn't exist" this already knows how to say.
  if (input.copyMenuFromLocationId && !isUuid(input.copyMenuFromLocationId)) {
    throw new BranchError("source_branch_not_found", 404);
  }

  // The ceiling = the plan's branch limit, raised/lowered by any active
  // business override (the auditable exception path — entitlement-service).
  const ceiling = await resolveLimitCeiling(input.businessId, "branch_limit");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockBranchMutations(client, input.businessId);

    // Counted *inside* the lock rather than before it: the plan ceiling is a
    // count-then-insert, so two simultaneous «ایجاد شعبه» clicks on a
    // one-branch plan would otherwise both read "0 used" and both insert.
    if (
      ceiling.limit !== null &&
      (await activeBranchCount(input.businessId, client)) >= ceiling.limit
    ) {
      await client.query("ROLLBACK");
      throw new BranchError("branch_limit_exceeded", 403);
    }

    // One read serves both the duplicate check and the colour assignment, and
    // it is inside the lock so a concurrent create cannot pick the same free
    // colour we are about to take.
    const { rows: siblings } = await client.query<{ id: string; name: string; color: string }>(
      "SELECT id, name, color FROM locations WHERE business_id = $1",
      [input.businessId],
    );

    if (siblings.some((row) => isSameBranchName(row.name, name))) {
      await client.query("ROLLBACK");
      throw new BranchError("branch_name_taken", 409);
    }

    // An owner who expresses no preference still gets a branch they can tell
    // apart at a glance — the whole feature is worthless if every branch is
    // the same default grey until someone opens a picker.
    const color = input.color?.trim()
      ? toBranchColor(input.color.trim())
      : nextBranchColor(siblings.map((row) => row.color));

    if (input.copyMenuFromLocationId) {
      const { rows } = await client.query(
        "SELECT 1 FROM locations WHERE id = $1 AND business_id = $2 AND is_active",
        [input.copyMenuFromLocationId, input.businessId],
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        throw new BranchError("source_branch_not_found", 404);
      }
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO locations (business_id, name, address, phone, timezone, color)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        input.businessId,
        name,
        normalizeOptionalText(input.address),
        normalizeOptionalText(input.phone),
        input.timezone?.trim() || DEFAULT_BRANCH_TIMEZONE,
        color,
      ],
    );
    const locationId = rows[0].id;

    if (input.copyMenuFromLocationId) {
      await copyMenuStructure(client, input.copyMenuFromLocationId, locationId);
    }

    await client.query(
      `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, $3, 'branch.created', 'location', $4, $5)`,
      [
        input.businessId,
        locationId,
        input.actorId,
        // Separate parameter from location_id above: entity_id is text and
        // location_id is uuid, so Postgres can't type one shared placeholder.
        locationId,
        JSON.stringify({
          name,
          color,
          copiedMenuFrom: input.copyMenuFromLocationId ?? null,
        }),
      ],
    );

    await client.query("COMMIT");
    return { locationId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface UpdateBranchInput {
  businessId: string;
  locationId: string;
  actorId: string | null;
  name?: string;
  address?: string | null;
  phone?: string | null;
  /** The branch's own zone — what `app_business_date` buckets its day by. */
  timezone?: string;
  /** Palette key for the branch's identifying colour (0149). */
  color?: string;
}

/**
 * Edits a branch's name, address, phone or timezone.
 *
 * Every field is optional and `undefined` means "leave it alone"; an explicit
 * `null` on address/phone clears it. A blank `name` is rejected rather than
 * ignored: the previous implementation folded it into `coalesce($3, name)`, so
 * renaming a branch to whitespace answered `{ ok: true }` and changed nothing,
 * which reads as "the rename didn't save" with no reason given.
 *
 * The audit payload records what actually changed, not merely that something
 * did — «شعبه ویرایش شد» with no fields is not an audit trail, and the
 * timezone in particular re-buckets the branch's whole reporting history
 * (migration 0076), so it must be visible in the log.
 */
export async function updateBranch(input: UpdateBranchInput): Promise<void> {
  const fieldError = branchFieldsError({
    name: input.name,
    address: input.address,
    phone: input.phone,
    timezone: input.timezone,
    color: input.color,
  });
  if (fieldError) throw new BranchError(fieldError, 400);

  const name =
    input.name !== undefined ? normalizeBranchName(input.name) : undefined;
  const address =
    input.address !== undefined
      ? normalizeOptionalText(input.address)
      : undefined;
  const phone =
    input.phone !== undefined ? normalizeOptionalText(input.phone) : undefined;
  const timezone =
    input.timezone !== undefined ? input.timezone.trim() : undefined;
  const color =
    input.color !== undefined ? toBranchColor(input.color.trim()) : undefined;

  if (
    name === undefined &&
    address === undefined &&
    phone === undefined &&
    timezone === undefined &&
    color === undefined
  ) {
    throw new BranchError("nothing_to_change", 400);
  }

  if (!isUuid(input.locationId)) throw new BranchError("not_found", 404);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // A rename is a check-then-write against the same names `createBranch`
    // checks, so it takes the same lock: otherwise two branches renamed to the
    // same thing at once both pass, and the duplicate this refuses by hand can
    // still appear (there is no unique index to catch it — see branchNameTaken).
    await lockBranchMutations(client, input.businessId);

    if (
      name !== undefined &&
      (await branchNameTaken(client, input.businessId, name, input.locationId))
    ) {
      await client.query("ROLLBACK");
      throw new BranchError("branch_name_taken", 409);
    }

    const { rows } = await client.query<{
      id: string;
      name: string;
      address: string | null;
      phone: string | null;
      timezone: string;
      color: string;
    }>(
      `UPDATE locations
        SET name     = CASE WHEN $3::boolean  THEN $4          ELSE name     END,
            address  = CASE WHEN $5::boolean  THEN $6          ELSE address  END,
            phone    = CASE WHEN $7::boolean  THEN $8          ELSE phone    END,
            timezone = CASE WHEN $9::boolean  THEN $10::text   ELSE timezone END,
            color    = CASE WHEN $11::boolean THEN $12::text   ELSE color    END
      WHERE id = $1 AND business_id = $2
      RETURNING id, name, address, phone, timezone, color`,
      [
        input.locationId,
        input.businessId,
        name !== undefined,
        name ?? null,
        address !== undefined,
        address,
        phone !== undefined,
        phone,
        timezone !== undefined,
        timezone ?? null,
        color !== undefined,
        color ?? null,
      ],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      throw new BranchError("not_found", 404);
    }

    const changed: Record<string, unknown> = {};
    if (name !== undefined) changed.name = name;
    if (address !== undefined) changed.address = address;
    if (phone !== undefined) changed.phone = phone;
    if (timezone !== undefined) changed.timezone = timezone;
    if (color !== undefined) changed.color = color;

    await client.query(
      `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, $3, 'branch.updated', 'location', $4, $5)`,
      [
        input.businessId,
        input.locationId,
        input.actorId,
        input.locationId,
        JSON.stringify(changed),
      ],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Deactivating a branch is a soft, reversible operation (Phase 14 decision):
 * it drops out of `businessLocations()`, so it stops being reachable for new
 * work — no member can switch into it, and it disappears from every "active
 * branch" default — while every historical row stays exactly where it is.
 *
 * Blocked while the branch has open orders or open table sessions: allowing
 * that would leave live operational state behind in a branch nobody can act
 * in anymore. Draft purchases and unposted stock counts are not blocked —
 * they have no live "in progress on the floor" quality — but they become
 * unreachable through the UI until the branch is reactivated.
 */
export async function deactivateBranch(
  businessId: string,
  locationId: string,
  actorId: string | null,
): Promise<void> {
  if (!isUuid(locationId)) throw new BranchError("not_found", 404);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // Check-then-write, so it has to be exclusive: without the lock, two
    // owners (or two tabs) deactivating the last two branches at the same
    // instant both read "2 active" and both succeed — leaving a business with
    // zero active branches, which is unrecoverable from the UI: every screen
    // resolves no branch, `resolveActiveLocation` answers null, and the branch
    // list itself is behind a guard that needs one.
    await lockBranchMutations(client, businessId);

    const { rows: locked } = await client.query<{
      id: string;
      is_active: boolean;
    }>("SELECT id, is_active FROM locations WHERE business_id = $1", [
      businessId,
    ]);
    const target = locked.find((row) => row.id === locationId);
    if (!target) {
      await client.query("ROLLBACK");
      throw new BranchError("not_found", 404);
    }
    if (!target.is_active) {
      await client.query("ROLLBACK");
      throw new BranchError("branch_already_inactive", 409);
    }
    if (locked.filter((row) => row.is_active).length <= 1) {
      await client.query("ROLLBACK");
      throw new BranchError("last_active_branch", 409);
    }

    const { rows: openOrders } = await client.query(
      "SELECT 1 FROM orders WHERE location_id = $1 AND status IN ('open', 'held') LIMIT 1",
      [locationId],
    );
    if (openOrders.length > 0) {
      await client.query("ROLLBACK");
      throw new BranchError("branch_has_open_orders", 409);
    }

    const { rows: openSessions } = await client.query(
      "SELECT 1 FROM table_sessions WHERE location_id = $1 AND closed_at IS NULL LIMIT 1",
      [locationId],
    );
    if (openSessions.length > 0) {
      await client.query("ROLLBACK");
      throw new BranchError("branch_has_open_sessions", 409);
    }

    await client.query(
      "UPDATE locations SET is_active = false WHERE id = $1 AND business_id = $2",
      [locationId, businessId],
    );

    await client.query(
      `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id)
       VALUES ($1, $2, $3, 'branch.deactivated', 'location', $4)`,
      [businessId, locationId, actorId, locationId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Brings a deactivated branch back.
 *
 * Subject to the plan's branch ceiling, exactly as creation is: `branchLimit`
 * is counted against *active* branches (plan-limits.ts's `activeBranchCount`),
 * so without this check a business could keep as many branches as it liked by
 * deactivating one and reactivating another — or simply exceed a plan it had
 * been downgraded to, since a downgrade leaves the extra branches in place.
 * Creation refusing what reactivation waves through was the hole.
 */
export async function reactivateBranch(
  businessId: string,
  locationId: string,
  actorId: string | null,
): Promise<void> {
  if (!isUuid(locationId)) throw new BranchError("not_found", 404);

  // Override-aware ceiling, exactly as creation enforces it.
  const ceiling = await resolveLimitCeiling(businessId, "branch_limit");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // Same lock as create/deactivate: reactivation is a count-then-write
    // against the very same ceiling creation checks.
    await lockBranchMutations(client, businessId);

    const { rows: locked } = await client.query<{
      id: string;
      is_active: boolean;
    }>("SELECT id, is_active FROM locations WHERE business_id = $1", [
      businessId,
    ]);
    const target = locked.find((row) => row.id === locationId);
    if (!target) {
      await client.query("ROLLBACK");
      throw new BranchError("not_found", 404);
    }
    if (target.is_active) {
      await client.query("ROLLBACK");
      throw new BranchError("branch_already_active", 409);
    }

    if (
      ceiling.limit !== null &&
      locked.filter((row) => row.is_active).length >= ceiling.limit
    ) {
      await client.query("ROLLBACK");
      throw new BranchError("branch_limit_exceeded", 403);
    }

    await client.query(
      "UPDATE locations SET is_active = true WHERE id = $1 AND business_id = $2",
      [locationId, businessId],
    );

    await client.query(
      `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id)
       VALUES ($1, $2, $3, 'branch.reactivated', 'location', $4)`,
      [businessId, locationId, actorId, locationId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
