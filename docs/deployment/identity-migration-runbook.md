# Identity migration runbook — verified phone, optional credentials, national ID

Scope: the global personal identity introduced for ESH-199 / GitHub #1384. This
is an operator runbook for the schema that already ships; it describes what is
reversible, what requires forward repair, and how to rehearse and inspect a
database before trusting the result. It does **not** authorize a production
migration or any change to real identities.

Related: [multi-business tenancy](../phases/Phase-12-Multi-Business-Tenancy.md),
[authorization architecture](../architecture/authorization-architecture.md).

## What owns what

| Concern | Owner | Never |
| --- | --- | --- |
| One verified mobile per person | `platform_users.phone_e164` + `phone_verified_at`, written by `src/lib/iam/global-identity-service.ts` | A business membership, a `parties` row, or a phone number in a request body decides the tenant |
| Optional email and password | `platform_users.email` / `password_hash` (both nullable), `platform_email_verifications` | A placeholder email or a fake password |
| Optional national ID | `platform_users.national_id_ciphertext` + `national_id_bidx`, `src/lib/iam/identity-profile.ts` | Plaintext, an ordinary list API, a log line, or an analytics column |
| Audit | `platform_identity_events` (append-only, ids only) | The national ID, a phone number or a token |
| Billing's read | `src/lib/identity-billing-contract.ts` (`readIdentityAssurance`, `purchaseReadiness`) | Writing identity or verification rows |

Membership-level `users.phone_e164` remains the door's own phone and keeps
working. The global value is a separate fact; 0302's backfill copies it once and
nothing rewrites `users`.

## The schema, in order

| Migration | What it did |
| --- | --- |
| `0302_global_identity_phone.sql` | Added `phone_e164` / `phone_verified_at` / `email_verified_at`, the E.164 shape check, the partial unique index over **verified** numbers, the legacy backfill, and `v_platform_verified_phone_conflicts`. |
| `0303_identity_optional_credentials.sql` | Made `email` / `password_hash` nullable with two CHECK rules, added `platform_email_verifications`, the national-ID ciphertext/blind index, and `platform_identity_events`. |
| `0305_email_change_clears_identity_verification.sql` | A trigger: changing `email` clears `email_verified_at` and consumes live tokens. |
| `0306_identity_phone_backfill_repair.sql` | Forward repair for one person with several verified legacy numbers; adds `v_platform_verified_phone_identity_conflicts` and the `phone_backfill_cleared` audit action. |
| `0307_identity_national_id_pair_repair.sql` | Forward repair for one-sided national-ID rows; replaces the NULL-tolerant CHECK with an explicit both-present rule; adds `national_id_pair_cleared`. |
| `0311_identity_audit_admin_actor.sql` | Adds `actor_platform_admin_id`, so a privileged national-ID read names the platform admin who performed it. |
| `0314_identity_password_without_email.sql` | Drops `platform_users_password_needs_email` so phone-first owners can set a password without an email address. |
| `0316_short_business_onboarding.sql` | Extends `platform_identity_events_action_check` with `email_changed` and `email_cleared`. |
| `0322_global_identity_integrity_hardening.sql` | Adds immutable `canonical_iran_mobile_e164(text)`, upgrades conflict views to compare canonical mobiles across Persian/Arabic digits and legacy prefixes, adds `v_platform_verified_phone_anomalies`, clears landline/cross-format-ambiguous backfills and orphan verification stamps, backfills unambiguous format-variant single-mobile identities (`phone_backfilled_normalized`), enforces `phone_verified_at IS NULL OR phone_e164 IS NOT NULL`, enables `FORCE ROW LEVEL SECURITY` (`platform_only`) on `platform_email_verifications` and `platform_identity_events`, and makes `platform_identity_events` append-only via DB trigger. |

0302 and 0303 are frozen (the runner checksums applied migrations). Their defects
are corrected by the forward migrations above, never by editing the old files.

## The two legacy defects

### 1. A person with more than one verified legacy number

0302 groups legacy proofs **by phone number** and requires exactly one platform
identity per number. A person who proved two different numbers in two
memberships appears once per number; both groups look unambiguous, and
`UPDATE … FROM` picks one arbitrarily.

0306 fixes this in three parts:

1. `v_platform_verified_phone_identity_conflicts` reports identities with more
   than one distinct verified legacy number (`platform_user_id`, `number_count`,
   `phone_numbers`, `last_verified_at`).
2. Rows 0302 already wrote for those identities are cleared — **value and stamp
   together** — but only while the stored pair still exactly matches a legacy
   proof. A later real claim renews the stamp and is left alone.
3. Each cleared identity gets a `phone_backfill_cleared` audit event (ids only).

The safe end state is *no global number* until the person proves one. That is
deliberate: a guessed number is a guessed recovery channel.

The other shape — one number verified by two identities — is reported by
`v_platform_verified_phone_conflicts` and was never backfilled. It also needs a
human; the two identities are never merged automatically.

### 2. A one-sided national ID

0303's CHECK was:

```sql
(national_id_ciphertext IS NULL AND national_id_bidx IS NULL)
OR (national_id_ciphertext ~ '…' AND national_id_bidx ~ '…')
```

In SQL a CHECK rejects a row only when its expression is **FALSE**. With one
side NULL, the second branch evaluates to NULL, so the row was accepted. Both
one-sided shapes were possible: ciphertext without a blind index (duplicate
detection silently stopped) and a blind index without ciphertext ("has a
national ID" that cannot be read).

0307 clears both columns on every row the stricter rule would reject and audits
it as `national_id_pair_cleared`. It does **not** rebuild the missing half: SQL
has neither the field key nor the plaintext, and inventing a blind index would
be a guess about a person's identity. The person re-enters the value through the
audited self-service write; a platform administrator cannot write it for them.

## Rehearsal

The rehearsal is a database test, not a production operation:

```bash
npm run db:dev:start          # or point DATABASE_URL at a disposable Postgres
npx vitest run --config vitest.db.config.ts \
  integration/identity-migration-rehearsal.integration.test.ts
```

`integration/identity-migration-rehearsal.integration.test.ts` creates a fresh
database, applies only the migrations before 0302, seeds representative legacy
rows, then applies the rest in deploy order. The dataset covers:

| Shape | Expected result |
| --- | --- |
| One verified legacy number | Backfilled, verified |
| Two distinct verified numbers on one person | Backfilled arbitrarily by 0302, then cleared by 0306; reported by the identity-conflict view |
| The same number verified by two identities | Not backfilled; reported by the number-conflict view |
| The same number on two memberships of one person | Backfilled once (one fact, not a conflict) |
| An unverified/pending legacy number | Not backfilled |
| Existing email + password membership | Sign-in still works; membership/business intact |
| Pending phone-only identity | Valid row; not purchase-ready |
| National-ID pair, missing pair, ciphertext-only, blind-index-only | Pair kept; one-sided rows cleared and audited |
| Re-running the runner | No-op (`applied: 0`) |

The test uses synthetic numbers in the reserved test range and never prints a
real phone number or national ID. It is a production-*like* shape rehearsal; it
is not evidence that any production database was migrated.

## Read-only diagnostic report (`npm run db:identity-report`)

Before or after applying migrations on any environment, run the read-only,
PII-redacted health report:

```bash
DATABASE_URL=postgres://... npm run db:identity-report
DATABASE_URL=postgres://... npm run db:identity-report -- --strict
```

`collectIdentityMigrationReport()` (`src/lib/iam/identity-migration-repair.ts`)
emits masked phone prefixes/suffixes only — never full phone numbers, email
addresses, national IDs, ciphertexts, or blind-index digests — and summarizes:

- Global identity counts (verified global phones/emails, passwordless accounts,
  phone-only accounts, stored national IDs).
- Normalized cross-identity phone conflicts (`v_platform_verified_phone_conflicts`)
  and single-identity multi-phone conflicts (`v_platform_verified_phone_identity_conflicts`).
- Landline or unparseable verified-phone anomalies (`v_platform_verified_phone_anomalies`).
- National-ID envelope integrity (`decrypt_failed`, `invalid_decrypted_shape`,
  `blind_index_mismatch`, or `key_unavailable`).
- Unlinked `users` memberships split into expected PIN-only staff roles versus
  password-role anomalies.

With `--strict`, the CLI exits with status `2` when `healthy === false`.

## Operator procedure: ambiguous verified phone

1. Inspect all three views in the platform realm (or run `npm run db:identity-report`):

   ```sql
   SELECT platform_user_id, number_count, last_verified_at
     FROM v_platform_verified_phone_identity_conflicts;

   SELECT phone_e164, identity_count
     FROM v_platform_verified_phone_conflicts;

   SELECT source_scope, platform_user_id, anomaly_kind, verified_at
     FROM v_platform_verified_phone_anomalies;
   ```

   None of these views is a merge tool. Do not `UPDATE platform_users.phone_e164`
   by hand, and do not copy a number from one identity to another.

2. Confirm the person controls the number they want to keep. The supported path
   is the ordinary door: the person signs in through a membership whose phone
   they control and completes the SMS OTP. That call reaches
   `claimVerifiedPhone`, which writes the value and its stamp in one statement;
   the partial unique index rejects a number another identity already verified.
   Alternatively, after out-of-band verification, an active platform
   administrator may invoke `repairIdentityVerifiedPhoneConflict`
   (`src/lib/iam/identity-migration-repair.ts`), which validates membership
   proof + global uniqueness and appends a `phone_conflict_repaired` event
   carrying `actor_platform_admin_id` and `reason_code`.
3. The claim is write-once from a business door: a *different* number is refused
   with `identity_phone_locked`. The person's own self-service ceremony is the
   path to replace it.
4. If neither number is controlled by the person, leave the identity unresolved
   (no global phone). It remains a valid account — it simply cannot start a paid
   purchase until a mobile is verified.
5. Record the review outcome in the support case. Every automated or operator
   repair is recorded in `platform_identity_events` (append-only, ids and
   constrained `reason_code` slugs only — never the phone number or national ID).

## Operator procedure: one-sided or undecryptable national ID

0307 clears invalid half-pairs automatically and writes
`national_id_pair_cleared`. If `npm run db:identity-report` reports a corrupted
or key-mismatched `(national_id_ciphertext, national_id_bidx)` pair
(`decrypt_failed` or `blind_index_mismatch`), an active platform administrator
can clear it via `remediateNationalIdAnomaly` (`national_id_remediated`), which
refuses `not_corrupted` on valid rows so intact values cannot be wiped
accidentally. If the person needs the value restored, they enter it themselves
(`setNationalId`, self-only, encrypted, audited). Support cannot set it for
them, and any privileged read is recorded with `actor_platform_admin_id`.

## Reversibility

| Operation | Reversible? | Notes |
| --- | --- | --- |
| Additive columns/indexes (0302, 0303, 0311) | Yes, by dropping them | Drops lose the stored value (and any verified phone); they do not restore a legacy state |
| Legacy phone backfill (0302) | No, and it must not be reversed destructively | The legacy membership rows are untouched; a reviewed re-backfill can restore a number a human chooses |
| Ambiguous-phone repair (0306, 0322) | Forward repair only | Clearing is intentional. Re-running is a no-op. Re-assigning needs the person's proof of control |
| Normalized single-mobile backfill (0322) | Reversible via `repairIdentityVerifiedPhoneConflict` (`clear_global_phone_for_reverification`) | Legacy `users` rows remain untouched; audited as `phone_backfilled_normalized` |
| One-sided national-ID clear (0307) | Forward repair only | The missing half cannot be reconstructed from the database. The audit says which identities need re-entry |
| Email-verification rows | Yes, by dropping the table | Proofs are disposable; the address and `email_verified_at` remain |
| Audit rows (`platform_identity_events`) | Not reversible, by design | Protected by `FORCE ROW LEVEL SECURITY` and `trg_platform_identity_events_append_only` |
| `0305` / `0322` triggers & RLS | Yes, by dropping the trigger/policy/function | Dropping them re-opens verification-carryover or audit-mutation holes; do not do this in production |

No migration in this set creates a wallet, subscription, charge, activation,
business or membership. A run can be verified with:

```sql
SELECT action, reason_code, count(*)
  FROM platform_identity_events
 WHERE action IN (
   'phone_backfill_cleared',
   'phone_backfilled_normalized',
   'phone_conflict_repaired',
   'national_id_pair_cleared',
   'national_id_remediated'
 )
 GROUP BY action, reason_code
 ORDER BY action, reason_code;
```

## Production status

A rehearsal run in a disposable database is **not** a production migration.
Production deployment, production migration and production acceptance each
require separate, explicit authorization and evidence. As of the last review,
none of the three had been performed for this issue; treat them as pending.
