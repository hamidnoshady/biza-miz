-- Issue #764 — opt-in gift-card expiry.
--
-- `gift_cards.expires_at` is the last business day a card can be spent; NULL
-- (every existing card, and every card while the business has not opted in)
-- means it never expires. The validity is a Growth-wide setting; NULL keeps
-- today's behaviour. Turning an expired card's remaining balance into income
-- is a separate, human-triggered posting (promotions.gift_card_expired:
-- Dr 2420 / Cr 4900), never a side effect of this column.
ALTER TABLE gift_cards ADD COLUMN expires_at date;
CREATE INDEX idx_gift_cards_expiring ON gift_cards (business_id, expires_at) WHERE expires_at IS NOT NULL;

ALTER TABLE growth_settings
    ADD COLUMN gift_card_validity_months integer CHECK (gift_card_validity_months BETWEEN 1 AND 120);
