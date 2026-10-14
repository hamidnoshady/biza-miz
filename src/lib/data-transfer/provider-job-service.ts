import { query } from "../db";
import { recordDataTransferAudit } from "./audit";
import type { ProviderJobMetadata } from "./types";

export interface StartProviderImportJobInput {
  businessId: string;
  fileName: string;
  fileSizeBytes: number;
  totalRows: number;
  actorUserId: string | null;
  actorName: string;
  providerMetadata: ProviderJobMetadata;
}

export interface FinishProviderImportJobInput {
  status: "completed" | "failed";
  createdRows: number;
  updatedRows: number;
  skippedRows: number;
  failedRows: number;
  error: string | null;
  providerMetadata: ProviderJobMetadata;
}

/**
 * Create the generic Data Transfer history row for a provider migration.
 * Provider/domain run tables still own source identity, reconciliation and
 * rollback; this row is the universal Data Transfer job envelope.
 */
export async function startProviderImportJob(input: StartProviderImportJobInput): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO data_import_jobs
       (business_id, entity_key, status, file_name, file_format, file_size_bytes,
        provider_metadata, source_columns, mapping, options, total_rows, valid_rows,
        created_by, created_by_name, started_at)
     VALUES ($1, 'providers.holoo', 'running', $2, 'provider', $3,
             $4::jsonb, $5::jsonb, '{}'::jsonb, '{}'::jsonb, $6, $6,
             $7::uuid, $8, now())
     RETURNING id`,
    [
      input.businessId,
      input.fileName.slice(0, 300),
      input.fileSizeBytes,
      JSON.stringify(input.providerMetadata),
      JSON.stringify(input.providerMetadata.selectedScopes),
      input.totalRows,
      input.actorUserId,
      input.actorName,
    ],
  );
  const jobId = rows[0].id;
  await recordDataTransferAudit({
    businessId: input.businessId,
    action: "data.import.provider_started",
    entityKey: "providers.holoo",
    entityId: jobId,
    actorUserId: input.actorUserId,
    payload: { ...input.providerMetadata },
  });
  return jobId;
}

/** Complete the universal job after the existing provider domain service returns. */
export async function markProviderImportJobRolledBack(businessId: string, migrationRunId: string): Promise<number> {
  const { rowCount } = await query(
    `UPDATE data_import_jobs
        SET provider_metadata = jsonb_set(
              COALESCE(provider_metadata, '{}'::jsonb),
              '{rollbackState}',
              '"rolled_back"'::jsonb,
              true
            ),
            updated_at = now()
      WHERE business_id = $1
        AND entity_key = 'providers.holoo'
        AND provider_metadata->>'provider' = 'holoo'
        AND provider_metadata->>'migrationRunId' = $2`,
    [businessId, migrationRunId],
  );
  return rowCount ?? 0;
}

export async function finishProviderImportJob(
  businessId: string,
  jobId: string,
  actorUserId: string | null,
  result: FinishProviderImportJobInput,
): Promise<void> {
  await query(
    `UPDATE data_import_jobs
        SET status = $3,
            created_rows = $4,
            updated_rows = $5,
            skipped_rows = $6,
            failed_rows = $7,
            error = $8,
            provider_metadata = $9::jsonb,
            finished_at = now(),
            updated_at = now()
      WHERE business_id = $1 AND id = $2 AND entity_key = 'providers.holoo'`,
    [
      businessId,
      jobId,
      result.status,
      result.createdRows,
      result.updatedRows,
      result.skippedRows,
      result.failedRows,
      result.error,
      JSON.stringify(result.providerMetadata),
    ],
  );
  await recordDataTransferAudit({
    businessId,
    action: result.status === "completed" ? "data.import.provider_completed" : "data.import.provider_failed",
    entityKey: "providers.holoo",
    entityId: jobId,
    actorUserId,
    payload: { ...result.providerMetadata },
  });
}
