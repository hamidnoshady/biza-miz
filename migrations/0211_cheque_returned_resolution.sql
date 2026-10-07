-- ---------------------------------------------------------------------------
-- Cheques: the returned cheque gets a life after the bounce — issue #828 (2).
-- ---------------------------------------------------------------------------
-- Migration 0095 made `bounced` terminal, so a returned cheque's value stayed
-- parked in «۱۲۴۴ چک‌های برگشتی» / «۲۱۲۲ چک‌های پرداختنی برگشتی» with no
-- supported way out: the documented "register a new cheque row" is not
-- accounting-equivalent, because a fresh receivable registration credits
-- حساب‌های دریافتنی a second time instead of moving the returned balance.
--
-- Two resolutions are added, both of which empty the returned account:
--
--   settle  — the counterparty paid (or we paid) another way:
--             receivable  Debit بانک   / Credit ۱۲۴۴      -> cleared
--             payable     Debit ۲۱۲۲   / Credit بانک      -> cleared
--   restore — the debt goes back where it came from, which is also what a
--             replacement cheque needs before it is registered normally:
--             receivable  Debit ۱۲۰۰   / Credit ۱۲۴۴      -> resolved
--             payable     Debit ۲۱۲۲   / Credit ۲۱۰۰      -> resolved
--
-- `resolved` is a new terminal status shared by both directions: it says "this
-- instrument is finished and its balance has been moved on", which neither
-- `cleared` (the money moved) nor `cancelled` (payable-only, never presented)
-- truthfully says. History stays append-only — a resolution is a new event.

ALTER TYPE cheque_status ADD VALUE IF NOT EXISTS 'resolved';

COMMENT ON TYPE cheque_status IS
    'Cheque lifecycle status. `resolved` (0211) closes a returned cheque whose balance was moved out of 1244/2122 by a settle/restore resolution.';
