/** Versioned attachment events share one transaction for mirror and mapping.
 * A permanent deletion is terminal for a WP ID; restore is only for trash.
 */
import { isPinnedToTransaction, query, withTenantTransaction } from "../db";
import { confirmWordPressMediaSync, reconcileWordPressMediaLifecycle } from "../media-service";
import { deleteWpContent, safeWpUrl, upsertWpContent, type WpContentPayload } from "./wp-content-service";
import type { ConnectionRow } from "./connections-service";

export function attachmentRevision(value: unknown): string | null {
  return typeof value === "string" && /^[1-9]\d{0,18}$/.test(value) ? value : null;
}

export async function applyWpAttachmentEvent(connection: ConnectionRow, payload: WpContentPayload, deleted: boolean): Promise<boolean> {
  const remoteId = String(payload.id);
  if (!/^[1-9]\d*$/.test(remoteId)) throw new Error("invalid_attachment_id");
  const revision = attachmentRevision(payload.revision);
  if (payload.revision != null && !revision) throw new Error("invalid_attachment_revision");
  const run = async () => {
    await query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`wp-media-connection:${connection.id}`]);
    await query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`wp-media:${connection.id}:${remoteId}`]);
    const { rows } = await query<{ revision: string; deleted: boolean }>(
      `SELECT revision::text, deleted FROM integration_wp_media_state WHERE business_id = $1 AND connection_id = $2 AND remote_id = $3 FOR UPDATE`,
      [connection.business_id, connection.id, remoteId],
    );
    const previous = rows[0];
    if (previous?.deleted) {
      if (typeof payload.operation_id === "string" && payload.operation_id) {
        await query(`UPDATE wordpress_media_mapping SET status = 'failed', last_error = 'remote_attachment_deleted', wp_media_id = $4, wp_url = NULL WHERE business_id = $1 AND connection_id = $2 AND operation_id = $3 AND (wp_media_id IS NULL OR wp_media_id = $4)`, [connection.business_id, connection.id, payload.operation_id, remoteId]);
      }
      return false;
    }
    // Once a plugin supplies revisions, unversioned old deliveries cannot
    // override it. Legacy permanent deletes still become durable tombstones.
    if (previous && (!revision || BigInt(revision) <= BigInt(previous.revision))) return false;
    if (revision || deleted) {
      await query(
        `INSERT INTO integration_wp_media_state (business_id, connection_id, remote_id, revision, deleted)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (connection_id, remote_id)
         DO UPDATE SET revision = EXCLUDED.revision, deleted = EXCLUDED.deleted, updated_at = now()`,
        [connection.business_id, connection.id, remoteId, revision ?? "0", deleted],
      );
    }
    const operationId = typeof payload.operation_id === "string" ? payload.operation_id : null;
    if (deleted) {
      await deleteWpContent(connection.business_id, connection.id, { id: remoteId, type: "attachment" });
      // The deletion hook includes operation identity, so it can invalidate a
      // pending push even if no confirmation has arrived yet.
      if (operationId) {
        await query(
          `UPDATE wordpress_media_mapping SET status = 'failed', last_error = 'remote_attachment_deleted', wp_media_id = $4, wp_url = NULL
            WHERE business_id = $1 AND connection_id = $2 AND operation_id = $3 AND (wp_media_id IS NULL OR wp_media_id = $4)`,
          [connection.business_id, connection.id, operationId, remoteId],
        );
      }
      await reconcileWordPressMediaLifecycle(connection.business_id, connection.id, remoteId, "deleted");
    } else {
      await upsertWpContent(connection, payload);
      await reconcileWordPressMediaLifecycle(connection.business_id, connection.id, remoteId, payload.status === "trash" ? "trash" : "active");
      const url = safeWpUrl(payload.source_url) || safeWpUrl(payload.url);
      if (operationId && url) {
        await confirmWordPressMediaSync(operationId, remoteId, url, { businessId: connection.business_id, connectionId: connection.id });
        if (payload.status === "trash") await reconcileWordPressMediaLifecycle(connection.business_id, connection.id, remoteId, "trash");
      }
    }
    return true;
  };
  return isPinnedToTransaction() ? run() : withTenantTransaction(connection.business_id, run);
}
