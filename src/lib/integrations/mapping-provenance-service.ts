/**
 * Issue #1592 — reading the mapping provenance a physical connection delete
 * used to destroy.
 *
 * A normal disconnect is a soft delete, so `integration_mappings` stays. The
 * `BEFORE DELETE` trigger installed by 0323 fills `integration_mapping_provenance`
 * only when a connection row is physically deleted; this service is the
 * read-only door to that evidence. It never re-points or re-creates a mapping:
 * restoring a link is a deliberate reconciliation decision (the #1118 flow),
 * not something a list should do automatically.
 */
import { query, withTenant } from "../db";

export interface MappingProvenanceRow {
  id: string;
  businessId: string;
  connectionId: string;
  connectionName: string | null;
  provider: string | null;
  storeKey: string | null;
  entityType: string;
  remoteId: string;
  localId: string | null;
  mappingCreatedAt: string | null;
  archivedAt: string;
  archivedReason: string;
}

interface ProvenanceDbRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  connection_id: string;
  entity_type: string;
  remote_id: string;
  local_id: string | null;
  mapping_created_at: Date | null;
  archived_at: Date;
  archived_reason: string;
  connection_snapshot: Record<string, unknown> | null;
}

export interface MappingProvenanceFilter {
  connectionId?: string | null;
  localId?: string | null;
  remoteId?: string | null;
  entityType?: string | null;
  limit?: number;
}

/** Newest-first provenance rows for one tenant (optionally one connection/item). */
export async function listMappingProvenance(
  businessId: string,
  filter: MappingProvenanceFilter = {},
): Promise<MappingProvenanceRow[]> {
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1_000);
  return withTenant(businessId, async () => {
    const params: unknown[] = [businessId];
    const clauses = ["business_id = $1"];
    if (filter.connectionId) {
      params.push(filter.connectionId);
      clauses.push(`connection_id = $${params.length}`);
    }
    if (filter.localId) {
      params.push(filter.localId);
      clauses.push(`local_id = $${params.length}`);
    }
    if (filter.remoteId) {
      params.push(filter.remoteId);
      clauses.push(`remote_id = $${params.length}`);
    }
    if (filter.entityType) {
      params.push(filter.entityType);
      clauses.push(`entity_type = $${params.length}`);
    }
    params.push(limit);
    const { rows } = await query<ProvenanceDbRow>(
      `SELECT id::text, business_id::text, connection_id::text, entity_type, remote_id, local_id::text,
              mapping_created_at, archived_at, archived_reason, connection_snapshot
         FROM integration_mapping_provenance
        WHERE ${clauses.join(" AND ")}
        ORDER BY archived_at DESC, id
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => {
      const snapshot = row.connection_snapshot ?? {};
      const text = (key: string): string | null => {
        const value = snapshot[key];
        return typeof value === "string" && value.trim() !== "" ? value : null;
      };
      return {
        id: row.id,
        businessId: row.business_id,
        connectionId: row.connection_id,
        connectionName: text("name"),
        provider: text("provider"),
        storeKey: text("pluginSiteUrl") ?? text("baseUrl"),
        entityType: row.entity_type,
        remoteId: row.remote_id,
        localId: row.local_id,
        mappingCreatedAt: row.mapping_created_at ? row.mapping_created_at.toISOString() : null,
        archivedAt: row.archived_at.toISOString(),
        archivedReason: row.archived_reason,
      };
    });
  });
}
