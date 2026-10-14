import { query } from "./db";
import { ALL_PERMISSIONS, type Permission } from "./permissions";

export type AiWidgetOutputFormat = "summary" | "bullets" | "metric";

export interface AiWidget {
  id: string;
  name: string;
  description: string;
  sourceApp: string;
  projectId: string | null;
  prompt: string;
  outputFormat: AiWidgetOutputFormat;
  requiredPermissions: Permission[];
  width: number;
  height: number;
  sortOrder: number;
  pinned: boolean;
  templateId: string | null;
  lastRunAt: string | null;
}

export interface AiWidgetRecommendation {
  id: string;
  name: string;
  description: string;
  industry: string;
  sourceApp: string;
  prompt: string;
  outputFormat: AiWidgetOutputFormat;
  requiredPermissions: Permission[];
  defaultWidth: number;
  defaultHeight: number;
}

interface WidgetRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string;
  source_app: string;
  project_id: string | null;
  prompt: string;
  output_format: string;
  required_permissions: string[];
  width: number;
  height: number;
  sort_order: number;
  pinned: boolean;
  template_id: string | null;
  last_run_at: string | null;
}

const VALID_PERMISSIONS = new Set<string>(ALL_PERMISSIONS);
/** The three renderings a widget may ask for — exported so the platform
 * catalogue validates a recommendation exactly as a user's own widget does. */
export const AI_WIDGET_OUTPUT_FORMATS = ["summary", "bullets", "metric"] as const;
const OUTPUT_FORMATS = new Set<AiWidgetOutputFormat>(AI_WIDGET_OUTPUT_FORMATS);

function safePermissions(value: unknown): Permission[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is Permission => typeof item === "string" && VALID_PERMISSIONS.has(item)))];
}

function toWidget(row: WidgetRow): AiWidget {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceApp: row.source_app,
    projectId: row.project_id,
    prompt: row.prompt,
    outputFormat: OUTPUT_FORMATS.has(row.output_format as AiWidgetOutputFormat)
      ? (row.output_format as AiWidgetOutputFormat)
      : "summary",
    requiredPermissions: safePermissions(row.required_permissions),
    width: row.width,
    height: row.height,
    sortOrder: row.sort_order,
    pinned: row.pinned,
    templateId: row.template_id,
    lastRunAt: row.last_run_at,
  };
}

const COLUMNS = `id, name, description, source_app, project_id, prompt, output_format,
  required_permissions, width, height, sort_order, pinned, template_id, last_run_at`;

export function normalizeWidgetInput(input: {
  name?: unknown;
  description?: unknown;
  sourceApp?: unknown;
  projectId?: unknown;
  prompt?: unknown;
  outputFormat?: unknown;
  requiredPermissions?: unknown;
  width?: unknown;
  height?: unknown;
}): {
  name: string;
  description: string;
  sourceApp: string;
  projectId: string | null;
  prompt: string;
  outputFormat: AiWidgetOutputFormat;
  requiredPermissions: Permission[];
  width: number;
  height: number;
} | null {
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 100) : "";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 2_000) : "";
  if (!name || !prompt) return null;
  const outputFormat = OUTPUT_FORMATS.has(input.outputFormat as AiWidgetOutputFormat)
    ? (input.outputFormat as AiWidgetOutputFormat)
    : "summary";
  const number = (value: unknown, fallback: number) => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isInteger(parsed) ? Math.min(2, Math.max(1, parsed)) : fallback;
  };
  return {
    name,
    description: typeof input.description === "string" ? input.description.trim().slice(0, 300) : "",
    sourceApp: typeof input.sourceApp === "string" ? input.sourceApp.trim().slice(0, 40) || "all" : "all",
    projectId: typeof input.projectId === "string" && input.projectId.trim() ? input.projectId.trim() : null,
    prompt,
    outputFormat,
    requiredPermissions: safePermissions(input.requiredPermissions),
    width: number(input.width, 1),
    height: number(input.height, 1),
  };
}

async function assertProjectAccess(businessId: string, actorUserId: string, projectId: string | null): Promise<boolean> {
  if (!projectId) return true;
  const { rows } = await query<{ id: string }>(
    `SELECT p.id
       FROM ai_projects p
      WHERE p.id = $1 AND p.business_id = $2
        AND (p.owner_user_id = $3 OR p.created_by = $3
             OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.project_id = p.id AND m.user_id = $3))`,
    [projectId, businessId, actorUserId],
  );
  return Boolean(rows[0]);
}

export async function listAiWidgets(businessId: string, actorUserId: string): Promise<AiWidget[]> {
  const { rows } = await query<WidgetRow>(
    `SELECT ${COLUMNS} FROM ai_widgets
      WHERE business_id = $1 AND actor_user_id = $2 AND archived_at IS NULL
      ORDER BY pinned DESC, sort_order ASC, created_at DESC`,
    [businessId, actorUserId],
  );
  return rows.map(toWidget);
}

export async function createAiWidget(
  businessId: string,
  actorUserId: string,
  input: ReturnType<typeof normalizeWidgetInput>,
  effectivePermissions: ReadonlySet<Permission>,
): Promise<AiWidget> {
  if (!input) throw new Error("invalid_widget");
  if (input.requiredPermissions.some((permission) => !effectivePermissions.has(permission))) {
    throw new Error("widget_permission_widening");
  }
  if (!(await assertProjectAccess(businessId, actorUserId, input.projectId))) {
    throw new Error("project_inaccessible");
  }
  const { rows } = await query<WidgetRow>(
    `INSERT INTO ai_widgets
       (business_id, actor_user_id, name, description, source_app, project_id, prompt,
        output_format, required_permissions, width, height, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11,
             coalesce((SELECT max(sort_order) + 1 FROM ai_widgets WHERE business_id = $1 AND actor_user_id = $2), 0))
     RETURNING ${COLUMNS}`,
    [businessId, actorUserId, input.name, input.description, input.sourceApp, input.projectId, input.prompt,
      input.outputFormat, input.requiredPermissions, input.width, input.height],
  );
  return toWidget(rows[0]);
}

export async function updateAiWidget(
  businessId: string,
  actorUserId: string,
  id: string,
  patch: ReturnType<typeof normalizeWidgetInput> & { pinned?: boolean; sortOrder?: number } | null,
  effectivePermissions: ReadonlySet<Permission>,
): Promise<AiWidget | null> {
  if (!patch) throw new Error("invalid_widget");
  if (patch.requiredPermissions.some((permission) => !effectivePermissions.has(permission))) throw new Error("widget_permission_widening");
  if (!(await assertProjectAccess(businessId, actorUserId, patch.projectId))) throw new Error("project_inaccessible");
  const { rows } = await query<WidgetRow>(
    `UPDATE ai_widgets SET name = $4, description = $5, source_app = $6, project_id = $7,
        prompt = $8, output_format = $9, required_permissions = $10::text[], width = $11,
        height = $12, pinned = coalesce($13, pinned), sort_order = coalesce($14, sort_order), updated_at = now()
      WHERE id = $1 AND business_id = $2 AND actor_user_id = $3 AND archived_at IS NULL
      RETURNING ${COLUMNS}`,
    [businessId, actorUserId, id, patch.name, patch.description, patch.sourceApp, patch.projectId, patch.prompt,
      patch.outputFormat, patch.requiredPermissions, patch.width, patch.height,
      patch.pinned ?? null, patch.sortOrder ?? null],
  );
  return rows[0] ? toWidget(rows[0]) : null;
}

export async function archiveAiWidget(businessId: string, actorUserId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE ai_widgets SET archived_at = now(), updated_at = now()
      WHERE id = $1 AND business_id = $2 AND actor_user_id = $3 AND archived_at IS NULL`,
    [id, businessId, actorUserId],
  );
  return (rowCount ?? 0) > 0;
}

export async function getAiWidget(businessId: string, actorUserId: string, id: string): Promise<AiWidget | null> {
  const { rows } = await query<WidgetRow>(
    `SELECT ${COLUMNS} FROM ai_widgets
      WHERE id = $1 AND business_id = $2 AND actor_user_id = $3 AND archived_at IS NULL`,
    [id, businessId, actorUserId],
  );
  return rows[0] ? toWidget(rows[0]) : null;
}

export async function markAiWidgetRun(businessId: string, actorUserId: string, id: string): Promise<void> {
  await query(`UPDATE ai_widgets SET last_run_at = now(), updated_at = now() WHERE id = $1 AND business_id = $2 AND actor_user_id = $3`, [id, businessId, actorUserId]);
}

export async function listRecommendedAiWidgets(
  industry: string | null,
  effectivePermissions: ReadonlySet<Permission>,
): Promise<AiWidgetRecommendation[]> {
  const { rows } = await query<{
    id: string; name: string; description: string; industry: string; source_app: string; prompt: string;
    output_format: string; required_permissions: string[]; default_width: number; default_height: number;
  }>(
    `SELECT id, name, description, industry, source_app, prompt, output_format,
            required_permissions, default_width, default_height
       FROM ai_widget_templates
      WHERE enabled AND (industry = 'all' OR industry = $1)
      ORDER BY CASE WHEN industry = $1 THEN 0 ELSE 1 END, created_at ASC`,
    [industry ?? "all"],
  );
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      industry: row.industry,
      sourceApp: row.source_app,
      prompt: row.prompt,
      outputFormat: OUTPUT_FORMATS.has(row.output_format as AiWidgetOutputFormat) ? row.output_format as AiWidgetOutputFormat : "summary",
      requiredPermissions: safePermissions(row.required_permissions),
      defaultWidth: row.default_width,
      defaultHeight: row.default_height,
    }))
    .filter((row) => row.requiredPermissions.every((permission) => effectivePermissions.has(permission)));
}
