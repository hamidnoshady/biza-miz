-- ============================================================================
-- 0321_orders_client_request_pairing_repair.sql — issue #1446 follow-up.
--
-- `orders_client_request_pairing` (0233) requires the checkout idempotency key
-- and its request fingerprint to be present together:
--
--     CHECK ((client_request_id IS NULL) = (request_fingerprint IS NULL))
--
-- It was added `NOT VALID` because orders written before that release can hold
-- the key without the fingerprint. A `NOT VALID` constraint is still enforced
-- on every INSERT and UPDATE, so any later write to such a legacy order — an
-- `order.state.synced` replay on central, a payment, a void — fails with
-- SQLSTATE 23514 and keeps failing. On 2026-11-24 the live database held 810
-- orders in that shape, 3 of them still open.
--
-- The fingerprint is a hash of the original request body, which is not stored
-- anywhere and cannot be recomputed. Clearing the key instead would let a
-- delayed retry create a *second* order, so this migration keeps the key and
-- derives a deterministic placeholder fingerprint from it. A retry that still
-- carries the original request will not match the placeholder and is refused
-- as an idempotency conflict — the safe outcome, because no duplicate order is
-- created. Nothing a customer sees, and no order/line/payment/ledger row, is
-- read, changed or deleted.
--
-- The reverse shape (a fingerprint with no key) has no request to replay, so
-- the orphan fingerprint is cleared. This migration repairs both directions.
--
-- Forward-only and idempotent. Rolling back means writing the NULL again,
-- which restores the UPDATE failure this migration removes. `VALIDATE
-- CONSTRAINT` scans the table once, does not block ordinary reads/writes, and
-- makes the end state explicit instead of leaving a repaired-but-unvalidated
-- constraint behind.
-- ============================================================================

UPDATE orders
   SET request_fingerprint = encode(
         sha256(convert_to('legacy-client-request:' || client_request_id, 'UTF8')),
         'hex'
       )
 WHERE client_request_id IS NOT NULL
   AND request_fingerprint IS NULL;

UPDATE orders
   SET request_fingerprint = NULL
 WHERE client_request_id IS NULL
   AND request_fingerprint IS NOT NULL;

ALTER TABLE orders VALIDATE CONSTRAINT orders_client_request_pairing;
