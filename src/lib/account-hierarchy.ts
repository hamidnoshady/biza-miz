/**
 * The one definition of "may this account sit under that parent?".
 *
 * Every writer that attaches an account to a parent asks this module, and
 * nothing else re-derives the rules: the editor (accounts-service create and
 * reparent), the Holoo importer, pairing restore and the industry-chart seed.
 * Before this module existed, the archived-parent check lived in one adapter
 * and was missing from another, and the depth clamp lived in a third
 * (issue #824 findings 1 and 2).
 *
 * The rules, in the order they are checked:
 *
 *  1. The parent exists in this business (`parent_not_found`).
 *  2. The parent is active (`parent_archived`). A child under an archived
 *     parent is invisible to the editor and to the picker, and would let an
 *     archive silently strand live postings.
 *  3. The parent is not already at the deepest tier (`parent_too_deep`).
 *     There is no tier below تفصیلی, so the child has no level to take. This
 *     is an error, never a clamp: a clamped child would claim a depth the
 *     chart does not have.
 *  4. The child's accounting type equals the parent's (`parent_type_mismatch`).
 *
 * The DB-facing function takes a `PoolClient` and must run while the business's
 * chart lock is held (`lockChartOfAccounts`); otherwise the parent can be
 * archived or moved between the read and the write.
 *
 * The pure half (`orderAccountTree`) validates a whole snapshot of accounts
 * before anything is written, so a malformed snapshot is refused as a unit.
 */
import type { PoolClient } from "pg";
import { nextAccountLevel, type AccountLevel, type AccountType } from "./coa-template";
import { AccountsError } from "./accounts-error";
import { isUuid } from "./uuid";

/** The parent facts a child attachment depends on. */
export interface AttachableParent {
  id: string;
  code: string;
  type: AccountType;
  level: AccountLevel;
  isActive: boolean;
}

/**
 * The type rule, as one primitive: a child carries its parent's accounting
 * type. Shared by live attachment (`attachmentLevel`) and by snapshot restore
 * (`orderAccountTree`), so the two cannot disagree about what a mismatch is.
 */
export function childTypeMatchesParent(parentType: AccountType, childType: AccountType): boolean {
  return parentType === childType;
}

/**
 * Pure rule set for one live attachment. Returns the level the child takes.
 * Throws `AccountsError` with the code the editor already reports, so every
 * adapter surfaces the same message for the same mistake.
 *
 * This is the LIVE policy: it refuses an archived parent. Snapshot restore has
 * its own policy (see `orderAccountTree`): it keeps archived rows as they are
 * and checks only structure and type, because a restored chart must mirror its
 * source, not re-decide it. Both share the depth and type primitives above.
 */
export function attachmentLevel(parent: AttachableParent, childType: AccountType): AccountLevel {
  if (!parent.isActive) throw new AccountsError("parent_archived", 409);
  const level = nextAccountLevel(parent.level);
  if (!level) throw new AccountsError("parent_too_deep", 409);
  if (!childTypeMatchesParent(parent.type, childType)) throw new AccountsError("parent_type_mismatch", 409);
  return level;
}

/**
 * Loads `parentId` within `businessId` and applies `attachmentLevel`.
 * Must be called inside the caller's transaction with the chart lock held.
 * A non-UUID id is `parent_not_found` (never a 500 from the uuid cast).
 */
export async function resolveAttachableParent(
  client: PoolClient,
  businessId: string,
  parentId: string,
  childType: AccountType,
): Promise<{ parent: AttachableParent; level: AccountLevel }> {
  const parent = await loadAttachableParent(client, businessId, parentId);
  return { parent, level: attachmentLevel(parent, childType) };
}

/** The raw parent row, without applying the attachment rules. */
export async function loadAttachableParent(
  client: PoolClient,
  businessId: string,
  parentId: string,
): Promise<AttachableParent> {
  if (!isUuid(parentId)) throw new AccountsError("parent_not_found");
  const { rows } = await client.query<{
    id: string;
    code: string;
    type: AccountType;
    level: AccountLevel;
    is_active: boolean;
  }>(
    `SELECT id, code, type::text AS type, level::text AS level, is_active
       FROM accounts WHERE business_id = $1 AND id = $2`,
    [businessId, parentId],
  );
  const row = rows[0];
  if (!row) throw new AccountsError("parent_not_found");
  return { id: row.id, code: row.code, type: row.type, level: row.level, isActive: row.is_active };
}

/** Thrown by `orderAccountTree` for a snapshot that cannot be restored as-is. */
export class AccountTreeError extends Error {
  constructor(
    readonly reason: "duplicate_code" | "parent_missing" | "parent_cycle" | "too_deep" | "type_mismatch",
    readonly code: string,
  ) {
    super(`account_tree_${reason}:${code}`);
  }
}

export interface TreeNode {
  code: string;
  parentCode: string | null;
  /**
   * Checked against the parent's type whenever both nodes carry one. A node
   * without a type (the type-free callers) is ordered by structure alone.
   */
  type?: AccountType;
}

/**
 * Orders a flat account list parents-first and derives every row's level from
 * its parent's — the only level computation pairing restore may use.
 *
 * Refuses (`AccountTreeError`) instead of guessing when the list is not a tree:
 * a duplicate code, a parent code that is not in the list, a cycle, a chain
 * deeper than the four tiers, or a child whose type differs from its parent's.
 * The previous restore clamped the depth case to «تفصیلی» and quietly re-rooted
 * the missing-parent case, producing a chart whose levels disagreed with its
 * parents; it also never looked at types at all.
 *
 * This is the SNAPSHOT policy. It keeps every row's `is_active` and `is_contra`
 * as the source wrote them (the caller writes them), so an archived parent is
 * not refused here: refusing it would flatten a legitimate source chart. Live
 * attachment is the stricter `attachmentLevel`.
 */
export function orderAccountTree<T extends TreeNode>(nodes: readonly T[]): {
  ordered: T[];
  levelByCode: Map<string, AccountLevel>;
} {
  const byCode = new Map<string, T>();
  for (const node of nodes) {
    if (byCode.has(node.code)) throw new AccountTreeError("duplicate_code", node.code);
    byCode.set(node.code, node);
  }
  const levelByCode = new Map<string, AccountLevel>();
  const typeByCode = new Map<string, AccountType | undefined>();
  const ordered: T[] = [];
  for (const node of nodes) {
    if (levelByCode.has(node.code)) continue;
    // Walk up to the first resolved ancestor (or a root), then resolve the
    // chain top-down. `inChain` makes a cycle a finite, named error.
    const chain: T[] = [];
    const inChain = new Set<string>();
    let cursor: T | null = node;
    let resolvedAncestor: string | null = null;
    while (cursor) {
      if (inChain.has(cursor.code)) throw new AccountTreeError("parent_cycle", cursor.code);
      inChain.add(cursor.code);
      chain.push(cursor);
      if (!cursor.parentCode) break;
      if (levelByCode.has(cursor.parentCode)) {
        resolvedAncestor = cursor.parentCode;
        break;
      }
      const parent = byCode.get(cursor.parentCode);
      if (!parent) throw new AccountTreeError("parent_missing", cursor.code);
      cursor = parent;
    }
    let parentLevel: AccountLevel | null = resolvedAncestor ? levelByCode.get(resolvedAncestor)! : null;
    for (let i = chain.length - 1; i >= 0; i--) {
      const level = nextAccountLevel(parentLevel);
      if (!level) throw new AccountTreeError("too_deep", chain[i].code);
      // Parents are assigned before their children (top-down), so the parent's
      // type is already resolved here.
      const node = chain[i];
      if (node.parentCode && node.type !== undefined) {
        const parentType = typeByCode.get(node.parentCode);
        if (parentType !== undefined && !childTypeMatchesParent(parentType, node.type)) {
          throw new AccountTreeError("type_mismatch", node.code);
        }
      }
      typeByCode.set(node.code, node.type);
      levelByCode.set(chain[i].code, level);
      ordered.push(chain[i]);
      parentLevel = level;
    }
  }
  return { ordered, levelByCode };
}
