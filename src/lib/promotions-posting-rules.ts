/**
 * Phase 27 Wave 6 — gift-card posting rules.
 *
 * A gift card's value is a liability, never a balance column. Issuing one
 * takes the customer's cash and credits «کارت هدیه» (2420); redeeming it
 * debits that liability. Neither rule touches a revenue account — the goods
 * the card later buys are posted by the ordinary sale path, so a gift card
 * can never book revenue twice.
 */
import { WELL_KNOWN_CODES } from "./coa-template";
import { rialBigInt, type RialText } from "./inventory-exact";
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";

const ZERO = "0" as RialText;

interface GiftCardEventPayload {
  giftCardId: string;
  amount: RialText;
}

registerPostingRule("promotions.gift_card_issued", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as GiftCardEventPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.cash,
    WELL_KNOWN_CODES.giftCardPayable,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.cash)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.giftCardPayable)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "صدور کارت هدیه",
    postingKind: "gift_card_issued",
  };
});

registerPostingRule("promotions.gift_card_redeemed", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as GiftCardEventPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.giftCardPayable,
    WELL_KNOWN_CODES.cash,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.giftCardPayable)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.cash)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "مصرف کارت هدیه",
    postingKind: "gift_card_redeemed",
  };
});

/**
 * Issue #764 — an expired gift card's remaining balance leaves the liability
 * and becomes «سایر درآمدها» (breakage). Emitted only by the human-run expiry
 * sweep (`expireGiftCards`), once per card: the ledger's
 * (source, posting_kind) uniqueness makes a second run a no-op. No cash moves.
 */
registerPostingRule("promotions.gift_card_expired", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as GiftCardEventPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.giftCardPayable,
    WELL_KNOWN_CODES.otherIncome,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.giftCardPayable)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.otherIncome)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "انقضای کارت هدیه — ماندهٔ استفاده‌نشده",
    postingKind: "gift_card_expired",
  };
});
