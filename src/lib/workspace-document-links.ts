/**
 * The one way a workspace register attaches files to itself.
 *
 * Every AEC register needs the same three operations — list a record's
 * attachments, replace them wholesale from what a screen sent, and turn "a file
 * the user picked" into a `workspace_documents` row — and migrations 0198 and
 * 0199 gave four registers four columns on the same table to do it with
 * (`rfi_id`, `submittal_id`, `site_log_id`, `site_issue_id`).
 *
 * The three functions lived inside `aec-rfi-service.ts` until the site service
 * needed them too. Copying them would have been the drift this repository keeps
 * paying for: four attachments lists that agree today and stop agreeing when
 * somebody fixes the media-library lookup in one of them. So they live here,
 * the column is a typed union rather than a string from the wire, and every
 * register shares one implementation of "the bytes are the Media Library's".
 *
 * Deleting an attachment therefore never deletes the document row — it detaches
 * it (`column = NULL`) — because the file belongs to its project's document list
 * and may be referenced elsewhere; the register only ever owned the link.
 */
import { AecError } from "./aec-service";
import { query } from "./db";
import type { WorkspaceOwner } from "./workspace";

/** The register columns on `workspace_documents` this helper may write. */
export type AttachmentColumn = "rfi_id" | "submittal_id" | "site_log_id" | "site_issue_id";

export interface LinkedDocument {
  documentId: string;
  title: string;
  fileName: string | null;
  mimeType: string | null;
  mediaAssetId: string | null;
  createdAt: string;
}

function trimTo(value: unknown, max: number): string {
  return (typeof value === "string" ? value : "").trim().slice(0, max);
}

function optionalUuid(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^[0-9a-fA-F-]{36}$/.test(value)) return null;
  return value;
}

/** The attachments of one record, oldest first. */
export async function loadLinkedDocuments(
  businessId: string,
  column: AttachmentColumn,
  targetId: string,
): Promise<LinkedDocument[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT wd.id, wd.title, ma.file_name, ma.mime_type, wd.media_asset_id,
            wd.created_at::text AS created_at
       FROM workspace_documents wd
       LEFT JOIN media_assets ma ON ma.id = wd.media_asset_id
      WHERE wd.business_id = $1 AND wd.${column} = $2
      ORDER BY wd.created_at`,
    [businessId, targetId],
  );
  return rows.map((row) => ({
    documentId: String(row.id),
    title: String(row.title ?? ""),
    fileName: (row.file_name as string | null) ?? null,
    mimeType: (row.mime_type as string | null) ?? null,
    mediaAssetId: (row.media_asset_id as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
  }));
}

/**
 * Replace the attachment list of a record with the documents named.
 *
 * Each entry is either an existing `workspace_documents` row of the project
 * (`workspaceDocumentId`) or a file from the Media Library (`mediaAssetId` +
 * `title`), which becomes one. Wholesale replacement, like a transmittal's
 * lines: the panel sends what the record should have, and the database's own
 * trigger refuses an attachment from another project.
 */
export async function replaceLinkedDocuments(
  owner: WorkspaceOwner,
  target: { column: AttachmentColumn; targetId: string },
  projectId: string,
  input: unknown,
): Promise<void> {
  const { column, targetId } = target;
  const incoming = Array.isArray(input) ? input : [];
  const keep: string[] = [];

  for (const entry of incoming.slice(0, 50)) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const existing = optionalUuid(item.workspaceDocumentId);
    if (existing) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM workspace_documents
          WHERE business_id = $1 AND project_id = $2 AND id = $3`,
        [owner.businessId, projectId, existing],
      );
      if (!rows[0]) throw new AecError("document_not_found");
      keep.push(rows[0].id);
      continue;
    }
    const mediaAssetId = optionalUuid(item.mediaAssetId);
    if (!mediaAssetId) continue;
    const title = trimTo(item.title, 200) || trimTo(item.fileName, 200) || "پیوست";
    const { rows: asset } = await query<{ file_name: string }>(
      `SELECT file_name FROM media_assets WHERE business_id = $1 AND id = $2`,
      [owner.businessId, mediaAssetId],
    );
    if (!asset[0]) throw new AecError("media_not_found");
    const { rows: created } = await query<{ id: string }>(
      `INSERT INTO workspace_documents
         (business_id, media_asset_id, title, project_id, status, created_by, ${column})
       VALUES ($1, $2, $3, $4, 'draft', $5, $6)
       RETURNING id`,
      [
        owner.businessId,
        mediaAssetId,
        trimTo(title, 200) || asset[0].file_name,
        projectId,
        owner.actorUserId,
        targetId,
      ],
    );
    keep.push(created[0].id);
  }

  // Detach the ones that are gone rather than deleting the document row: the
  // file is the Media Library's and the record may still be referenced elsewhere.
  await query(
    `UPDATE workspace_documents
        SET ${column} = NULL, updated_at = now()
      WHERE business_id = $1 AND ${column} = $2
        AND ($3::uuid[] IS NULL OR NOT (id = ANY($3::uuid[])))`,
    [owner.businessId, targetId, keep.length > 0 ? keep : null],
  );
}

/**
 * The file a record points at, from either form the screen can send: an
 * existing `workspaceDocumentId` of this project, or a `mediaAssetId` from the
 * Media Library that becomes one — the same two shapes
 * `replaceLinkedDocuments` accepts, so "pick a file" behaves identically on
 * every register. Returns `undefined` when the input says nothing about the
 * file (callers keep what they have) and `null` when it explicitly clears it.
 */
export async function resolveLinkedDocument(
  owner: WorkspaceOwner,
  projectId: string,
  input: { workspaceDocumentId?: unknown; mediaAssetId?: unknown },
): Promise<string | null | undefined> {
  if (input.workspaceDocumentId !== undefined) {
    const existing = optionalUuid(input.workspaceDocumentId);
    if (!existing) return null;
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM workspace_documents
        WHERE business_id = $1 AND project_id = $2 AND id = $3`,
      [owner.businessId, projectId, existing],
    );
    if (!rows[0]) throw new AecError("document_not_found");
    return rows[0].id;
  }
  if (input.mediaAssetId === undefined) return undefined;

  const mediaAssetId = optionalUuid(input.mediaAssetId);
  if (!mediaAssetId) return null;
  const { rows: asset } = await query<{ file_name: string }>(
    `SELECT file_name FROM media_assets WHERE business_id = $1 AND id = $2`,
    [owner.businessId, mediaAssetId],
  );
  if (!asset[0]) throw new AecError("media_not_found");
  const { rows: created } = await query<{ id: string }>(
    `INSERT INTO workspace_documents
       (business_id, media_asset_id, title, project_id, status, created_by)
     VALUES ($1, $2, $3, $4, 'draft', $5)
     RETURNING id`,
    [owner.businessId, mediaAssetId, asset[0].file_name, projectId, owner.actorUserId],
  );
  return created[0].id;
}
