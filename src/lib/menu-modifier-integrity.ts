/**
 * "Can this modifier group still be satisfied?" — the one integrity rule
 * that keeps a menu orderable.
 *
 * A group attached to a sellable item must never require more selections
 * than it has active options: `min_select = 2` with one active «شیر بادام»
 * is an item no till can ever ring up, and the failure surfaces far from the
 * menu screen that caused it — as `invalid_modifier_selection` at checkout.
 * Every write that could create such a state runs through here and is
 * refused with `modifier_group_unsatisfiable` instead:
 *
 *   - changing a group's min_select (against every attached item's own
 *     resolved bounds, override → default);
 *   - reactivating a group whose options have since gone away;
 *   - deactivating or deleting a modifier that a required group still needs;
 *   - attaching a group to an item whose resolved min exceeds the group's
 *     active option count;
 *   - setting an item's per-attachment overrides;
 *   - the CSV/XLSX import and the branch clone (via the same service);
 *   - attaching (or re-enabling) a group that is itself disabled, which the
 *     POS would silently omit (`group_inactive`).
 *
 * `max_select` is deliberately *not* clamped to the active option count: an
 * upper bound larger than the menu happens legitimately (options return
 * seasonally) and breaks nothing, because a guest can always choose fewer.
 * The nonsensical configuration is the one that is impossible to satisfy,
 * and that is min > active options.
 *
 * DB-touching, so not unit-tested directly (repo convention); the pure
 * bounds resolution it relies on is in order-line-modifiers.ts, and the
 * integration tests exercise the refusals end-to-end.
 */
import { query } from "./db";
import { effectiveSelectionBounds } from "./order-line-modifiers";

export type IntegrityResult =
  | { ok: true }
  | {
      ok: false;
      error: "modifier_group_unsatisfiable" | "group_inactive" | "group_not_found";
      status: 409 | 404;
    };

interface Executable {
  query<T extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const poolExec: Executable = { query };

interface GroupRow extends Record<string, unknown> {
  id: string;
  is_active: boolean;
  min_select: number;
  max_select: number;
}

interface LinkRow {
  menuItemId: string;
  minSelectOverride: number | null;
  maxSelectOverride: number | null;
}

async function readGroup(
  exec: Executable,
  locationId: string,
  groupId: string,
): Promise<GroupRow | null> {
  const { rows } = await exec.query<GroupRow>(
    "SELECT id, is_active, min_select, max_select FROM modifier_groups WHERE id = $1 AND location_id = $2",
    [groupId, locationId],
  );
  return rows[0] ?? null;
}

/**
 * A *disabled* group is not offered by the POS — `buildRestaurantMenuIndex`
 * drops it — so an attachment to one is configuration the manager can see and
 * the till can never use. Worse, a required one makes the item look configured
 * while it is unsellable. The item sheet hides disabled groups from its picker,
 * but that is only one caller: a direct `POST /api/menu/item-modifier-groups`, a
 * stale selection made before another manager disabled the group, or the import
 * path would still write the link. The rule therefore lives here, where every
 * writer meets it.
 */
export async function assertGroupAttachable(
  locationId: string,
  modifierGroupId: string,
  options: { client?: Executable } = {},
): Promise<IntegrityResult> {
  const exec = options.client ?? poolExec;
  const group = await readGroup(exec, locationId, modifierGroupId);
  if (!group) return { ok: false, error: "group_not_found", status: 404 };
  if (!group.is_active) return { ok: false, error: "group_inactive", status: 409 };
  return { ok: true };
}

async function activeModifierCount(exec: Executable, groupId: string): Promise<number> {
  const { rows } = await exec.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM modifiers WHERE group_id = $1 AND is_active",
    [groupId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function activeLinks(exec: Executable, groupId: string): Promise<LinkRow[]> {
  const { rows } = await exec.query<{
    menu_item_id: string;
    min_select_override: number | null;
    max_select_override: number | null;
  }>(
    `SELECT menu_item_id, min_select_override, max_select_override
       FROM menu_item_modifier_groups
      WHERE modifier_group_id = $1 AND is_active`,
    [groupId],
  );
  return rows.map((row) => ({
    menuItemId: row.menu_item_id,
    minSelectOverride: row.min_select_override,
    maxSelectOverride: row.max_select_override,
  }));
}

/**
 * Whether every item actively carrying `group` can still select
 * `activeOptions` choices from it. An inactive group is not offered at all,
 * so it is always fine — the check runs again when the group is reactivated.
 */
function linksSatisfiable(
  groupDefaults: { min: number; max: number },
  links: LinkRow[],
  activeOptions: number,
  overridesFor?: (link: LinkRow) => { minSelectOverride?: number | null; maxSelectOverride?: number | null },
): boolean {
  return links.every((link) => {
    const bounds = effectiveSelectionBounds(groupDefaults, overridesFor?.(link) ?? link);
    return bounds.min <= activeOptions;
  });
}

/**
 * A group's own min/max is changing (create/edit/import): every actively
 * attached item must remain able to satisfy the new resolved bounds.
 * `prospectiveOverrides` applies only to one link (the item whose attachment
 * is being configured in the same operation).
 */
export async function assertGroupBoundsSatisfiable(
  locationId: string,
  groupId: string,
  nextBounds: { min: number; max: number },
  options: {
    client?: Executable;
    /** Treat the group as active even if it currently is not (creation/activation). */
    assumeActive?: boolean;
    /** New per-item overrides being written to one attached item in the same operation. */
    prospectiveOverrides?: { menuItemId: string; minSelectOverride: number | null; maxSelectOverride: number | null };
  } = {},
): Promise<IntegrityResult> {
  const exec = options.client ?? poolExec;
  const group = await readGroup(exec, locationId, groupId);
  if (!group) return { ok: false, error: "modifier_group_unsatisfiable", status: 409 };
  if (!group.is_active && !options.assumeActive) return { ok: true };

  const links = await activeLinks(exec, groupId);
  if (links.length === 0) return { ok: true };
  const activeOptions = await activeModifierCount(exec, groupId);
  const ok = linksSatisfiable(nextBounds, links, activeOptions, (link) =>
    options.prospectiveOverrides && options.prospectiveOverrides.menuItemId === link.menuItemId
      ? options.prospectiveOverrides
      : link,
  );
  return ok ? { ok: true } : { ok: false, error: "modifier_group_unsatisfiable", status: 409 };
}

/** Reactivating a group re-offers it everywhere it is still attached. */
export async function assertGroupActivationSatisfiable(
  locationId: string,
  groupId: string,
  options: { client?: Executable } = {},
): Promise<IntegrityResult> {
  const exec = options.client ?? poolExec;
  const group = await readGroup(exec, locationId, groupId);
  if (!group) return { ok: false, error: "modifier_group_unsatisfiable", status: 409 };
  const links = await activeLinks(exec, groupId);
  if (links.length === 0) return { ok: true };
  const activeOptions = await activeModifierCount(exec, groupId);
  const ok = linksSatisfiable({ min: group.min_select, max: group.max_select }, links, activeOptions);
  return ok ? { ok: true } : { ok: false, error: "modifier_group_unsatisfiable", status: 409 };
}

/**
 * A modifier is being deactivated or deleted: every group it belongs to must
 * keep enough active options for the items carrying that group. (Deleting a
 * modifier cascades nothing but its own ingredient links; the group stays.)
 */
export async function assertModifierRemovalSafe(
  locationId: string,
  modifierId: string,
  options: { client?: Executable } = {},
): Promise<IntegrityResult> {
  const exec = options.client ?? poolExec;
  const { rows } = await exec.query<{ group_id: string }>(
    "SELECT group_id FROM modifiers WHERE id = $1 AND location_id = $2",
    [modifierId, locationId],
  );
  const modifier = rows[0];
  if (!modifier) return { ok: true }; // unknown modifier: not this rule's problem

  const group = await readGroup(exec, locationId, modifier.group_id);
  if (!group || !group.is_active) return { ok: true };
  const links = await activeLinks(exec, modifier.group_id);
  if (links.length === 0) return { ok: true };

  const { rows: countRows } = await exec.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM modifiers WHERE group_id = $1 AND is_active AND id <> $2",
    [modifier.group_id, modifierId],
  );
  const remaining = Number(countRows[0]?.count ?? 0);
  const ok = linksSatisfiable(
    { min: group.min_select, max: group.max_select },
    links,
    remaining,
  );
  return ok ? { ok: true } : { ok: false, error: "modifier_group_unsatisfiable", status: 409 };
}

/**
 * Attaching a group to an item (or re-configuring an item's attachment):
 * with the item's resolved bounds, the group's active options must be
 * enough. Also refuses bounds that are unsatisfiable in themselves.
 */
export async function assertAttachmentSatisfiable(
  locationId: string,
  menuItemId: string,
  modifierGroupId: string,
  overrides: { minSelectOverride?: number | null; maxSelectOverride?: number | null },
  options: { client?: Executable } = {},
): Promise<IntegrityResult> {
  const exec = options.client ?? poolExec;
  const group = await readGroup(exec, locationId, modifierGroupId);
  if (!group) return { ok: false, error: "modifier_group_unsatisfiable", status: 409 };
  if (!group.is_active) return { ok: true };

  const bounds = effectiveSelectionBounds(
    { min: group.min_select, max: group.max_select },
    overrides,
  );
  if (bounds.min > bounds.max) {
    return { ok: false, error: "modifier_group_unsatisfiable", status: 409 };
  }
  const activeOptions = await activeModifierCount(exec, modifierGroupId);
  if (bounds.min <= activeOptions) return { ok: true };
  return { ok: false, error: "modifier_group_unsatisfiable", status: 409 };
}
