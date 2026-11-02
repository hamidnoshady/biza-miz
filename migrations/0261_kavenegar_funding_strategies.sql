-- Issue #902 §3 — funding STRATEGIES, not just a buffer target.
--
-- `0259` gave the platform one funding rule: whenever a child's balance is below
-- `bufferMessages × wholesale`, plan a transfer up to that target. That is a
-- correct JIT reserve, but the issue asks for a policy an operator can choose
-- between, and for a guard that stops one busy tenant from consuming the master
-- account meant for everyone:
--
--   * `jit`           — the 0259 behaviour (top up on every pass).
--   * `low_watermark` — refill only after the child drops below a trigger, then
--                       refill to the full target. Hysteresis: a child sitting
--                       one message under target is not topped up every 15
--                       minutes for the rest of the day.
--   * `scheduled`     — JIT, but only inside a UTC hour window, so provider
--                       traffic and master-account exposure happen in one
--                       predictable window rather than continuously.
--   * `manual`        — explicit "never automatically fund" (distinct from a
--                       zero buffer, which reads like a misconfiguration).
--
-- `managed_funding_global_daily_cap_rial` is the cross-business demand guard: a
-- ceiling on what ALL children may receive in one rolling day, checked before
-- the per-child caps, so a fleet that suddenly needs credit cannot drain the
-- master in a single pass.
--
-- Defaults keep today's behaviour exactly: strategy `jit`, no watermark, no
-- window (0/0), no global cap. Nothing turns itself on.

ALTER TABLE platform_sms_config
    ADD COLUMN managed_funding_strategy text NOT NULL DEFAULT 'jit'
        CHECK (managed_funding_strategy IN ('jit', 'low_watermark', 'scheduled', 'manual')),
    -- Trigger level in messages for `low_watermark`. 0 (or >= the buffer) means
    -- "same as the target", i.e. plain JIT behaviour.
    ADD COLUMN managed_funding_low_watermark_messages integer NOT NULL DEFAULT 0
        CHECK (managed_funding_low_watermark_messages BETWEEN 0 AND 1_000_000),
    -- UTC hour window for `scheduled`. start = end means "all day".
    ADD COLUMN managed_funding_window_start_hour integer NOT NULL DEFAULT 0
        CHECK (managed_funding_window_start_hour BETWEEN 0 AND 23),
    ADD COLUMN managed_funding_window_end_hour integer NOT NULL DEFAULT 0
        CHECK (managed_funding_window_end_hour BETWEEN 0 AND 23),
    -- Fleet-wide ceiling for one rolling day. NULL = no fleet cap (the
    -- per-child daily cap and the master floor still apply).
    ADD COLUMN managed_funding_global_daily_cap_rial bigint
        CHECK (managed_funding_global_daily_cap_rial IS NULL OR managed_funding_global_daily_cap_rial > 0);

COMMENT ON COLUMN platform_sms_config.managed_funding_strategy IS
    'Issue #902 §3: jit | low_watermark | scheduled | manual. Automatic funding is still off unless a buffer is configured.';
COMMENT ON COLUMN platform_sms_config.managed_funding_global_daily_cap_rial IS
    'Cross-business demand guard: the most provider credit ALL children may receive in one rolling day.';
