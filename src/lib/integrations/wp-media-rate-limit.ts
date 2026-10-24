import { query } from "../db";
/** Call inside the same tenant transaction as enqueue. Connection-independent
 * tenant lock prevents a user from multiplying the allowance across sites.
 */
export async function allowWpMediaCreation(businessId: string): Promise<boolean> {
  await query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`wp-media-rate:${businessId}`]);
  const { rows } = await query<{ n: string }>(`SELECT count(*)::text AS n FROM integration_outbox_events
    WHERE business_id = $1 AND entity_type IN ('media_create', 'media_update') AND created_at > now() - interval '1 minute'`, [businessId]);
  return Number(rows[0]?.n ?? 0) < 30;
}
