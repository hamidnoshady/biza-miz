/**
 * The saved print templates of a branch (migration 0145).
 *
 * The built-ins live in `print-template.ts` as code and are never rows;
 * this is only what a business designed for itself. `listPrintTemplates`
 * therefore returns rows, and the screens concatenate them with
 * `BUILT_IN_TEMPLATES` — a saved template and a built-in are the same shape,
 * so nothing downstream has to know which it got.
 *
 * Everything written here goes through `parsePrintTemplate` first, so a stored
 * `layout` can only ever contain blocks, columns and options the renderer
 * understands.
 */
import { query } from "./db";
import {
  templatePaperFitsDocType,
  parsePrintTemplate,
  type DocType,
  type PaperKey,
  type PrintTemplate,
} from "./print-template";
import { isTemplateAvailable, type TemplateAccessContext } from "./printing/template-catalog";

export interface SavedPrintTemplate extends PrintTemplate {
  id: string;
  isDefault: boolean;
  /**
   * The revision that last changed this layout. Incremented by every write
   * and stamped onto each `print_jobs` row, so "which exact layout produced
   * this bad receipt?" has an answer.
   */
  version: number;
  updatedAt: string;
}

interface TemplateRow extends Record<string, unknown> {
  id: string;
  name: string;
  doc_type: string;
  paper: string;
  layout: { sourceKey?: unknown; options?: unknown; blocks?: unknown };
  is_default: boolean;
  version: number;
  updated_at: Date | string;
}

const TEMPLATE_COLUMNS = "id, name, doc_type, paper, layout, is_default, version, updated_at";

function mapRow(row: TemplateRow): SavedPrintTemplate | null {
  const parsed = parsePrintTemplate({
    key: row.id,
    name: row.name,
    docType: row.doc_type,
    paper: row.paper,
    sourceKey: row.layout?.sourceKey,
    options: row.layout?.options,
    blocks: row.layout?.blocks,
  });
  if (!parsed) return null;
  return {
    ...parsed,
    id: row.id,
    isDefault: row.is_default,
    version: Number.isInteger(row.version) && row.version > 0 ? row.version : 1,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : row.updated_at.toISOString(),
  };
}

export async function listPrintTemplates(locationId: string): Promise<SavedPrintTemplate[]> {
  const { rows } = await query<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS}
       FROM print_templates
      WHERE location_id = $1
      ORDER BY doc_type, is_default DESC, name`,
    [locationId],
  );
  return rows.map(mapRow).filter((t): t is SavedPrintTemplate => t !== null);
}

export async function getPrintTemplate(
  locationId: string,
  id: string,
): Promise<SavedPrintTemplate | null> {
  const { rows } = await query<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS}
       FROM print_templates WHERE id = $1 AND location_id = $2`,
    [id, locationId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/** Clears the current default before a new one is stamped — one per (branch, doc type). */
async function clearDefault(locationId: string, docType: DocType, exceptId?: string): Promise<void> {
  await query(
    `UPDATE print_templates SET is_default = false, updated_at = now()
      WHERE location_id = $1 AND doc_type = $2 AND is_default AND ($3::uuid IS NULL OR id <> $3)`,
    [locationId, docType, exceptId ?? null],
  );
}

export type TemplateError = "invalid_template" | "duplicate_template_name" | "template_not_found" | "incompatible_template" | "template_not_available";

/**
 * Is this template's paper physically possible for its document type? A
 * receipt template on A4, or a label template on a thermal roll's receipt
 * type, is a layout the pipeline can never print — refuse it at the write
 * boundary rather than store a row the till will fail on.
 */
export { templatePaperFitsDocType } from "./print-template";

export async function createPrintTemplate(input: {
  locationId: string;
  template: unknown;
  isDefault?: boolean;
  /** Resolved server-side for the caller's active branch; never accept from JSON. */
  accessContext?: TemplateAccessContext;
}): Promise<{ template?: SavedPrintTemplate; error?: TemplateError }> {
  const parsed = parsePrintTemplate(input.template);
  if (!parsed) return { error: "invalid_template" };
  if (!templatePaperFitsDocType(parsed.docType, parsed.paper)) return { error: "incompatible_template" };
  if (input.accessContext && !isTemplateAvailable(parsed, input.accessContext)) return { error: "template_not_available" };
  if (input.isDefault) await clearDefault(input.locationId, parsed.docType);
  try {
    const { rows } = await query<TemplateRow>(
      `INSERT INTO print_templates (location_id, name, doc_type, paper, layout, is_default)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${TEMPLATE_COLUMNS}`,
      [
        input.locationId,
        parsed.name,
        parsed.docType,
        parsed.paper,
        JSON.stringify({ ...(parsed.sourceKey ? { sourceKey: parsed.sourceKey } : {}), options: parsed.options, blocks: parsed.blocks }),
        input.isDefault === true,
      ],
    );
    const template = mapRow(rows[0]);
    return template ? { template } : { error: "invalid_template" };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { error: "duplicate_template_name" };
    throw err;
  }
}

export async function updatePrintTemplate(input: {
  locationId: string;
  id: string;
  template: unknown;
  isDefault?: boolean;
  /** Resolved server-side for the caller's active branch; never accept from JSON. */
  accessContext?: TemplateAccessContext;
}): Promise<{ template?: SavedPrintTemplate; error?: TemplateError }> {
  const parsed = parsePrintTemplate(input.template);
  if (!parsed) return { error: "invalid_template" };
  if (!templatePaperFitsDocType(parsed.docType, parsed.paper)) return { error: "incompatible_template" };
  if (input.accessContext && !isTemplateAvailable(parsed, input.accessContext)) return { error: "template_not_available" };
  const existing = await getPrintTemplate(input.locationId, input.id);
  if (!existing) return { error: "template_not_found" };
  const isDefault = input.isDefault ?? existing.isDefault;
  if (isDefault) await clearDefault(input.locationId, parsed.docType, input.id);
  try {
    const { rows } = await query<TemplateRow>(
      // Every write bumps the revision: `print_jobs.template_version` is only
      // useful if the number changes whenever the layout does.
      `UPDATE print_templates
          SET name = $1, doc_type = $2, paper = $3, layout = $4, is_default = $5,
              version = version + 1, updated_at = now()
        WHERE id = $6 AND location_id = $7
        RETURNING ${TEMPLATE_COLUMNS}`,
      [
        parsed.name,
        parsed.docType,
        parsed.paper,
        JSON.stringify({ ...(parsed.sourceKey ? { sourceKey: parsed.sourceKey } : {}), options: parsed.options, blocks: parsed.blocks }),
        isDefault,
        input.id,
        input.locationId,
      ],
    );
    const template = rows[0] ? mapRow(rows[0]) : null;
    return template ? { template } : { error: "template_not_found" };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { error: "duplicate_template_name" };
    throw err;
  }
}

export async function deletePrintTemplate(locationId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM print_templates WHERE id = $1 AND location_id = $2`,
    [id, locationId],
  );
  return (rowCount ?? 0) > 0;
}

