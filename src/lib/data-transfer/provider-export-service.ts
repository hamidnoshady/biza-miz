import { query } from "../db";
import { recordDataTransferAudit } from "./audit";
import { CONTENT_TYPES, MAX_STORED_EXPORT_BYTES } from "./export-service";
import type { ProviderJobMetadata } from "./types";

const EXPORT_RETENTION_DAYS = 30;

export async function startProviderSendJob(input: {
  businessId: string;
  actorUserId: string | null;
  actorName: string;
  providerMetadata: ProviderJobMetadata;
}): Promise<string> {
  const providerKey = input.providerMetadata.provider.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!providerKey) throw new Error("invalid_provider_key");
  const entityKey = `providers.${providerKey}`;
  const { rows } = await query<{ id: string }>(
    `INSERT INTO data_export_jobs
       (business_id, entity_key, format, status, fields, filters, provider_metadata,
        file_name, content_type, created_by, created_by_name, started_at)
     VALUES ($1, $2, 'provider', 'running', $3::jsonb, '{}'::jsonb, $4::jsonb,
             $5, 'application/json', $6::uuid, $7, now())
     RETURNING id`,
    [
      input.businessId,
      entityKey,
      JSON.stringify(input.providerMetadata.selectedScopes),
      JSON.stringify(input.providerMetadata),
      `هلو · ارسال متصل`,
      input.actorUserId,
      input.actorName,
    ],
  );
  const jobId = rows[0].id;
  await recordDataTransferAudit({
    businessId: input.businessId,
    action: "data.export.provider_send_started",
    entityKey,
    entityId: jobId,
    actorUserId: input.actorUserId,
    payload: { ...input.providerMetadata },
  });
  return jobId;
}

export async function finishProviderSendJob(input: {
  businessId: string;
  jobId: string;
  actorUserId: string | null;
  status: "completed" | "failed";
  rowCount: number;
  error: string | null;
  providerMetadata: ProviderJobMetadata;
}): Promise<void> {
  const entityKey = `providers.${input.providerMetadata.provider.toLowerCase().replace(/[^a-z0-9_]/g, "")}`;
  await query(
    `UPDATE data_export_jobs
        SET status = $3, row_count = $4, error = $5,
            provider_metadata = $6::jsonb, finished_at = now()
      WHERE business_id = $1 AND id = $2 AND entity_key = $7`,
    [input.businessId, input.jobId, input.status, input.rowCount, input.error, JSON.stringify(input.providerMetadata), entityKey],
  );
  await recordDataTransferAudit({
    businessId: input.businessId,
    action: input.status === "completed" ? "data.export.provider_send_completed" : "data.export.provider_send_failed",
    entityKey,
    entityId: input.jobId,
    actorUserId: input.actorUserId,
    payload: { ...input.providerMetadata },
  });
}

export async function createProviderExportJob(input: {
  businessId: string;
  fileName: string;
  contentType?: string;
  body: Buffer;
  rowCount: number;
  actorUserId: string | null;
  actorName: string;
  providerMetadata: ProviderJobMetadata;
}): Promise<{ jobId: string; downloadable: boolean }> {
  const providerKey = input.providerMetadata.provider.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!providerKey) throw new Error("invalid_provider_key");
  const entityKey = `providers.${providerKey}`;
  const contentType = input.contentType ?? CONTENT_TYPES.xlsx;
  const stored = input.body.byteLength <= MAX_STORED_EXPORT_BYTES;
  const { rows } = await query<{ id: string }>(
    `INSERT INTO data_export_jobs
       (business_id, entity_key, format, status, fields, filters, provider_metadata,
        row_count, file_name, content_type, size_bytes, content, created_by,
        created_by_name, started_at, finished_at, expires_at)
     VALUES ($1, $2, 'xlsx', 'completed', $3::jsonb, '{}'::jsonb, $4::jsonb,
             $5, $6, $7, $8, $9, $10::uuid, $11, now(), now(),
             now() + interval '${EXPORT_RETENTION_DAYS} days')
     RETURNING id`,
    [
      input.businessId,
      entityKey,
      JSON.stringify(input.providerMetadata.selectedScopes),
      JSON.stringify(input.providerMetadata),
      input.rowCount,
      input.fileName.slice(0, 300),
      contentType,
      input.body.byteLength,
      stored ? input.body : null,
      input.actorUserId,
      input.actorName,
    ],
  );
  const jobId = rows[0].id;
  await recordDataTransferAudit({
    businessId: input.businessId,
    action: "data.export.provider_completed",
    entityKey,
    entityId: jobId,
    actorUserId: input.actorUserId,
    payload: {
      ...input.providerMetadata,
      rowCount: input.rowCount,
      sizeBytes: input.body.byteLength,
      downloadable: stored,
    },
  });
  return { jobId, downloadable: stored };
}
