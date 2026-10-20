/**
 * Phase 35 — enqueuing a notification.
 *
 * Its own module, and a deliberately tiny one, for the same reason
 * `ai-coworker-events.ts` is: the producers are `shift-service`,
 * `business-day-service`, `backup-service` and `ai-coworker-service`, and
 * importing the full `notifications-service` from them would close import
 * cycles through the tenant/feature/AI graph. Nothing here imports anything but
 * `db` and the pure catalogue.
 */
import { query } from "./db";
import type { NotificationEventKey, NotificationSeverity } from "./notifications";

export interface RecordNotificationInput {
  businessId: string;
  /** null for an event that belongs to the whole business (a failed backup). */
  locationId: string | null;
  eventKey: NotificationEventKey;
  severity: NotificationSeverity;
  /** Persian, already rendered — a push notification is read with no way to ask a follow-up. */
  title: string;
  body?: string;
  /** Relative path the notification opens. Never absolute: the business's own origin serves it. */
  url?: string;
  /** The money figure this event is about, in integer Rial, when it has one. */
  amountRial?: number | string | null;
  /**
   * The identity of the *fact*, not of this call. Two producers firing for one
   * shift closing must collide here rather than notify twice — see
   * `notificationDedupeKey` in notifications.ts.
   */
  dedupeKey: string;
  payload?: Record<string, unknown>;
}

/**
 * Records that something worth telling someone about has happened. The tick is
 * what decides who hears it and sends the push.
 *
 * Deliberately swallows its own errors, exactly like `recordCoworkerEvent`:
 * this is called from the middle of a cashier closing their till, and a
 * notification that cannot be queued must never be the reason a shift fails to
 * close. It also means a deployment that has never run migration 0102 degrades
 * to "no notifications" rather than to "the POS stopped working".
 *
 * `ON CONFLICT DO NOTHING` against the `(business_id, dedupe_key)` UNIQUE is
 * the whole idempotency story — a retried request produces one notification.
 */
export async function recordNotification(input: RecordNotificationInput): Promise<void> {
  try {
    await query(
      `INSERT INTO notification_events
         (business_id, location_id, event_key, severity, title, body, url, amount_rial, dedupe_key, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (business_id, dedupe_key) DO NOTHING`,
      [
        input.businessId,
        input.locationId,
        input.eventKey,
        input.severity,
        input.title.slice(0, 200),
        (input.body ?? "").slice(0, 500),
        input.url ?? "/dashboard",
        input.amountRial ?? null,
        input.dedupeKey.slice(0, 200),
        JSON.stringify(input.payload ?? {}),
      ],
    );
  } catch (error) {
    console.error("notification enqueue failed:", error instanceof Error ? error.message : error);
  }
}
