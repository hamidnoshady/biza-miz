import { query, withoutTenantScope } from "./db";
import type { DesktopUpdateCommandDocument, DesktopUpdateCommandResult, DesktopUpdateCommandType } from "./desktop-update-command";

interface CommandRow extends Record<string, unknown> {
  id: string; sequence: string | number; command: DesktopUpdateCommandType;
  business_id: string; public_id: string; requested_at: Date | string; expires_at: Date | string;
}
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export async function createDesktopUpdateCommand(input: {
  businessId: string; siteDeviceId: string; command: DesktopUpdateCommandType;
  idempotencyKey: string; reason: string; adminId: string; expiresAt: Date;
}) {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<CommandRow>(
      `INSERT INTO desktop_update_commands
         (business_id,site_device_id,command,idempotency_key,reason,requested_by,expires_at)
       SELECT $1,$2,$3,$4,$5,$6,$7
         FROM site_devices d
        WHERE d.id=$2 AND d.business_id=$1 AND d.status='active' AND d.revoked_at IS NULL
       ON CONFLICT (business_id,site_device_id,idempotency_key) DO UPDATE
         SET updated_at=desktop_update_commands.updated_at
       RETURNING id,sequence,command,business_id,
         (SELECT public_id FROM site_devices WHERE id=site_device_id) AS public_id,
         requested_at,expires_at`,
      [input.businessId, input.siteDeviceId, input.command, input.idempotencyKey, input.reason, input.adminId, input.expiresAt],
    );
    return rows[0] ?? null;
  });
}

/** Pull at most one command in sequence order. Expiry is recorded, never hidden as success. */
export async function deliverNextDesktopUpdateCommand(identity: {
  businessId: string; siteDeviceId: string; publicDeviceId: string;
}): Promise<DesktopUpdateCommandDocument | null> {
  await query(
    `UPDATE desktop_update_commands SET status='expired',updated_at=now()
      WHERE business_id=$1 AND site_device_id=$2
        AND status IN ('queued','delivered','acknowledged') AND expires_at <= now()`,
    [identity.businessId, identity.siteDeviceId],
  );
  const { rows } = await query<CommandRow>(
    `UPDATE desktop_update_commands c SET
       status=CASE WHEN status='queued' THEN 'delivered' ELSE status END,
       delivered_at=COALESCE(delivered_at,now()),updated_at=now()
     WHERE c.id=(
       SELECT id FROM desktop_update_commands
        WHERE business_id=$1 AND site_device_id=$2
          AND status IN ('queued','delivered','acknowledged') AND expires_at>now()
        ORDER BY sequence LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id,sequence,command,business_id,$3::text AS public_id,requested_at,expires_at`,
    [identity.businessId, identity.siteDeviceId, identity.publicDeviceId],
  );
  const row = rows[0];
  return row ? {
    schemaVersion: 1, id: row.id, sequence: Number(row.sequence), command: row.command,
    businessId: row.business_id, deviceId: row.public_id, issuedAt: iso(row.requested_at), expiresAt: iso(row.expires_at),
  } : null;
}

/** Idempotent and monotonic: retries cannot move a terminal command backwards. */
export async function recordDesktopUpdateCommandResults(
  identity: { businessId: string; siteDeviceId: string }, results: DesktopUpdateCommandResult[],
): Promise<void> {
  const rank = { acknowledged: 1, executed: 2, verified: 3, failed: 3 } as const;
  for (const result of results) {
    await query(
      `UPDATE desktop_update_commands SET
         status=$4,
         acknowledged_at=COALESCE(acknowledged_at,CASE WHEN $4 IN ('acknowledged','executed','verified','failed') THEN now() END),
         executed_at=COALESCE(executed_at,CASE WHEN $4 IN ('executed','verified','failed') THEN now() END),
         verified_at=COALESCE(verified_at,CASE WHEN $4='verified' THEN now() END),
         failed_at=COALESCE(failed_at,CASE WHEN $4='failed' THEN now() END),
         result=jsonb_build_object('deviceOccurredAt',$5::text,'code',$6::text),updated_at=now()
       WHERE id=$1 AND business_id=$2 AND site_device_id=$3 AND sequence=$7
         AND expires_at>now() AND status NOT IN ('expired','verified','failed')
         AND (CASE status WHEN 'queued' THEN 0 WHEN 'delivered' THEN 0 WHEN 'acknowledged' THEN 1 WHEN 'executed' THEN 2 ELSE 3 END) <= $8`,
      [result.id, identity.businessId, identity.siteDeviceId, result.status, result.occurredAt, result.code,
        result.sequence, rank[result.status]],
    );
  }
}

export async function listDeviceUpdateCommands(businessId: string, siteDeviceId: string) {
  return withoutTenantScope("platform", async () => (await query(
    `SELECT id,sequence,command,status,reason,requested_at,expires_at,delivered_at,
            acknowledged_at,executed_at,verified_at,failed_at,result
       FROM desktop_update_commands WHERE business_id=$1 AND site_device_id=$2
       ORDER BY sequence DESC LIMIT 50`, [businessId, siteDeviceId],
  )).rows);
}
