/**
 * Issue #799 §22 (Wave 10) — the **platform** half of the AI widget catalogue.
 *
 * §22's last sentence is the requirement this file exists for: \"Super-admin
 * should be able to provide recommended industry widgets without preventing
 * users from creating their own.\" That is exactly the shape of the two tables
 * migration 0188 created, and it is worth writing down because it is easy to
 * break by accident:
 *
 *   * `ai_widget_templates` rows with `business_id IS NULL` are the **platform
 *     catalogue** — what a business of an industry is *offered* (never imposed)
 *     through `listRecommendedAiWidgets`. This module owns those rows, and only
 *     those rows: a tenant-scoped template is not the platform's to edit.
 *   * `ai_widgets` rows are a **member's own widgets**. Nothing here inserts,
 *     updates or deletes one. A recommendation is an offer in the "add a widget"
 *     list, and a user who never takes it is unaffected; a user who writes
 *     their own prompt is equally unaffected. §22's sentence is therefore true
 *     by construction rather than by careful UI.
 *
 * Two rules the console inherits from the tenant side and must not loosen:
 * `required_permissions` is filtered against the platform's own permission
 * vocabulary (an unknown key is dropped, so a template cannot ask for a
 * permission that does not exist and then never be offered to anyone), and a
 * widget's `prompt` is text the assistant executes *under the viewer's own
 * permissions* — the console does not gain any read by writing a prompt.
 *
 * `enabled = false` is the delete: a template that has been taken by somebody
 * is referenced by `ai_widgets.template_id` (`ON DELETE SET NULL`), so removing
 * the row would silently orphan the provenance of existing widgets. Disabling
 * keeps the history and stops the offer, which is what an operator actually
 * means when they retire a recommendation.
 */
import { query } from "./db";
import { ALL_PERMISSIONS, type Permission } from "./permissions";
import { INDUSTRIES, INDUSTRY_LABELS, type Industry } from "./industries";
import {
  AI_WIDGET_OUTPUT_FORMATS,
  type AiWidgetOutputFormat,
  normalizeWidgetInput,
} from "./ai-widgets";

/** The industries a recommendation may target: one of them, or every business. */
export const WIDGET_TEMPLATE_INDUSTRIES: readonly ("all" | Industry)[] = ["all", ...INDUSTRIES];

export type WidgetTemplateIndustry = (typeof WIDGET_TEMPLATE_INDUSTRIES)[number];

export interface AiWidgetTemplate {
  id: string;
  name: string;
  description: string;
  industry: WidgetTemplateIndustry;
  sourceApp: string;
  prompt: string;
  outputFormat: AiWidgetOutputFormat;
  requiredPermissions: Permission[];
  defaultWidth: number;
  defaultHeight: number;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TemplateRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string;
  industry: string;
  source_app: string;
  prompt: string;
  output_format: string;
  required_permissions: string[];
  default_width: number;
  default_height: number;
  enabled: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const VALID_PERMISSIONS = new Set<string>(ALL_PERMISSIONS);
const OUTPUT_FORMATS = new Set<string>(AI_WIDGET_OUTPUT_FORMATS);

function toTemplate(row: TemplateRow): AiWidgetTemplate {
  const industry = (WIDGET_TEMPLATE_INDUSTRIES as readonly string[]).includes(row.industry)
    ? (row.industry as WidgetTemplateIndustry)
    : "all";
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    industry,
    sourceApp: row.source_app,
    prompt: row.prompt,
    outputFormat: OUTPUT_FORMATS.has(row.output_format)
      ? (row.output_format as AiWidgetOutputFormat)
      : "summary",
    requiredPermissions: (Array.isArray(row.required_permissions) ? row.required_permissions : [])
      .filter((value): value is Permission => VALID_PERMISSIONS.has(value)),
    defaultWidth: row.default_width,
    defaultHeight: row.default_height,
    enabled: row.enabled,
    createdBy: row.created_by,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const TEMPLATE_COLUMNS = `id, name, description, industry, source_app, prompt, output_format,
                          required_permissions, default_width, default_height, enabled,
                          created_by, created_at, updated_at`;

/** Every platform recommendation, enabled or retired, industry by industry. */
export async function listAiWidgetTemplates(): Promise<AiWidgetTemplate[]> {
  const { rows } = await query<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS} FROM ai_widget_templates
      WHERE business_id IS NULL
      ORDER BY industry, enabled DESC, created_at, name`,
  );
  return rows.map(toTemplate);
}

export interface WidgetTemplateInput {
  id?: string | null;
  name?: unknown;
  description?: unknown;
  industry?: unknown;
  sourceApp?: unknown;
  prompt?: unknown;
  outputFormat?: unknown;
  requiredPermissions?: unknown;
  width?: unknown;
  height?: unknown;
  enabled?: unknown;
}

export type WidgetTemplateSaveResult =
  | { ok: true; template: AiWidgetTemplate }
  | { ok: false; error: "invalid_widget" | "unknown_industry" | "template_not_found" };

/**
 * Creates or updates one recommendation.
 *
 * The field normalisation is the tenant side's (`normalizeWidgetInput`) on
 * purpose: a platform recommendation and a hand-written widget must validate
 * identically, or the catalogue could contain a row the user-facing API would
 * have refused. On top of it this module checks the two things only a template
 * has — the industry it targets and the flag that offers it.
 */
export async function saveAiWidgetTemplate(
  adminId: string,
  input: WidgetTemplateInput,
): Promise<WidgetTemplateSaveResult> {
  const normalized = normalizeWidgetInput(input);
  if (!normalized) return { ok: false, error: "invalid_widget" };

  const industry = typeof input.industry === "string" ? input.industry.trim() : "all";
  if (!(WIDGET_TEMPLATE_INDUSTRIES as readonly string[]).includes(industry)) {
    return { ok: false, error: "unknown_industry" };
  }
  const enabled = input.enabled !== false;

  if (input.id) {
    const { rows } = await query<TemplateRow>(
      `UPDATE ai_widget_templates
          SET name = $2, description = $3, industry = $4, source_app = $5, prompt = $6,
              output_format = $7, required_permissions = $8, default_width = $9,
              default_height = $10, enabled = $11, version = version + 1, updated_at = now()
        WHERE id = $1 AND business_id IS NULL
        RETURNING ${TEMPLATE_COLUMNS}`,
      [
        input.id,
        normalized.name,
        normalized.description,
        industry,
        normalized.sourceApp,
        normalized.prompt,
        normalized.outputFormat,
        normalized.requiredPermissions,
        normalized.width,
        normalized.height,
        enabled,
      ],
    );
    if (!rows[0]) return { ok: false, error: "template_not_found" };
    return { ok: true, template: toTemplate(rows[0]) };
  }

  const { rows } = await query<TemplateRow>(
    `INSERT INTO ai_widget_templates
       (business_id, name, description, industry, source_app, prompt, output_format,
        required_permissions, default_width, default_height, enabled, created_by)
     VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${TEMPLATE_COLUMNS}`,
    [
      normalized.name,
      normalized.description,
      industry,
      normalized.sourceApp,
      normalized.prompt,
      normalized.outputFormat,
      normalized.requiredPermissions,
      normalized.width,
      normalized.height,
      enabled,
      `platform:${adminId}`,
    ],
  );
  return { ok: true, template: toTemplate(rows[0]) };
}

/** Offers or retires one recommendation. Retiring keeps the row (see the header). */
export async function setAiWidgetTemplateEnabled(
  id: string,
  enabled: boolean,
): Promise<AiWidgetTemplate | null> {
  const { rows } = await query<TemplateRow>(
    `UPDATE ai_widget_templates
        SET enabled = $2, version = version + 1, updated_at = now()
      WHERE id = $1 AND business_id IS NULL
      RETURNING ${TEMPLATE_COLUMNS}`,
    [id, enabled],
  );
  return rows[0] ? toTemplate(rows[0]) : null;
}

/** The industries the picker offers, with their Persian labels. */
export function widgetTemplateIndustryOptions(): Array<{ value: WidgetTemplateIndustry; label: string }> {
  return WIDGET_TEMPLATE_INDUSTRIES.map((value) => ({
    value,
    label: value === "all" ? "همهٔ کسب‌وکارها" : INDUSTRY_LABELS[value],
  }));
}
