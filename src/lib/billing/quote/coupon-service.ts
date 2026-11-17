/**
 * ESH-193 / #1378 — coupon validation, holds and redemption.
 *
 * The lifecycle is deliberately three steps, not one:
 *
 *   1. **resolve** — read a code and answer whether *this business* may use it
 *      for *this term* right now. Read-only; a quote is built from the answer.
 *   2. **reserve** — take a hold for the quote. Inside one transaction the
 *      coupon row is locked, expired holds are released, the per-business cap
 *      is counted, and the hold is inserted. The partial unique index is the
 *      final authority, so two concurrent checkouts cannot both hold one code.
 *   3. **redeem** — called from `consumeQuote` in the settlement transaction.
 *      The global cap is spent here (`redeemed_count < max_redemptions`), never
 *      at reservation: an abandoned quote must not exhaust a campaign.
 *
 * A coupon is one of two shapes, never both (a CHECK in migration 0304):
 * a percentage in basis points of the post-term-discount recurring total, or a
 * flat Rial amount clamped to that same base. There is no stacking: the quote
 * carries at most one coupon, and the product has no second coupon field.
 */
import type { PoolClient } from "pg";
import { query, withTenant, withTenantTransaction } from "../../db";
import type { QuoteCoupon } from "./plan-quote";

export type CouponRefusal =
  | "coupon_not_found"
  | "coupon_inactive"
  | "coupon_not_yet_valid"
  | "coupon_expired"
  | "coupon_term_not_eligible"
  | "coupon_already_used"
  | "coupon_exhausted";

interface CouponRow extends Record<string, unknown> {
  id: string;
  code: string;
  discount_kind: "percent" | "fixed";
  percent_basis_points: number | null;
  amount_rial: string | number | null;
  min_term_months: number;
  valid_from: Date | string;
  valid_until: Date | string | null;
  max_redemptions: number | null;
  max_redemptions_per_business: number;
  redeemed_count: number;
  status: "active" | "paused" | "retired";
}

export type ResolvedCoupon =
  | { ok: true; couponId: string; coupon: QuoteCoupon }
  | { ok: false; error: CouponRefusal };

/**
 * May this business use this code for this term, right now?
 *
 * Read-only and non-binding: the answer can go stale before payment, which is
 * why `reserveCoupon` re-validates the same row under a lock. Errors are codes
 * because the UI renders its own sentences.
 */
export async function resolveCoupon(input: {
  code: string;
  businessId: string;
  termMonths: number;
  now?: Date;
}): Promise<ResolvedCoupon> {
  const code = input.code.trim();
  if (!code) return { ok: false, error: "coupon_not_found" };
  const now = input.now ?? new Date();

  const row = await withTenant(input.businessId, async () => {
    const { rows } = await query<CouponRow>(
      `SELECT id, code::text AS code, discount_kind, percent_basis_points, amount_rial,
              min_term_months, valid_from, valid_until, max_redemptions,
              max_redemptions_per_business, redeemed_count, status
         FROM billing_coupons
        WHERE code = $1`,
      [code],
    );
    return rows[0] ?? null;
  });
  if (!row) return { ok: false, error: "coupon_not_found" };

  const invalid = validateCoupon(row, input.termMonths, now);
  if (invalid) return { ok: false, error: invalid };

  const { rows: usage } = await withTenant(input.businessId, () =>
    query<{ used: string }>(
      `SELECT count(*)::text AS used
         FROM billing_coupon_redemptions
        WHERE coupon_id = $1
          AND business_id = $2
          AND status = 'redeemed'`,
      [row.id, input.businessId],
    ),
  );
  if (Number(usage[0]?.used ?? 0) >= row.max_redemptions_per_business) {
    return { ok: false, error: "coupon_already_used" };
  }

  return { ok: true, couponId: row.id, coupon: toQuoteCoupon(row) };
}

export type ReserveCouponResult =
  | { ok: true; redemptionId: string; reservedUntil: string }
  | { ok: false; error: CouponRefusal | "coupon_reservation_missing" };

/**
 * Hold a coupon for one quote.
 *
 * `reservedUntil` is the quote's own expiry, so a hold never outlives the quote
 * that justifies it. An expired hold is released on the next attempt instead of
 * blocking the business forever.
 */
export async function reserveCoupon(input: {
  couponId: string;
  businessId: string;
  termMonths: number;
  amountRial: number;
  reservedUntil: Date;
  now?: Date;
}): Promise<ReserveCouponResult> {
  if (!Number.isSafeInteger(input.amountRial) || input.amountRial < 0) {
    return { ok: false, error: "coupon_reservation_missing" };
  }
  const now = input.now ?? new Date();

  try {
    return await withTenantTransaction(input.businessId, async (client) => {
      await client.query(
        `UPDATE billing_coupon_redemptions
            SET status = 'released'
          WHERE business_id = $1
            AND coupon_id = $2
            AND status = 'reserved'
            AND reserved_until <= $3`,
        [input.businessId, input.couponId, now.toISOString()],
      );

      const { rows } = await client.query<CouponRow>(
        `SELECT id, code::text AS code, discount_kind, percent_basis_points, amount_rial,
                min_term_months, valid_from, valid_until, max_redemptions,
                max_redemptions_per_business, redeemed_count, status
           FROM billing_coupons
          WHERE id = $1
          FOR UPDATE`,
        [input.couponId],
      );
      const row = rows[0];
      if (!row) return { ok: false as const, error: "coupon_not_found" as const };

      const invalid = validateCoupon(row, input.termMonths, now);
      if (invalid) return { ok: false as const, error: invalid };
      if (row.max_redemptions !== null && row.redeemed_count >= row.max_redemptions) {
        return { ok: false as const, error: "coupon_exhausted" as const };
      }

      const { rows: usage } = await client.query<{ used: string }>(
        `SELECT count(*)::text AS used
           FROM billing_coupon_redemptions
          WHERE coupon_id = $1
            AND business_id = $2
            AND status = 'redeemed'`,
        [input.couponId, input.businessId],
      );
      if (Number(usage[0]?.used ?? 0) >= row.max_redemptions_per_business) {
        return { ok: false as const, error: "coupon_already_used" as const };
      }

      const { rows: inserted } = await client.query<{ id: string }>(
        `INSERT INTO billing_coupon_redemptions
           (coupon_id, business_id, status, amount_rial, reserved_until)
         VALUES ($1, $2, 'reserved', $3, $4)
         RETURNING id`,
        [input.couponId, input.businessId, input.amountRial, input.reservedUntil.toISOString()],
      );

      return {
        ok: true as const,
        redemptionId: inserted[0].id,
        reservedUntil: input.reservedUntil.toISOString(),
      };
    });
  } catch (error) {
    // The partial unique index is the authority on "one open hold"; a racing
    // checkout lands here rather than in a read-then-write gap.
    if (isUniqueViolation(error)) return { ok: false, error: "coupon_already_used" };
    throw error;
  }
}

/** Give a hold back without spending it (quote cancelled or re-quoted). */
export async function releaseCouponReservation(input: {
  redemptionId: string;
  businessId: string;
}): Promise<void> {
  await withTenant(input.businessId, () =>
    query(
      `UPDATE billing_coupon_redemptions
          SET status = 'released'
        WHERE id = $1
          AND business_id = $2
          AND status = 'reserved'`,
      [input.redemptionId, input.businessId],
    ),
  );
}

export type RedeemCouponResult =
  | { ok: true }
  | { ok: false; error: "coupon_exhausted" | "coupon_reservation_missing" };

/**
 * Spend a coupon's hold from inside the settlement transaction.
 *
 * Caller owns the transaction and must already have consumed the quote; a
 * refusal here rolls the settlement back, which is the point — a settlement
 * that cannot spend its coupon must not go through at the discounted price.
 */
export async function redeemCouponForQuote(
  client: PoolClient,
  input: { couponId: string; quoteId: string; businessId: string },
): Promise<RedeemCouponResult> {
  const { rows: reservation } = await client.query<{ id: string }>(
    `UPDATE billing_coupon_redemptions
        SET status = 'redeemed', redeemed_at = now()
      WHERE quote_id = $1
        AND business_id = $2
        AND status = 'reserved'
    RETURNING id`,
    [input.quoteId, input.businessId],
  );
  if (!reservation[0]) return { ok: false, error: "coupon_reservation_missing" };

  // The global cap is spent atomically: two settlements of the last use cannot
  // both increment. A refusal rolls the whole settlement back.
  const { rows: coupon } = await client.query<{ id: string }>(
    `UPDATE billing_coupons
        SET redeemed_count = redeemed_count + 1,
            updated_at     = now()
      WHERE id = $1
        AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)
    RETURNING id`,
    [input.couponId],
  );
  if (!coupon[0]) return { ok: false, error: "coupon_exhausted" };
  return { ok: true };
}

function validateCoupon(
  row: CouponRow,
  termMonths: number,
  now: Date,
): CouponRefusal | null {
  if (row.status !== "active") return "coupon_inactive";
  if (new Date(row.valid_from).getTime() > now.getTime()) return "coupon_not_yet_valid";
  if (row.valid_until !== null && new Date(row.valid_until).getTime() <= now.getTime()) {
    return "coupon_expired";
  }
  if (termMonths < row.min_term_months) return "coupon_term_not_eligible";
  return null;
}

function toQuoteCoupon(row: CouponRow): QuoteCoupon {
  return row.discount_kind === "percent"
    ? { kind: "percent", value: Number(row.percent_basis_points), code: row.code }
    : { kind: "fixed", value: Number(row.amount_rial), code: row.code };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}
