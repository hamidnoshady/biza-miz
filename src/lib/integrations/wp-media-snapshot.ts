import { isPinnedToTransaction, query, withTenantTransaction } from "../db";
import { reconcileWordPressMediaLifecycle } from "../media-service";
import type { ConnectionRow } from "./connections-service";
import { applyWpAttachmentEvent, attachmentRevision } from "./wp-attachment-events";
import type { WpContentPayload } from "./wp-content-service";

type Snapshot = { id: string; boundary: string; index?: number; count?: number };
export function parseMediaSnapshot(value: unknown, complete: boolean): Snapshot {
  const input = value as Snapshot | null;
  if (!input || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id) || !attachmentRevision(input.boundary)) throw new Error("invalid_media_snapshot");
  const n = complete ? input.count : input.index;
  if (!Number.isInteger(n) || n! < (complete ? 0 : 1) || n! > 500000) throw new Error("invalid_media_snapshot_count");
  return input;
}

export async function applyMediaSnapshot(connection: ConnectionRow, snapshotInput: unknown, payload?: WpContentPayload): Promise<void> {
  const complete = !payload;
  const snapshot = parseMediaSnapshot(snapshotInput, complete);
  const run = async () => {
    // Shared with live attachment events: no mutation can race absent-row pruning.
    await query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`wp-media-connection:${connection.id}`]);
    const scope = [connection.business_id, connection.id, snapshot.id];
    await query(`INSERT INTO integration_wp_media_snapshots (business_id, connection_id, generation, boundary)
      VALUES ($1, $2, $3, $4) ON CONFLICT (connection_id, generation) DO NOTHING`, [...scope, snapshot.boundary]);
    const { rows } = await query<{ boundary: string; expected_count: number | null; completed_at: string | null; started_at: string }>(
      `SELECT boundary::text, expected_count, completed_at, started_at FROM integration_wp_media_snapshots WHERE business_id = $1 AND connection_id = $2 AND generation = $3 FOR UPDATE`, scope,
    );
    const current = rows[0];
    if (!current || current.boundary !== snapshot.boundary) throw new Error("media_snapshot_conflict");
    if (current.completed_at) return;
    if (complete) {
      if (current.expected_count !== null && current.expected_count !== snapshot.count) throw new Error("media_snapshot_count_conflict");
      await query(`UPDATE integration_wp_media_snapshots SET expected_count = $4 WHERE business_id = $1 AND connection_id = $2 AND generation = $3`, [...scope, snapshot.count]);
      current.expected_count = snapshot.count!;
    } else {
      await applyWpAttachmentEvent(connection, payload!, false);
      // A stale row still counts as delivered. Its newer live version already
      // won; completeness must not depend on delivery order or hook timing.
      await query(`INSERT INTO integration_wp_media_snapshot_members (business_id, connection_id, generation, remote_id, ordinal)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (connection_id, generation, remote_id) DO NOTHING`, [...scope, String(payload!.id), snapshot.index]);
    }
    if (current.expected_count === null) return;
    const { rows: counts } = await query<{ count: number; max: number }>(`SELECT count(*)::int AS count, COALESCE(max(ordinal), 0)::int AS max FROM integration_wp_media_snapshot_members WHERE business_id = $1 AND connection_id = $2 AND generation = $3`, scope);
    if (counts[0]?.count !== current.expected_count || counts[0]?.max !== current.expected_count) return;
    // Immutable membership plus contiguous unique ordinals proves all pages
    // arrived. A completion marker alone is never sufficient.
    const { rows: removed } = await query<{ remote_id: string }>(
      `DELETE FROM integration_wp_content c WHERE c.business_id = $1 AND c.connection_id = $2 AND c.wp_type = 'attachment'
         AND c.created_at < $4 AND c.updated_at < $4
         AND NOT EXISTS (SELECT 1 FROM integration_wp_media_snapshot_members m WHERE m.connection_id = c.connection_id AND m.generation = $3 AND m.remote_id = c.remote_id)
         AND NOT EXISTS (SELECT 1 FROM integration_wp_media_state s WHERE s.connection_id = c.connection_id AND s.remote_id = c.remote_id AND s.revision > $5)
       RETURNING remote_id`, [...scope, current.started_at, snapshot.boundary],
    );
    for (const row of removed) {
      await query(`INSERT INTO integration_wp_media_state (business_id, connection_id, remote_id, revision, deleted)
        VALUES ($1, $2, $3, $4, true) ON CONFLICT (connection_id, remote_id)
        DO UPDATE SET deleted = true, revision = EXCLUDED.revision, updated_at = now()`, [connection.business_id, connection.id, row.remote_id, snapshot.boundary]);
      await reconcileWordPressMediaLifecycle(connection.business_id, connection.id, row.remote_id, "deleted");
    }
    await query(`UPDATE integration_wp_media_snapshots SET completed_at = now() WHERE business_id = $1 AND connection_id = $2 AND generation = $3`, scope);
    await query(`UPDATE integration_connections SET last_content_sync_at = now() WHERE business_id = $1 AND id = $2`, scope.slice(0, 2));
  };
  if (isPinnedToTransaction()) await run();
  else await withTenantTransaction(connection.business_id, run);
}
