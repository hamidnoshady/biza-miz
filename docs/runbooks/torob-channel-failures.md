# Torob channel — the failure runbook

Issue #894. One page for the person on call, with the four failure classes the channel
actually produces, what the merchant sees, and what to do. Every drill named here runs
as an integration test in `integration/torob-failure-drills.integration.test.ts`.

The one rule that covers most of this document: **our snapshot of Torob is a record,
never a prediction.** A failed read changes `torob_shops.health` and `observed_error`,
and leaves `observed_at`, `observed_status` and every `torob_product_states` row exactly
where the last successful read put them. Anything that "fixes" a shop by writing the
state we expected is a bug.

---

## 1. Feed has been `blocked` for more than an hour

**Symptom.** The per-shop feed preview has been blocked for more than an hour. A product's
Torob-reported `page_not_accessible` status is a different signal: see §2 and the product
problem list; it does not mean the local feed build was blocked.

**Read this first.** Use the explicit feed preview `POST /api/growth/torob/shops/[id]/feed`
(the POST writes a `torob_feed_runs` row; opening a screen does not call Torob) → `blocked.reason`.
This is a local feed decision, not Torob's live listing status. The blocked reason has one of
four owners:

```sql
SELECT status, blocked_reason, built_at
  FROM torob_feed_runs
 WHERE business_id = $1 AND shop_id = $2
 ORDER BY built_at DESC
 LIMIT 5;
```

| reason | what it means | who fixes it |
| --- | --- | --- |
| `not_authorized` | the shop's `authorization_state` is not `authorized` — approval never completed, was revoked, or the 15-minute window expired | merchant: «اتصال به ترب» again; on-call: nothing |
| `channel_disabled` | the merchant switched the channel off | merchant |
| `website_missing` | the `integration_connections` / `eshobe_cms_connections` row is gone | on-call: check whether the connection was deleted on purpose — if so the shop must be disconnected, not left pointing at nothing |
| `website_inactive` | the website exists but is inactive or not syncing products | merchant (reactivate the site), or on-call if the site is a managed deployment |

Then, in this order:

1. `SELECT health, health_reason, observed_error, last_checked_at FROM torob_shops WHERE id = …` —
   a blocked **feed** with `health = 'healthy'` means the block is ours (publication), not
   a failed Shop API read. The feed preview does not call Torob. If `health = 'attention'`,
   triage the last Shop API attempt separately (§2); do not run feed preview repeatedly as
   a substitute for a live Torob observation.
2. If the reason is `not_authorized`, do **not** call the Shop Generator to re-approve on
   the merchant's behalf. The approval is the merchant's act; re-driving it from the
   platform is how a shop gets registered twice.
3. If the reason is `website_inactive`, confirm the website's own state in
   `/growth/websites` before touching Torob at all. A site that cannot serve its
   storefront cannot serve Torob either, and the published pages would 404.
4. Escalate only when the reason is `website_missing` and the connection's deletion was
   not intended: that is a data-integrity incident, not a Torob one.

**Never** delete the `torob_shops` row while diagnosing. Its id is the path segment in
the crawl URL Torob has stored; deleting it turns a recoverable state into a broken
registration Torob will keep calling.

---

## 2. Last Shop API read failed three times in a row

**Symptom.** `torob_status_runs` has three consecutive `failed` rows for the shop, the
screen shows «آخرین تلاش برای خواندن از ترب ناموفق بود», and `health = 'attention'`.

```sql
SELECT outcome, error, started_at, finished_at
  FROM torob_status_runs
 WHERE business_id = $1 AND shop_id = $2
 ORDER BY finished_at DESC NULLS LAST, started_at DESC
 LIMIT 10;
```

| `error` in the last three rows | meaning | action |
| --- | --- | --- |
| `unauthorized` (401) | the credential Torob has is not one it accepts any more | merchant re-connects; nothing to retry |
| `forbidden` (403) | Torob refused the operation. For Shop API reads the persisted code is `forbidden`; the provider detail may say the domain differs or the shop is inactive | compare `torob_shops.domain` to the managed website's verified domain; do not change our row to match an unexplained Torob-side mismatch. If the shop is inactive in Torob, merchant re-registers there |
| `not_found` (404) | the Shop API says it cannot find the shop | confirm the external shop still exists; merchant re-registers if it was removed |
| `rate_limited` (429) | three reads inside one window, or Torob applying its own limit | wait; this clears itself. Three in a row here usually means a retry loop someone started by hand |
| `timeout`, `provider_error` | Torob is slow or down | nothing. The read is not retried in a loop by design; the next explicit read or the merchant's «خواندن دوباره از ترب» is the retry |
| `not_configured` | no credential at all (`token_ciphertext` empty and no `TOROB_PARTNER_TOKEN`) | deployment problem: set the partner token or have the merchant connect |

Then, in this order:

1. `SELECT count(*) FROM torob_product_states WHERE shop_id = …` — the count **must not
   have changed** across the failures. If it dropped, a truncated scan was treated as
   complete: stop and treat it as a code defect, because that is the one way a failed
   read corrupts a snapshot.
2. Check `observed_at`: it must still be the time of the last **successful** read. If it
   moved during a failure, the same defect class.
3. If the last three are `timeout`/`provider_error` and Torob is back, press
   «خواندن دوباره از ترب» once. Not in a loop — each read spends the shop's own rate
   budget, and the shop is not the only tenant behind that budget.

---

## 3. Webhook queue: pages marked `dead`

**Symptom.** The «اطلاع‌دادن به ترب» panel lists dead pages, or `counts.dead` is not zero.

```sql
SELECT page_unique, state, attempts, last_error, next_attempt_at
  FROM torob_webhook_outbox
 WHERE business_id = $1 AND shop_id = $2 AND state = 'dead';
```

`last_error` is the closed vocabulary in `webhook.ts`, and the policy is deliberate:

- `invalid_request` / `domain_mismatch` — the same body would be refused again. The page
  is usually one the shop no longer serves on its own domain. Check the product's page
  URL in the feed; if it is wrong, fixing the catalogue and pressing «تعمیر» re-announces
  it.
- `unauthorized` / `shop_not_active` — a human has to fix the credential or Torob's
  record. The shop's `health` was already set to `attention` for this.
- `rate_limited` rows are **not** dead on purpose; they stay pending and due after the
  documented 3-second spacing.
- After an outage, use `{action: "retry"}` on the webhook panel (or
  `retryDeadPages`) — then «تعمیر». Recovery is idempotent: the retry revives the same
  rows, and a second «تعمیر» announces each page once, never twice.

A `sent` row is **accepted**, not indexed. Never tell a merchant a page is live on the
basis of a webhook batch; only `capabilities.listing` (a Shop API observation) can say
that.

---

## 4. Disconnect / reconnect — the safe path

Disconnecting a website must stop managed operations **without** deleting the Torob shop,
and reconnecting must not duplicate anything.

The three switches and what each stops:

| action | what stops | what stays |
| --- | --- | --- |
| `enabled = false` (channel off) | crawling (404), webhook sends (`stoppedBy: not_configured`), Torob-side page switches (`channel_disabled`) | the shop row, its queue, its snapshot |
| `authorization_state = 'revoked'` | everything above, plus reads | the same |
| deleting the **website connection** | the feed (`website_missing`) | the shop row — which is now a shop pointing at nothing: disconnect it |

Verification after any of these, in one query:

```sql
SELECT
  (SELECT count(*) FROM torob_shops WHERE id = $1) AS shop_row,
  (SELECT count(*) FROM torob_webhook_outbox WHERE shop_id = $1 AND state = 'pending') AS pending,
  (SELECT health FROM torob_shops WHERE id = $1) AS health;
```

`shop_row` must be `1` in every case. If a disconnect deleted it, the "disconnect is not
delete" requirement has been broken — restore from backup, and treat the code path that
did it as the incident.

On reconnect: re-enable, then «تعمیر» **once**. Then confirm the queue did not grow:

```sql
SELECT count(*), count(DISTINCT page_unique) FROM torob_webhook_outbox WHERE shop_id = $1;
```

The two counts must be equal — one row per page, always. If the queue has more rows than
pages, a second fill created a parallel queue; that is the idempotency defect the drill
in `torob-failure-drills` pins.

---

## What this runbook does not cover

- **Torob-side approval** (Shop Generator, IP allowlist, partner credentials): an external
  process. Nothing here can create it, and no screen claims the channel is compliant
  while it is missing.
- **The CMS runtime**: a separate deployment. Its endpoint must answer the same contract;
  a shop served by it that fails should be triaged with §1 and §3, not debugged here.
- **Attribution**: off by default, and a `403 access_disabled` is the correct answer, not
  an incident. Turn it on only from the store's own «ترب» screen, per channel.
