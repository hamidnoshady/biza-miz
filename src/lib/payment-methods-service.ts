/**
 * Payment ways, DB side (migration 0091). The rules live in
 * payment-methods.ts; this file only reads and writes rows, so per repo
 * convention it has no direct unit test.
 *
 * One thing here is worth knowing before changing it: `ensurePaymentMethods`
 * seeds a business's built-in ways on first read. Migration 0091 seeds every
 * business that existed when it ran, and `provisionBusiness` seeds every
 * business created after it — but a business can also arrive by a restored
 * backup or a branch pairing, and a till with an empty payment grid is a shop
 * that cannot take money. Seeding on read closes that off for good, and is a
 * no-op (one indexed count) on every subsequent call.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import {
  BUILTIN_PAYMENT_METHODS,
  builtinPaymentMethodsFor,
  isExactPaymentMethodOrder,
  paymentMethodCodeFor,
  sortPaymentMethods,
  type PaymentMethodView,
  type PaymentSettlement,
  type ValidatedPaymentMethod,
} from "./payment-methods";

interface PaymentMethodRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  settlement: PaymentSettlement;
  sort_order: number;
  is_active: boolean;
  is_builtin: boolean;
  opens_drawer: boolean;
  requires_reference: boolean;
}

function toView(row: PaymentMethodRow): PaymentMethodView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    settlement: row.settlement,
    sortOrder: Number(row.sort_order),
    isActive: row.is_active,
    isBuiltin: row.is_builtin,
    opensDrawer: row.opens_drawer,
    requiresReference: row.requires_reference,
  };
}

const SELECT_COLUMNS =
  "id, code, name, settlement::text AS settlement, sort_order, is_active, is_builtin, opens_drawer, requires_reference";

/** Seeds the built-in ways if this business has none yet. Idempotent. */
export async function ensurePaymentMethods(businessId: string): Promise<void> {
  const { rows } = await query<{ count: string }>(
    "SELECT count(*)::text AS count FROM payment_methods WHERE business_id = $1",
    [businessId],
  );
  if (Number(rows[0]?.count ?? 0) > 0) return;
  await seedForBusiness(businessId);
}

async function seedForBusiness(businessId: string): Promise<void> {
  const { rows: bizRows } = await query<{ industry: string }>("SELECT industry FROM businesses WHERE id = $1", [
    businessId,
  ]);
  const client = await getPool().connect();
  try {
    await seedPaymentMethods(client, businessId, bizRows[0]?.industry ?? "food_service");
  } finally {
    client.release();
  }
}

/**
 * Inserts a business's built-in ways. Used by provisioning (inside the
 * transaction that creates the business) and by the lazy seed above.
 */
export async function seedPaymentMethods(
  client: PoolClient,
  businessId: string,
  industry: string,
): Promise<void> {
  for (const method of builtinPaymentMethodsFor(industry)) {
    await client.query(
      `INSERT INTO payment_methods (business_id, code, name, settlement, sort_order, is_builtin, opens_drawer)
       VALUES ($1, $2, $3, $4::payment_method, $5, true, $6)
       ON CONFLICT (business_id, code) DO NOTHING`,
      [businessId, method.code, method.name, method.settlement, method.sortOrder, method.opensDrawer],
    );
  }
}

const FOOD_SERVICE_ONLY_CODES = BUILTIN_PAYMENT_METHODS
  .filter((method) => method.foodServiceOnly)
  .map((method) => method.code);

/**
 * Reconcile the built-in ways that belong to one industry when the platform
 * changes a business's trade. Generic and custom ways are never rewritten.
 *
 * SnapFood remains as an inactive row after leaving food_service so old
 * payments keep their payment_method_id and the enum settlement they posted.
 * Returning to food_service seeds any missing built-ins and re-enables the
 * required F&B methods; ON CONFLICT DO NOTHING preserves names, ordering and
 * other user configuration on rows that already exist.
 */
export async function reconcilePaymentMethodsForIndustry(
  client: PoolClient,
  businessId: string,
  previousIndustry: string,
  nextIndustry: string,
): Promise<void> {
  if (previousIndustry === nextIndustry) return;

  if (nextIndustry === "food_service") {
    await seedPaymentMethods(client, businessId, nextIndustry);
    if (FOOD_SERVICE_ONLY_CODES.length > 0) {
      await client.query(
        `UPDATE payment_methods
            SET is_active = true
          WHERE business_id = $1 AND is_builtin AND code = ANY($2::text[])`,
        [businessId, FOOD_SERVICE_ONLY_CODES],
      );
    }
    return;
  }

  if (previousIndustry === "food_service" && FOOD_SERVICE_ONLY_CODES.length > 0) {
    await client.query(
      `UPDATE payment_methods
          SET is_active = false
        WHERE business_id = $1 AND is_builtin AND is_active AND code = ANY($2::text[])`,
      [businessId, FOOD_SERVICE_ONLY_CODES],
    );
  }
}

export interface ListPaymentMethodsOptions {
  /** Checkout screens want only what they may offer; the settings tab wants everything. */
  includeInactive?: boolean;
}

export async function listPaymentMethods(
  businessId: string,
  options: ListPaymentMethodsOptions = {},
): Promise<PaymentMethodView[]> {
  // One read covering every method applicable to this industry's settings
  // grid (active or not) doubles as the "has this business been seeded yet"
  // check, so the common case — already seeded — costs one round trip instead
  // of the seed-check-then-list pair this used to run on every call. Retained
  // F&B-only rows are excluded from the view and direct-id lookups below.
  const industryMethodFilter = `
    AND (COALESCE((SELECT industry FROM businesses WHERE id = $1), 'food_service') = 'food_service'
         OR code <> ALL($2::text[]))`;
  let { rows } = await query<PaymentMethodRow>(
    `SELECT ${SELECT_COLUMNS} FROM payment_methods WHERE business_id = $1${industryMethodFilter}`,
    [businessId, FOOD_SERVICE_ONLY_CODES],
  );
  if (rows.length === 0) {
    await seedForBusiness(businessId);
    ({ rows } = await query<PaymentMethodRow>(
      `SELECT ${SELECT_COLUMNS} FROM payment_methods WHERE business_id = $1${industryMethodFilter}`,
      [businessId, FOOD_SERVICE_ONLY_CODES],
    ));
  }
  const views = options.includeInactive ? rows.map(toView) : rows.filter((r) => r.is_active).map(toView);
  return sortPaymentMethods(views);
}

/**
 * The ways named by a checkout's tenders, keyed by id — how a route turns
 * "the cashier tapped these two buttons" into the settlements the ledger
 * posts. Ids that don't belong to this business simply don't come back, which
 * is what makes the caller's "every tender resolved" check an authorization
 * check too.
 */
export async function paymentMethodsByIds(
  businessId: string,
  ids: readonly string[],
): Promise<Map<string, PaymentMethodView>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { rows } = await query<PaymentMethodRow>(
    `SELECT ${SELECT_COLUMNS} FROM payment_methods
      WHERE business_id = $1 AND id = ANY($2::uuid[])
        AND (COALESCE((SELECT industry FROM businesses WHERE id = $1), 'food_service') = 'food_service'
             OR code <> ALL($3::text[]))`,
    [businessId, unique, FOOD_SERVICE_ONLY_CODES],
  );
  return new Map(rows.map((row) => [row.id, toView(row)]));
}

/** The business's way with this code (`cash`, `card`, …), or null. */
export async function paymentMethodByCode(businessId: string, code: string): Promise<PaymentMethodView | null> {
  const { rows } = await query<PaymentMethodRow>(
    `SELECT ${SELECT_COLUMNS} FROM payment_methods
      WHERE business_id = $1 AND code = $2
        AND (COALESCE((SELECT industry FROM businesses WHERE id = $1), 'food_service') = 'food_service'
             OR code <> ALL($3::text[]))`,
    [businessId, code, FOOD_SERVICE_ONLY_CODES],
  );
  return rows[0] ? toView(rows[0]) : null;
}

export async function createPaymentMethod(
  businessId: string,
  input: ValidatedPaymentMethod,
): Promise<PaymentMethodView> {
  const existing = await listPaymentMethods(businessId, { includeInactive: true });
  // Hidden industry-only rows still reserve their code. Otherwise a custom
  // method added outside F&B could collide with the retained SnapFood row.
  const allCodes = await query<{ code: string }>(
    "SELECT code FROM payment_methods WHERE business_id = $1",
    [businessId],
  );
  const code = paymentMethodCodeFor(input.name, allCodes.rows.map((method) => method.code));
  // Added ways land after everything already configured, so adding one never
  // reshuffles a grid the cashiers have learned.
  const sortOrder = existing.reduce((max, method) => Math.max(max, method.sortOrder), 0) + 10;
  const { rows } = await query<PaymentMethodRow>(
    `INSERT INTO payment_methods
       (business_id, code, name, settlement, sort_order, is_builtin, opens_drawer, requires_reference)
     VALUES ($1, $2, $3, $4::payment_method, $5, false, $6, $7)
     RETURNING ${SELECT_COLUMNS}`,
    [businessId, code, input.name, input.settlement, sortOrder, input.opensDrawer, input.requiresReference],
  );
  return toView(rows[0]);
}

export interface PaymentMethodPatch {
  name?: string;
  settlement?: PaymentSettlement;
  isActive?: boolean;
  opensDrawer?: boolean;
  requiresReference?: boolean;
}

export async function updatePaymentMethod(
  businessId: string,
  id: string,
  patch: PaymentMethodPatch,
): Promise<PaymentMethodView | null> {
  const { rows } = await query<PaymentMethodRow>(
    `UPDATE payment_methods
        SET name = coalesce($3, name),
            settlement = coalesce($4::payment_method, settlement),
            is_active = coalesce($5, is_active),
            opens_drawer = coalesce($6, opens_drawer),
            requires_reference = coalesce($7, requires_reference)
      WHERE business_id = $1 AND id = $2
        AND (COALESCE((SELECT industry FROM businesses WHERE id = $1), 'food_service') = 'food_service'
             OR code <> ALL($8::text[]))
      RETURNING ${SELECT_COLUMNS}`,
    [
      businessId,
      id,
      patch.name ?? null,
      patch.settlement ?? null,
      patch.isActive ?? null,
      patch.opensDrawer ?? null,
      patch.requiresReference ?? null,
      FOOD_SERVICE_ONLY_CODES,
    ],
  );
  return rows[0] ? toView(rows[0]) : null;
}

/** How many payments were taken this way — what makes a way undeletable. */
export async function paymentCountForMethod(businessId: string, id: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM payments p
       JOIN locations l ON l.id = p.location_id
      WHERE l.business_id = $1 AND p.payment_method_id = $2`,
    [businessId, id],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function deletePaymentMethod(businessId: string, id: string): Promise<boolean> {
  // Keep the history guarantee atomic. A payment created between an API-level
  // count and this DELETE must not silently lose its named way through the
  // foreign key's ON DELETE SET NULL.
  const { rowCount } = await query(
    `DELETE FROM payment_methods pm
      WHERE pm.business_id = $1
        AND pm.id = $2
        AND NOT pm.is_builtin
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.payment_method_id = pm.id)`,
    [businessId, id],
  );
  return rowCount === 1;
}

/**
 * Rewrites the complete display order in one transaction. The row lock makes
 * concurrent settings tabs serialize, and the exact-set check prevents a
 * partial/duplicated/foreign list from creating tied, unstable positions.
 */
export async function reorderPaymentMethods(businessId: string, orderedIds: readonly string[]): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM payment_methods
        WHERE business_id = $1
          AND (COALESCE((SELECT industry FROM businesses WHERE id = $1), 'food_service') = 'food_service'
               OR code <> ALL($2::text[]))
        FOR UPDATE`,
      [businessId, FOOD_SERVICE_ONLY_CODES],
    );
    if (!isExactPaymentMethodOrder(rows.map((row) => row.id), orderedIds)) {
      await client.query("ROLLBACK");
      return false;
    }
    for (const [index, id] of orderedIds.entries()) {
      await client.query("UPDATE payment_methods SET sort_order = $3 WHERE business_id = $1 AND id = $2", [
        businessId,
        id,
        (index + 1) * 10,
      ]);
    }
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
