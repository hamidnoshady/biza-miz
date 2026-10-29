/**
 * Platform-wide editable guided tours (#972).
 * Existing code tours are the compatibility fallback. Published Studio tours
 * with matching IDs override their legacy counterparts; drafts never leak.
 */
import { query, withoutTenantScopeTransaction } from "./db";
import { INDUSTRIES } from "./industries";
import { KNOWLEDGE_PAGES } from "./knowledge-base";
import { ALL_PERMISSIONS } from "./permissions";
import {
  TOURS, TOUR_ANCHORS, validateTours, type TourDefinition, type TourEligibility, type TourStep,
} from "./tours";

export type TourPublishStatus = "draft" | "published";
export interface AuthoredTour extends TourDefinition {
  status: TourPublishStatus;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}
interface TourRow {
  id: string; page_key: string; route: string; title: string; description: string;
  status: TourPublishStatus; version: number; eligibility: TourEligibility; steps: TourStep[];
  created_at: string | Date; updated_at: string | Date; published_at: string | Date | null;
}
const COLUMNS = "id, page_key, route, title, description, status, version, eligibility, steps, created_at, updated_at, published_at";
const toIso = (date: string | Date) => date instanceof Date ? date.toISOString() : new Date(date).toISOString();
const mapTour = (r: TourRow): AuthoredTour => ({
  id: r.id, pageKey: r.page_key, route: r.route, title: r.title, description: r.description,
  version: r.version, eligibility: r.eligibility, steps: r.steps, status: r.status,
  createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at),
  publishedAt: r.published_at ? toIso(r.published_at) : null,
});
const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const obj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);

export class TourStudioError extends Error {
  constructor(readonly code: string) { super(code); }
}
const error = (code: string): never => { throw new TourStudioError(code); };
const knownPages = new Set(KNOWLEDGE_PAGES.map((p) => p.key));
const knownAnchors = new Set<string>(Object.values(TOUR_ANCHORS));
const knownPermissions = new Set<string>(ALL_PERMISSIONS);
const knownIndustries = new Set<string>(INDUSTRIES);
const ELIGIBILITY_KEYS = new Set([
  "permissions", "withoutPermissions", "industries", "features",
  "withoutFeatures", "inventorySystem", "anyOf",
]);
function parseEligibility(raw: unknown, depth = 0): TourEligibility {
  if (!obj(raw) || depth > 3) return error("invalid_eligibility");
  for (const key of Object.keys(raw)) if (!ELIGIBILITY_KEYS.has(key)) error("invalid_eligibility");
  const parsed: Record<string, unknown> = {};
  for (const key of ["permissions", "withoutPermissions", "industries", "features", "withoutFeatures"]) {
    if (!own(raw, key)) continue;
    const value = raw[key];
    if (!Array.isArray(value) || value.length > 32 || value.some((v) => typeof v !== "string" || v.length > 100)) error("invalid_eligibility");
    if ((key === "permissions" || key === "withoutPermissions") && value.some((v) => !knownPermissions.has(v))) error("unknown_permission");
    if (key === "industries" && value.some((v) => !knownIndustries.has(v))) error("unknown_industry");
    if ((key === "features" || key === "withoutFeatures") && value.some((v) => !/^[a-z0-9._-]{1,80}$/.test(v))) error("invalid_feature");
    parsed[key] = [...new Set(value)];
  }
  if (own(raw, "inventorySystem")) {
    if (raw.inventorySystem !== "perpetual" && raw.inventorySystem !== "periodic") error("invalid_inventory_system");
    parsed.inventorySystem = raw.inventorySystem;
  }
  if (own(raw, "anyOf")) {
    if (!Array.isArray(raw.anyOf) || raw.anyOf.length === 0 || raw.anyOf.length > 8) error("invalid_eligibility");
    parsed.anyOf = raw.anyOf.map((v) => parseEligibility(v, depth + 1));
  }
  return parsed as TourEligibility;
}
export interface TourStudioInput {
  id: string; pageKey: string; title: string; description: string;
  eligibility: TourEligibility; steps: TourStep[]; status: TourPublishStatus;
  expectedVersion?: number;
}
export function parseTourStudioInput(raw: unknown): TourStudioInput {
  if (!obj(raw)) return error("invalid_input");
  const { id, pageKey, title, description, steps, status } = raw;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) error("invalid_id");
  if (typeof pageKey !== "string" || !knownPages.has(pageKey)) error("unknown_page");
  if (typeof title !== "string" || title.trim().length < 1 || title.length > 160) error("invalid_title");
  if (typeof description !== "string" || description.length > 1000) error("invalid_description");
  if (status !== "draft" && status !== "published") error("invalid_status");
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 60) error("invalid_steps");
  const eligibility = parseEligibility(raw.eligibility ?? {});
  const parsedSteps: TourStep[] = steps.map((value: unknown) => {
    if (!obj(value)) return error("invalid_step");
    const { id: stepId, title: stepTitle, body, kind, anchor } = value;
    if (typeof stepId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(stepId)) error("invalid_step_id");
    if (kind !== "spotlight" && kind !== "explain") error("invalid_step_kind");
    if (typeof stepTitle !== "string" || stepTitle.trim().length < 1 || stepTitle.length > 160) error("invalid_step_title");
    if (typeof body !== "string" || body.trim().length < 1 || body.length > 3000) error("invalid_step_body");
    if (kind === "spotlight" && (typeof anchor !== "string" || !knownAnchors.has(anchor))) error("unknown_anchor");
    if (kind === "explain" && anchor !== undefined) error("invalid_step_anchor");
    return {
      id: stepId, title: stepTitle, body, kind, ...(kind === "spotlight" ? { anchor: anchor as TourStep["anchor"] } : {}),
      ...(own(value, "eligibility") ? { eligibility: parseEligibility(value.eligibility) } : {}),
    };
  });
  const validation = validateTours([{
    id, pageKey, route: pageKey.slice(5), title, description, version: 1, eligibility, steps: parsedSteps,
  }]);
  if (validation.length) error("invalid_tour");
  const v = raw.expectedVersion;
  if (v !== undefined && (!Number.isInteger(v) || typeof v !== "number" || v < 1)) error("invalid_version");
  return { id, pageKey, title: title.trim(), description: description.trim(),
    steps: parsedSteps, eligibility, status,
    ...(typeof v === "number" ? { expectedVersion: v } : {}) };
}

/** Published global rows take precedence over code entries with the same ID. */
export function combineTours(legacy: readonly TourDefinition[], authored: readonly TourDefinition[]): TourDefinition[] {
  const overrides = new Set(authored.map((x) => x.id));
  return [...legacy.filter((x) => !overrides.has(x.id)), ...authored];
}
export async function publishedToursForPage(pageKey: string): Promise<TourDefinition[]> {
  const { rows } = await query<TourRow>(
    `SELECT ${COLUMNS} FROM knowledge_tours WHERE page_key = $1 AND status = 'published' ORDER BY updated_at DESC, id`,
    [pageKey],
  );
  return combineTours(TOURS.filter((t) => t.pageKey === pageKey), rows.map(mapTour));
}
export async function publishedTourById(id: string): Promise<TourDefinition | null> {
  const { rows } = await query<TourRow>(
    `SELECT ${COLUMNS} FROM knowledge_tours WHERE id = $1 AND status = 'published' LIMIT 1`, [id],
  );
  return rows[0] ? mapTour(rows[0]) : TOURS.find((t) => t.id === id) ?? null;
}
export async function listStudioTours(): Promise<{ tours: AuthoredTour[]; codeTours: TourDefinition[] }> {
  const { rows } = await query<TourRow>(`SELECT ${COLUMNS} FROM knowledge_tours ORDER BY updated_at DESC, id LIMIT 1000`);
  return { tours: rows.map(mapTour), codeTours: TOURS };
}
export async function getStudioTour(id: string): Promise<AuthoredTour | null> {
  const { rows } = await query<TourRow>(`SELECT ${COLUMNS} FROM knowledge_tours WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] ? mapTour(rows[0]) : null;
}
/** Write-and-snapshot are atomic. Updates require optimistic version matching. */
export async function saveStudioTour(raw: unknown, actor: string): Promise<{ id: string; version: number }> {
  const input = parseTourStudioInput(raw);
  return withoutTenantScopeTransaction("save authored tour", async () => {
    const current = await getStudioTour(input.id);
    if (current && input.expectedVersion !== current.version) error("version_conflict");
    if (!current && input.expectedVersion !== undefined) error("version_conflict");
    const version = current ? current.version + 1 : 1;
    const args = [input.id, input.pageKey, input.pageKey.slice(5), input.title,
      input.description, input.status, version, JSON.stringify(input.eligibility),
      JSON.stringify(input.steps), actor];
    if (current) {
      await query(
        `UPDATE knowledge_tours SET page_key=$2,route=$3,title=$4,description=$5,status=$6,
         version=$7,eligibility=$8::jsonb,steps=$9::jsonb,updated_by=$10,
         updated_at=now(), published_at=CASE WHEN $6='published' THEN now() ELSE NULL END
         WHERE id=$1`, args,
      );
    } else {
      await query(
        `INSERT INTO knowledge_tours
         (id,page_key,route,title,description,status,version,eligibility,steps,created_by,updated_by,published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$10,
           CASE WHEN $6='published' THEN now() ELSE NULL END)`, args,
      );
    }
    await query(
      `INSERT INTO knowledge_tour_revisions (tour_id,version,snapshot,created_by)
       VALUES ($1,$2,$3::jsonb,$4)`,
      [input.id, version, JSON.stringify({ ...input, version, route: input.pageKey.slice(5) }), actor],
    );
    return { id: input.id, version };
  });
}
export async function listStudioTourRevisions(id: string): Promise<{ version: number; snapshot: TourStudioInput; createdAt: string }[]> {
  const { rows } = await query<{ version: number; snapshot: TourStudioInput; created_at: string | Date }>(
    "SELECT version,snapshot,created_at FROM knowledge_tour_revisions WHERE tour_id=$1 ORDER BY version DESC LIMIT 100", [id],
  );
  return rows.map((r) => ({ version: r.version, snapshot: r.snapshot, createdAt: toIso(r.created_at) }));
}
export async function rollbackStudioTour(id: string, revision: number, expectedVersion: number, actor: string) {
  const { rows } = await query<{ snapshot: TourStudioInput }>(
    "SELECT snapshot FROM knowledge_tour_revisions WHERE tour_id=$1 AND version=$2",
    [id, revision],
  );
  if (!rows[0]) error("not_found");
  return saveStudioTour({ ...rows[0].snapshot, id, expectedVersion }, actor);
}
export async function deleteDraftStudioTour(id: string): Promise<void> {
  const { rowCount } = await query("DELETE FROM knowledge_tours WHERE id=$1 AND status='draft'", [id]);
  if (!rowCount) error("not_found_or_published");
}
