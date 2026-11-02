-- Issue #902 §9 item 4, second half — the master balance the last pass saw.
--
-- `0263`/§5g made the funding pass read the master's own credit from the
-- provider instead of trusting a number an operator typed once. That fixed the
-- decision and left the *evidence* missing: the figure existed only inside the
-- tick's local variable, so the console could not show it, and an operator
-- asking "how much headroom does the floor have?" had to make the provider read
-- again — from a screen, on a whim, with their own eyes.
--
-- Three columns, because one number is not enough to be honest:
--
--   * `managed_master_balance_rial` — the figure the provider actually reported,
--     NULL when it has never said.
--   * `managed_master_balance_at` — when that figure was observed. A balance
--     with no timestamp is a rumour: 40 000 000 Rial from yesterday and 40 000
--     000 Rial from four minutes ago mean opposite things about whether the
--     floor is safe.
--   * `managed_master_balance_checked_at` — when the last pass *tried*. When
--     this is newer than `..._at`, the last read failed and the number on the
--     screen is the previous observation, not the current balance. That
--     distinction cannot be reconstructed if both are one timestamp.
--
-- The mirror is written only by a pass that read the provider. An operator's
-- typed figure is an instruction, not an observation, and must never overwrite
-- evidence about what the provider said.

ALTER TABLE platform_sms_config
    ADD COLUMN managed_master_balance_rial bigint
        CHECK (managed_master_balance_rial IS NULL OR managed_master_balance_rial >= 0),
    ADD COLUMN managed_master_balance_at timestamptz,
    ADD COLUMN managed_master_balance_checked_at timestamptz;

COMMENT ON COLUMN platform_sms_config.managed_master_balance_rial IS
    'Issue #902 §9 item 4: the master account credit the provider last reported. NULL = never observed.';
COMMENT ON COLUMN platform_sms_config.managed_master_balance_at IS
    'When managed_master_balance_rial was observed. Older than managed_master_balance_checked_at means the last read failed.';
COMMENT ON COLUMN platform_sms_config.managed_master_balance_checked_at IS
    'When a funding pass last tried to read the master balance, successful or not.';

-- Both halves are written together or not at all; a value without a timestamp
-- cannot be aged, and a timestamp without a value is what
-- `..._checked_at` is for.
ALTER TABLE platform_sms_config
    ADD CONSTRAINT platform_sms_config_master_balance_paired
        CHECK (
            (managed_master_balance_rial IS NULL AND managed_master_balance_at IS NULL)
            OR (managed_master_balance_rial IS NOT NULL AND managed_master_balance_at IS NOT NULL)
        );
