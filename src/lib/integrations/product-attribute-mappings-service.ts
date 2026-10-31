import { query, withTenantTransaction } from "../db";
import type { ConnectionRow } from "./connections-service";
import { wooClientFor } from "./connections-service";
import { assertPluginJobSupported } from "./plugin-job-guard";
import { isUuid } from "../uuid";

export interface AttributeEnsurePayload {
  definitionId: string;
  definitionVersion: number;
  name: string;
  slug: string;
  terms: { local: string; name: string; slug: string }[];
  reviewedBy: string;
}
export interface AttributeEnsureResult {
  attributeId: number;
  taxonomy: string;
  terms: Record<string, { id: number; name: string; slug: string }>;
}

export function validAttributeEnsurePayload(value: unknown): value is AttributeEnsurePayload {
  const p = value as AttributeEnsurePayload | null;
  if (!p || !isUuid(p.definitionId) || !Number.isSafeInteger(p.definitionVersion) || p.definitionVersion < 1 ||
    typeof p.name !== "string" || !p.name.trim() || p.name.length > 100 ||
    typeof p.slug !== "string" || !/^[a-z0-9][a-z0-9_-]{0,27}$/.test(p.slug) ||
    !isUuid(p.reviewedBy) || !Array.isArray(p.terms) || p.terms.length > 100) return false;
  const locals = new Set<string>(), remotes = new Set<string>();
  for (const term of p.terms) {
    if (!term || typeof term.local !== "string" || !term.local.trim() || term.local.length > 100 ||
      typeof term.name !== "string" || !term.name.trim() || term.name.length > 100 ||
      typeof term.slug !== "string" || !term.slug.trim() || term.slug.length > 150 || /[\s/?#]/.test(term.slug) ||
      locals.has(term.local) || remotes.has(term.slug)) return false;
    locals.add(term.local); remotes.add(term.slug);
  }
  return true;
}

export async function queueAttributeEnsure(businessId: string, connection: ConnectionRow, payload: AttributeEnsurePayload) {
  if (connection.business_id !== businessId || !validAttributeEnsurePayload(payload)) throw new Error("invalid_attribute_mapping");
  return withTenantTransaction(businessId, async () => {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`woo_attribute_mapping:${connection.id}`]);
    const { rows: conflicts } = await query(
      `SELECT definition_id FROM integration_woo_attribute_mappings
       WHERE business_id = $1 AND connection_id = $2 AND taxonomy = $3 AND definition_id <> $4
       UNION ALL
       SELECT remote_id::uuid FROM integration_outbox_events
       WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'taxonomy_ensure'
         AND remote_id <> $4::text AND payload->>'slug' = $5 AND status IN ('pending', 'processing', 'deferred', 'failed')`,
      [businessId, connection.id, `pa_${payload.slug}`, payload.definitionId, payload.slug],
    );
    if (conflicts.length) throw new Error("attribute_mapping_conflict");
    const { rows } = await query<{ options: string[]; version: number }>(
      `SELECT d.options, d.version FROM item_attribute_definitions d
       JOIN locations l ON l.id = d.location_id AND l.business_id = $1
       WHERE d.id = $2 AND d.is_active AND ($3::uuid IS NULL OR d.location_id = $3) FOR UPDATE OF d`,
      [businessId, payload.definitionId, connection.location_id],
    );
    const definition = rows[0];
    if (!definition || definition.version !== payload.definitionVersion) throw new Error("attribute_version_conflict");
    if (definition.options.length !== payload.terms.length || definition.options.some(o => !payload.terms.some(t => t.local === o))) {
      throw new Error("attribute_options_mismatch");
    }
    if (connection.link_mode === "plugin") await assertPluginJobSupported(businessId, connection.id, "taxonomy_ensure");
    const queued = await query<{ id: string }>(
      `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload)
       VALUES ($1, $2, 'taxonomy_ensure', $3, $4::jsonb)
       ON CONFLICT (connection_id, entity_type, remote_id) DO UPDATE
       SET payload = EXCLUDED.payload, status = 'pending', attempts = 0, next_attempt_at = now(),
           last_error = NULL, updated_at = now()
       WHERE integration_outbox_events.status NOT IN ('processing', 'pending', 'deferred') RETURNING id`,
      [businessId, connection.id, payload.definitionId, JSON.stringify(payload)],
    );
    if (!queued.rows[0]) throw new Error("attribute_mapping_in_progress");
    return queued.rows[0].id;
  });
}

/** Slug lookup makes retries after a lost acknowledgement create no duplicates. */
export async function applyTaxonomyEnsure(connection: ConnectionRow, value: unknown): Promise<AttributeEnsureResult> {
  if (!validAttributeEnsurePayload(value)) throw new Error("invalid_attribute_mapping");
  const client = wooClientFor(connection);
  let attribute = (await client.listAttributes()).find(a => a.slug.replace(/^pa_/, "") === value.slug);
  if (!attribute) attribute = await client.createAttribute({ name: value.name, slug: value.slug, type: "select" });
  const available = await client.listAttributeTerms(attribute.id);
  const terms: AttributeEnsureResult["terms"] = {};
  for (const wanted of value.terms) {
    let term = available.find(t => t.slug === wanted.slug);
    if (!term) {
      term = await client.createAttributeTerm(attribute.id, { name: wanted.name, slug: wanted.slug });
      available.push(term);
    }
    terms[wanted.local] = { id: term.id, name: term.name, slug: term.slug };
  }
  return { attributeId: attribute.id, taxonomy: `pa_${value.slug}`, terms };
}

/** A reviewed intent becomes a usable mapping only after the store returns real identities. */
export async function acknowledgeTaxonomyEnsure(businessId: string, connectionId: string, value: unknown, result: unknown): Promise<void> {
  if (!validAttributeEnsurePayload(value)) throw new Error("invalid_attribute_mapping");
  const ack = result as AttributeEnsureResult;
  if (!ack || !Number.isSafeInteger(ack.attributeId) || ack.attributeId <= 0 || ack.taxonomy !== `pa_${value.slug}` ||
    !ack.terms || value.terms.some(t => !Number.isSafeInteger(ack.terms[t.local]?.id) || ack.terms[t.local].id <= 0 ||
      ack.terms[t.local].slug !== t.slug || typeof ack.terms[t.local].name !== "string" || !ack.terms[t.local].name)) {
    throw new Error("invalid_attribute_ack");
  }
  const written = await query(
    `INSERT INTO integration_woo_attribute_mappings
       (business_id, connection_id, definition_id, remote_attribute_id, taxonomy, terms, reviewed_by)
     SELECT $1, c.id, d.id, $4, $5, $6::jsonb, $7 FROM integration_connections c
     JOIN item_attribute_definitions d ON d.id = $3
     JOIN locations l ON l.id = d.location_id AND l.business_id = c.business_id
     WHERE c.id = $2 AND c.business_id = $1 AND c.deleted_at IS NULL
       AND (c.location_id IS NULL OR c.location_id = d.location_id) AND d.version = $8
     ON CONFLICT (connection_id, definition_id) DO UPDATE
     SET remote_attribute_id = EXCLUDED.remote_attribute_id, taxonomy = EXCLUDED.taxonomy,
         terms = EXCLUDED.terms, reviewed_by = EXCLUDED.reviewed_by, updated_at = now()`,
    [businessId, connectionId, value.definitionId, ack.attributeId, ack.taxonomy, JSON.stringify(ack.terms), value.reviewedBy, value.definitionVersion],
  );
  if (!written.rowCount) throw new Error("attribute_version_conflict");
}

export async function buildMappedWooAttributes(businessId: string, connection: ConnectionRow, localId: string) {
  if (connection.business_id !== businessId) throw new Error("item_not_found");
  const { rows } = await query<{ kind: string; location_id: string }>(
    `SELECT i.kind, i.location_id FROM items i JOIN locations l ON l.id = i.location_id
     WHERE i.id = $1 AND l.business_id = $2 AND ($3::uuid IS NULL OR i.location_id = $3)`,
    [localId, businessId, connection.location_id],
  );
  if (!rows[0]) throw new Error("item_not_found");
  const child = rows[0].kind === "variant_child";
  const { rows: attributes } = await query<{
    definition_id: string | null; value: string; remote_attribute_id: number | null;
    terms: AttributeEnsureResult["terms"] | null;
  }>(
    `SELECT a.attribute_definition_id AS definition_id, a.value, m.remote_attribute_id, m.terms
     FROM item_variant_attributes a JOIN items i ON i.id = a.item_id AND i.location_id = $4
     LEFT JOIN integration_woo_attribute_mappings m
       ON m.definition_id = a.attribute_definition_id AND m.connection_id = $2 AND m.business_id = $3
     WHERE ${child ? "i.id = $1" : "i.parent_item_id = $1 AND i.is_active"}
     ORDER BY a.attribute_definition_id, a.value`,
    [localId, connection.id, businessId, rows[0].location_id],
  );
  const grouped = new Map<number, string[]>();
  for (const a of attributes) {
    const term = a.terms?.[a.value];
    if (!a.definition_id || !a.remote_attribute_id || !term) throw new Error("attribute_mapping_required");
    const options = grouped.get(a.remote_attribute_id) ?? [];
    if (!options.includes(term.name)) options.push(term.name);
    grouped.set(a.remote_attribute_id, options);
  }
  if (child && grouped.size === 0) throw new Error("variant_attributes_required");
  return [...grouped].map(([id, options]) => child
    ? { id, option: options[0] }
    : { id, visible: true, variation: true, options });
}
