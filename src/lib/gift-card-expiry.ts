/**
 * Gift-card expiry (issue #764) — the pure half.
 *
 * Expiry is opt-in. A business that never sets «اعتبار کارت هدیه» in Growth
 * settings keeps today's behaviour: cards never expire. With a validity of N
 * months, a card issued on business day D is good *through* D + N months —
 * the stored `expires_at` is the last day it can be spent — and from the next
 * day it can no longer be redeemed.
 *
 * Expiring a card never moves money on its own. Its remaining balance is a
 * liability (2420) until a person runs «ثبت انقضا», which posts the breakage
 * to «سایر درآمدها» (4900) once per card. That keeps the one irreversible
 * step — turning a customer's prepaid value into income — a human decision.
 *
 * Dates are ISO `YYYY-MM-DD` business days; the screen renders them Shamsi.
 */

export const GIFT_CARD_VALIDITY_LIMITS = { min: 1, max: 120 } as const;

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/**
 * The last valid day of a card issued on `issuedOn` with a validity of
 * `months`, or null when cards do not expire. Month arithmetic clamps to the
 * end of the month: a card issued on 31 January with one month is good
 * through the last day of February, never «3 March».
 */
export function giftCardExpiryDate(issuedOn: string, months: number | null): string | null {
  if (months === null) return null;
  if (!isIsoDate(issuedOn)) throw new Error(`invalid business date: ${issuedOn}`);
  if (!Number.isInteger(months) || months < GIFT_CARD_VALIDITY_LIMITS.min || months > GIFT_CARD_VALIDITY_LIMITS.max) {
    throw new Error(`invalid gift-card validity: ${months}`);
  }
  const [year, month, day] = issuedOn.split("-").map(Number);
  const targetMonthIndex = month - 1 + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = targetMonthIndex % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const result = new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)));
  return result.toISOString().slice(0, 10);
}

/** True from the day after `expiresAt`; a card with no expiry never expires. */
export function isGiftCardExpired(expiresAt: string | null, today: string): boolean {
  return expiresAt !== null && today > expiresAt;
}
