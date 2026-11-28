/**
 * GH #1567 F5 — the legacy side of the embedded-media rule.
 *
 * New input is refused at every layer; rows written before the rule may still
 * carry inline image bytes. They are never rewritten or stripped here (that
 * would silently delete content the owner wrote). This read-only report lists
 * them — table, row, field, kind — so the owner can move each image to the
 * media library and edit the text through the normal (guarded) form.
 */
import { query } from "./db";
import { findEmbeddedMedia, type EmbeddedMediaKind } from "./embedded-media-guard";

export interface EmbeddedMediaReportRow {
  source: "item" | "menu_item";
  id: string;
  locationId: string;
  name: string;
  field: "name" | "shortDescription" | "longDescription" | "description" | "imageUrl";
  kind: EmbeddedMediaKind | "invalid_image_url";
  length: number;
}

/** Cheap SQL prefilter; every candidate is confirmed by the real detector. */
const CANDIDATE = String.raw`(d.{0,8}a.{0,8}t.{0,8}a|&#|&colon|%[0-9a-fA-F]{2}|\\u|\\[0-9a-fA-F]|[A-Za-z0-9+/]{64,})`;

export async function embeddedMediaReport(businessId: string, locationId?: string | null): Promise<EmbeddedMediaReportRow[]> {
  const out: EmbeddedMediaReportRow[] = [];
  const { rows: items } = await query<{ id: string; location_id: string; name: string; short_description: string | null; long_description: string | null }>(
    `SELECT i.id, i.location_id, i.name, i.short_description, i.long_description
       FROM items i JOIN locations l ON l.id = i.location_id
      WHERE l.business_id = $1 AND ($2::uuid IS NULL OR i.location_id = $2)
        AND (i.name ~ $3 OR i.short_description ~ $3 OR i.long_description ~ $3)
      ORDER BY i.name LIMIT 2000`,
    [businessId, locationId ?? null, CANDIDATE],
  );
  for (const row of items) {
    for (const [field, value] of [["name", row.name], ["shortDescription", row.short_description], ["longDescription", row.long_description]] as const) {
      const finding = findEmbeddedMedia(value);
      if (finding) out.push({ source: "item", id: row.id, locationId: row.location_id, name: row.name, field, kind: finding.kind, length: value?.length ?? 0 });
    }
  }
  const { rows: menu } = await query<{ id: string; location_id: string; name: string; description: string | null; image_url: string | null }>(
    `SELECT m.id, m.location_id, m.name, m.description, m.image_url
       FROM menu_items m JOIN locations l ON l.id = m.location_id
      WHERE l.business_id = $1 AND ($2::uuid IS NULL OR m.location_id = $2)
        AND (m.name ~ $3 OR m.description ~ $3 OR m.image_url ~* '^\s*(data|blob|javascript|file):' OR m.image_url ~ $3)
      ORDER BY m.name LIMIT 2000`,
    [businessId, locationId ?? null, CANDIDATE],
  );
  for (const row of menu) {
    for (const [field, value] of [["name", row.name], ["description", row.description], ["imageUrl", row.image_url]] as const) {
      const finding = findEmbeddedMedia(value);
      if (finding) {
        out.push({ source: "menu_item", id: row.id, locationId: row.location_id, name: row.name, field, kind: finding.kind, length: value?.length ?? 0 });
      } else if (field === "imageUrl" && value && /^\s*(blob|javascript|file):/i.test(value)) {
        out.push({ source: "menu_item", id: row.id, locationId: row.location_id, name: row.name, field, kind: "invalid_image_url", length: value.length });
      }
    }
  }
  return out;
}
