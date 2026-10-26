# WP/Woo queue retention (issue #1077)

Finished rows in the WordPress/WooCommerce queue are deleted on a fixed schedule.
The numbers were agreed with the owner on 2026-10-25 and are constants in
`src/lib/integrations/queue-retention-policy.ts` (no settings screen).

| Table | Status | Kept |
|---|---|---|
| `integration_outbox_events` | `sent`, `skipped` | 90 days since `updated_at` |
| `integration_outbox_events` | `dead` | 180 days since `updated_at` |
| `integration_webhook_events` | `processed`, `duplicate` | 90 days since `processed_at` (else `created_at`) |
| `integration_webhook_events` | `failed` | 180 days |
| either | `pending`, `processing`, `deferred`, `failed` (outbox, still retrying), `needs_review` | never swept |

- **Why 90 / 180:** 90 days is a quarter of reconciliation plus a month; unresolved
  failures stay longer because someone may still ask why an order never arrived.
  Inbox payloads hold customer data, so there is no reason to keep them longer.
- **Delete, not archive.** `integration_audit_log` is append-only and is the
  permanent record. Every sweep writes one `queue.retention_sweep` row per
  connection with counts and cutoffs only, never payloads.
- **Safe to delete.** The scheduled stock/price diff compares against the
  mapping's `lastPushedPayload`, not the old event, so a deleted `sent` row never
  causes a re-push. An inbox row's `delivery_id` is only a dedup key for
  WooCommerce/plugin retries, which end within hours.
- **Where it runs.** `runQueueRetentionTick()` in `server.ts` (central only, every
  6 hours), batched 1000 rows per statement with a per-sweep cap. Migration 0256
  adds the two partial indexes it scans.
- **Plugin side.** The plugin's own on-site table already prunes `sent` rows after
  30 days (`POS_Connector_Queue::prune`), so no plugin change or release is needed.
- **UI.** The queue page states the retention under the connection picker.
