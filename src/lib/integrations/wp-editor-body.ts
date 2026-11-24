import { query } from "../db";

interface EditorBodyAnswer {
  content?: unknown;
  shortDescription?: unknown;
  modified?: unknown;
  error?: unknown;
}

/** Consume the one-shot answer, or queue an idempotent read on the signed link. */
export async function requestWpEditorBody(
  businessId: string,
  connectionId: string,
  postType: "post" | "page" | "product",
  remoteId: string,
): Promise<EditorBodyAnswer | null> {
  const requestKey = `${postType}:${remoteId}`;
  const { rows } = await query<{ answer: { content?: unknown; modified?: unknown; error?: unknown } }>(
    `DELETE FROM integration_outbox_events
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'post_body_read'
        AND remote_id = $3 AND status = 'sent'
      RETURNING CASE WHEN sent_at > now() - interval '5 minutes' THEN payload->'answer' END AS answer`,
    [businessId, connectionId, requestKey],
  );
  if (rows[0]?.answer) return rows[0].answer;
  await query(
    `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload)
     VALUES ($1, $2, 'post_body_read', $3, jsonb_build_object('postType', $4::text, 'postId', $5::bigint))
     ON CONFLICT (connection_id, entity_type, remote_id) DO UPDATE SET
       status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL, updated_at = now()
     WHERE integration_outbox_events.status = 'dead'`,
    [businessId, connectionId, requestKey, postType, Number(remoteId)],
  );
  return null;
}
