/**
 * Saved views — «نماهای ذخیره‌شده».
 *
 * A saved view is a named set of filters on a list: «مشتریان بدهکار تهران»,
 * «سرنخ‌های داغ این هفته». It exists because the alternative is people
 * rebuilding the same five filters every morning, and then not bothering, and
 * then not using the filters at all.
 *
 * ## Filters are a validated document, never SQL
 *
 * The stored `filters` column is JSON, and this service validates it against a
 * **closed vocabulary per entity** before it is saved and again before it is
 * used. Nothing here interpolates a stored string into a query.
 *
 * That matters more than it looks. A saved view is user-authored content that
 * one member creates and another member's browser executes — which is the
 * shape of a stored injection. Keeping the vocabulary closed means the worst a
 * malicious view can do is filter on a field that does not exist, and the
 * worst *that* does is return nothing.
 *
 * ## Private by default is wrong; shared by default is also wrong
 *
 * `owner_user_id` NULL means the view is the business's; set means it is one
 * member's. The caller chooses explicitly. Defaulting either way silently
 * surprises somebody: a private view that turns out to be shared exposes how
 * one salesperson works, and a shared view that turns out to be private means
 * the manager who built it for the team is the only one who sees it.
 */

import { query } from "./db";
import { isUuid } from "./uuid";
import { DEAL_VIEW_FILTER_KEYS, parseDealViewFilters } from "./crm-deal-views";
import { CASE_VIEW_FILTER_KEYS, parseCaseViewFilters } from "./crm-case-views";

export const SAVED_VIEW_ENTITIES = [
  "customers",
  "leads",
  "deals",
  "cases",
  "activities",
] as const;
export type SavedViewEntity = (typeof SAVED_VIEW_ENTITIES)[number];

/**
 * The filter keys each entity accepts.
 *
 * Deliberately a list of *keys*, not of SQL. Each list screen maps these onto
 * its own query parameters, so a view saved here is exactly a set of the
 * filters that screen already supports — no view can express something the UI
 * cannot show, which keeps "why does this view look wrong?" from becoming a
 * class of bug.
 */
const ENTITY_FILTER_KEYS: Record<SavedViewEntity, readonly string[]> = {
  customers: ["q", "tag", "segment", "lifecycle", "owner", "hasBalance", "consent", "source"],
  leads: ["q", "status", "rating", "owner", "source", "due"],
  // From `crm-deal-views.ts`, not repeated here: the deals screen parses,
  // serialises and labels exactly these keys, and a copy in this file would be
  // the second opinion that lets a stored view name a filter the screen has
  // never heard of (which is how the board came to apply one key of seven).
  deals: DEAL_VIEW_FILTER_KEYS,
  // Likewise from `crm-case-views.ts`. The desk's six keys used to be listed
  // here while the screen honoured two of them, which is precisely the drift
  // this indirection removes.
  cases: CASE_VIEW_FILTER_KEYS,
  activities: ["q", "kind", "state", "assignee", "due"],
};

/**
 * The entities whose filter *values* can be checked, not just their keys.
 *
 * `sanitiseFilters` drops what it does not recognise, which keeps a view from a
 * newer build opening on an older one. That is the right shape for *unknown*
 * keys and the wrong shape for a **known key with an impossible value**: a view
 * named «مذاکره‌های بزرگ» whose `stageId` is a typo would be stored happily and
 * then fail on the screen, for everybody it is shared with.
 *
 * So an entity that has grown a real parser offers it here, and `saveView`
 * refuses a document the parser rejects. `deals` is the first: the board now
 * honours the whole vocabulary (`crm-deal-views.ts`), so it is the first screen
 * able to say what a value must look like. Entities without an entry keep the
 * old behaviour — nothing pretends to validate a vocabulary no screen has
 * defined.
 */
const ENTITY_FILTER_VALIDATORS: Partial<
  Record<SavedViewEntity, (filters: Record<string, string>) => { error: string | null }>
> = {
  deals: (filters) => parseDealViewFilters({ get: (key) => filters[key] ?? null }),
  cases: (filters) => parseCaseViewFilters({ get: (key) => filters[key] ?? null }),
};

export function isSavedViewEntity(value: unknown): value is SavedViewEntity {
  return typeof value === "string" && (SAVED_VIEW_ENTITIES as readonly string[]).includes(value);
}

export interface SavedView extends Record<string, unknown> {
  id: string;
  entity: SavedViewEntity;
  name: string;
  filters: Record<string, string>;
  ownerUserId: string | null;
  isBuiltin: boolean;
  displayOrder: number;
  createdBy: string;
}

/**
 * Keep only the filter keys this entity recognises, as strings.
 *
 * Unknown keys are **dropped, not rejected**: a view saved by a newer build
 * that knows about a filter this one does not should still open, minus the
 * filter it cannot honour. Rejecting would make a mixed-version deployment
 * break views for whoever is on the older tab.
 *
 * Values are coerced to string and length-capped because they end up as query
 * parameters, and an object or a megabyte of text there is either a crash or a
 * very slow query.
 */
export function sanitiseFilters(
  entity: SavedViewEntity,
  filters: unknown,
): Record<string, string> {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return {};
  const allowed = new Set(ENTITY_FILTER_KEYS[entity]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "object") continue;
    const text = String(value).trim().slice(0, 200);
    if (text) out[key] = text;
  }
  return out;
}

/**
 * The views one member can see: the business's shared ones plus their own.
 *
 * Another member's private view is not returned. That is the point of it being
 * private, and `owner_user_id` is checked in SQL rather than filtered in the
 * caller so there is no path where a forgotten filter leaks the list.
 */
export async function listSavedViews(
  businessId: string,
  entity: SavedViewEntity,
  userId: string | null,
): Promise<SavedView[]> {
  const { rows } = await query<SavedView>(
    `SELECT id, entity, name, filters, owner_user_id AS "ownerUserId",
            is_builtin AS "isBuiltin", display_order AS "displayOrder",
            created_by AS "createdBy"
       FROM crm_saved_views
      WHERE business_id = $1 AND entity = $2
        AND (owner_user_id IS NULL OR owner_user_id = $3)
      ORDER BY is_builtin DESC, display_order, name`,
    [businessId, entity, userId],
  );
  return rows.map((row) => ({
    ...row,
    filters: sanitiseFilters(row.entity, row.filters),
  }));
}

export type SaveViewResult =
  | { ok: true; view: SavedView }
  | {
      ok: false;
      error: "not_found" | "name_required" | "builtin_readonly" | "forbidden" | "invalid_filters";
      /** The field that made the view impossible, when one did. */
      field?: string;
    };

export async function saveView(
  businessId: string,
  input: {
    id?: string;
    entity: SavedViewEntity;
    name: string;
    filters: unknown;
    shared: boolean;
  },
  actor: { name: string; userId: string | null },
): Promise<SaveViewResult> {
  const name = input.name?.trim().slice(0, 80);
  if (!name) return { ok: false, error: "name_required" };
  const filters = sanitiseFilters(input.entity, input.filters);
  const validator = ENTITY_FILTER_VALIDATORS[input.entity];
  if (validator) {
    const checked = validator(filters);
    // Named, so the screen can point at the control that holds the bad value
    // rather than showing a generic refusal next to a whole form.
    if (checked.error) return { ok: false, error: "invalid_filters", field: checked.error };
  }

  if (input.id) {
    if (!isUuid(input.id)) return { ok: false, error: "not_found" };
    const { rows } = await query<{ owner_user_id: string | null; is_builtin: boolean }>(
      `SELECT owner_user_id, is_builtin FROM crm_saved_views
        WHERE business_id = $1 AND id = $2`,
      [businessId, input.id],
    );
    const existing = rows[0];
    if (!existing) return { ok: false, error: "not_found" };
    // Built-ins are the app's own views. Editing one would make «همهٔ مشتریان»
    // mean something different for one business, which is a support call
    // nobody can diagnose.
    if (existing.is_builtin) return { ok: false, error: "builtin_readonly" };
    // Somebody else's private view is not yours to rewrite.
    if (existing.owner_user_id && existing.owner_user_id !== actor.userId) {
      return { ok: false, error: "forbidden" };
    }

    await query(
      `UPDATE crm_saved_views
          SET name = $3, filters = $4::jsonb, owner_user_id = $5, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [businessId, input.id, name, JSON.stringify(filters), input.shared ? null : actor.userId],
    );
    const view = await getSavedView(businessId, input.id);
    return view ? { ok: true, view } : { ok: false, error: "not_found" };
  }

  const { rows } = await query<{ id: string }>(
    `INSERT INTO crm_saved_views
       (business_id, entity, name, filters, owner_user_id, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     RETURNING id`,
    [
      businessId,
      input.entity,
      name,
      JSON.stringify(filters),
      input.shared ? null : actor.userId,
      actor.name,
    ],
  );
  const view = await getSavedView(businessId, rows[0].id);
  return view ? { ok: true, view } : { ok: false, error: "not_found" };
}

async function getSavedView(
  businessId: string,
  viewId: string,
): Promise<SavedView | null> {
  if (!isUuid(viewId)) return null;
  const { rows } = await query<SavedView>(
    `SELECT id, entity, name, filters, owner_user_id AS "ownerUserId",
            is_builtin AS "isBuiltin", display_order AS "displayOrder",
            created_by AS "createdBy"
       FROM crm_saved_views WHERE business_id = $1 AND id = $2`,
    [businessId, viewId],
  );
  const row = rows[0];
  return row ? { ...row, filters: sanitiseFilters(row.entity, row.filters) } : null;
}

export async function deleteSavedView(
  businessId: string,
  viewId: string,
  actor: { userId: string | null },
): Promise<boolean> {
  if (!isUuid(viewId)) return false;
  const { rowCount } = await query(
    // The ownership rule is in the DELETE itself rather than a read followed
    // by a write: a check-then-act here would be a race, and the race deletes
    // somebody else's view.
    `DELETE FROM crm_saved_views
      WHERE business_id = $1 AND id = $2 AND is_builtin = false
        AND (owner_user_id IS NULL OR owner_user_id = $3)`,
    [businessId, viewId, actor.userId],
  );
  return (rowCount ?? 0) > 0;
}
