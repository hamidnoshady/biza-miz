/**
 * The organisation structure behind one client — which party is the group, which
 * are its brands, and what work each of them carries.
 *
 * Issue #1128 §A: "Agency client companies with multiple contacts/brands" and
 * "client accounts can have multiple brands and concurrent campaigns". An agency
 * rarely sells to one legal person: it sells to «گروه صنعتی مهر», talks to the
 * brand manager at «مهر فود», and prices a campaign for «مهر کیمیا» — three
 * parties, one client relationship, and a member who cannot see the shape will
 * eventually price one brand's work for another.
 *
 * ## No schema, and that is the finding rather than a shortcut
 *
 * `crm_party_relationships` already carries `parent_organization` and `branch_of`,
 * and `parties.person_type` already distinguishes a legal person from a real one.
 * What was missing is a *reading* of those edges: the customer file showed every
 * relationship as one spoke of a flat ring, so a brand and a contact were the same
 * kind of thing and the hierarchy was invisible. This module is that reading.
 *
 * ## The two kinds are one relation stored twice
 *
 * `crm-relationship-service.ts` states the convention: `from → to` reads "from is
 * *kind* of to". So
 *
 *   * `parent_organization` points **parent → child** ("from is the parent
 *     organisation of to"), and
 *   * `branch_of` points **child → parent** ("from is a branch of to").
 *
 * They are exact inverses, which means a member can record one hierarchy in either
 * direction — or in both, for different pairs — and a resolver that treated them
 * as two facts would see a group with no brands, or a brand with two parents, or
 * nothing at all. `normalizeOrgEdge` collapses them to one `child → parent`
 * statement first, and everything downstream reasons about that. This is the whole
 * reason the module exists as code rather than as a query.
 *
 * ## It terminates on bad data, because the data will be bad
 *
 * Nothing here can assume the edges form a tree. Two members can each record the
 * hierarchy from their own end and produce a cycle; a re-parenting can leave a
 * brand with two claimed parents; a stray edge can point at itself. Every walk is
 * bounded by a visited set *and* by `ORG_DEPTH_LIMIT`, and every contradiction is
 * returned in `conflicts` rather than resolved silently — a screen that quietly
 * picked a winner would be the reason nobody ever fixed the record.
 *
 * ## Not industry-gated
 *
 * A corporate group with brands is not an agency idea; a wholesaler has the same
 * shape. Like §E (decision 32), this is gated by permission and not by trade: §A
 * is the reason it was built, not a limit on who may use it.
 */

import type { RelationshipKind } from "./crm-shared";

/** The two relationship kinds that state an organisation hierarchy. */
export const ORG_RELATIONSHIP_KINDS = ["parent_organization", "branch_of"] as const;

export type OrgRelationshipKind = (typeof ORG_RELATIONSHIP_KINDS)[number];

export function isOrgRelationshipKind(value: unknown): value is OrgRelationshipKind {
  return (
    typeof value === "string" &&
    (ORG_RELATIONSHIP_KINDS as readonly string[]).includes(value)
  );
}

/**
 * How far up and down this module will walk.
 *
 * A real group is two to four levels — holding company, division, brand — and
 * eight is generous enough that no honest structure is cut off while a cyclic or
 * runaway edge still terminates. Reaching it is reported, not hidden: a screen
 * that shows a truncated tree without saying so is showing a different tree.
 */
export const ORG_DEPTH_LIMIT = 8;

/** An edge as `crm_party_relationships` stores it. */
export interface OrgEdgeInput {
  fromPartyId: string;
  toPartyId: string;
  kind: RelationshipKind | string;
  /** ISO stamp. Used to choose between two claimed parents; see `resolveOrgStructure`. */
  createdAt?: string | null;
}

/** The same edge, normalised to the one direction this module reasons in. */
export interface OrgParentEdge {
  childId: string;
  parentId: string;
  kind: OrgRelationshipKind;
  /** The edge as stored, so a screen can show which record to fix. */
  fromPartyId: string;
  toPartyId: string;
  createdAt: string;
}

/**
 * Collapse both hierarchy kinds into one `child → parent` statement.
 *
 * Returns `null` for anything that is not a usable hierarchy edge: a different
 * kind, a self-edge, or a missing party. Callers pass a whole
 * `crm_party_relationships` read and keep the non-nulls, which is why this
 * refuses rather than throws — one stray row must not cost the structure.
 */
export function normalizeOrgEdge(edge: OrgEdgeInput): OrgParentEdge | null {
  if (!isOrgRelationshipKind(edge.kind)) return null;
  const from = edge.fromPartyId;
  const to = edge.toPartyId;
  if (!from || !to || from === to) return null;

  // `parent_organization` is written parent → child; `branch_of` is written
  // child → parent. Same fact, opposite storage, and the reason a resolver that
  // reads only one of them sees half the hierarchy.
  const childId = edge.kind === "parent_organization" ? to : from;
  const parentId = edge.kind === "parent_organization" ? from : to;

  return {
    childId,
    parentId,
    kind: edge.kind,
    fromPartyId: from,
    toPartyId: to,
    createdAt: edge.createdAt ?? "",
  };
}

/** A contradiction in the recorded structure, reported rather than resolved. */
export interface OrgConflict {
  /**
   * `two_parents` — one brand claims two groups. `cycle` — walking up returns to
   * a party already on the path, so there is no top.
   */
  kind: "two_parents" | "cycle";
  /** The party the conflict is about: the brand, or the focus when it sits in a cycle. */
  partyId: string;
  /** Every party involved, so a screen can name them. */
  involvedPartyIds: string[];
}

export interface OrgNode {
  partyId: string;
  name: string;
  /** 0 at the root of the resolved group. */
  depth: number;
  parentId: string | null;
  /** The party whose file is being looked at. */
  isFocus: boolean;
  /** Child ids in the order the edges were given, so a tree is stable per visit. */
  childIds: string[];
  /** Set when this node's parent was chosen between two claims. */
  contestedParent: boolean;
}

export interface OrgStructure {
  /** The topmost party of the resolved group — the client account itself. */
  rootId: string;
  focusId: string;
  /** Root-first, depth-ordered: exactly the order an indented list wants. */
  nodes: OrgNode[];
  byId: Record<string, OrgNode>;
  /** The chain above the focus, nearest first. Empty when the focus is the group. */
  ancestorIds: string[];
  /** Every brand below the focus, nearest first. */
  descendantIds: string[];
  conflicts: OrgConflict[];
  /** A walk stopped at `ORG_DEPTH_LIMIT`, so the picture is incomplete. */
  depthLimited: boolean;
  /**
   * True when there is nothing to draw: no hierarchy edge touches the focus. A
   * screen reads this as "not a grouped client" and renders nothing at all, which
   * is different from an empty group and from a failure.
   */
  isEmpty: boolean;
}

/**
 * Resolve one party's organisation structure out of a flat edge list.
 *
 * Pure and total: any edge list produces a structure, including a contradictory
 * one, and the contradictions come back in `conflicts`. Nothing here reads a
 * clock or a database, so the tree a member sees is a function of the records
 * alone — which is what makes it testable and what stops it rearranging itself
 * between visits.
 *
 * Edges that do not touch the focus's component are ignored. A business may hold
 * several unrelated groups, and this file is about one client's.
 */
export function resolveOrgStructure(options: {
  focusId: string;
  edges: readonly OrgParentEdge[];
  names?: Record<string, string>;
}): OrgStructure {
  const { focusId, edges } = options;
  const names = options.names ?? {};
  const conflicts: OrgConflict[] = [];

  // ---- one parent per child, newest claim winning -------------------------
  // A brand re-parented by adding an edge rather than removing the old one has
  // two claims. The newest statement is taken as the current one, because that is
  // how a correction is actually recorded — and the superseded claim is reported,
  // so the choice is visible and the stale edge can be cleaned up on the
  // data-quality screen rather than silently deciding a hierarchy.
  const claims = new Map<string, OrgParentEdge[]>();
  for (const edge of edges) {
    const list = claims.get(edge.childId);
    if (list) list.push(edge);
    else claims.set(edge.childId, [edge]);
  }

  const parentOf = new Map<string, OrgParentEdge>();
  const contested = new Set<string>();
  for (const [childId, list] of claims) {
    if (list.length === 1) {
      parentOf.set(childId, list[0]);
      continue;
    }
    // Newest first; an absent stamp sorts last, so a stamped correction always
    // outranks an edge nobody dated.
    const ordered = [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    parentOf.set(childId, ordered[0]);
    contested.add(childId);
    conflicts.push({
      kind: "two_parents",
      partyId: childId,
      involvedPartyIds: ordered.map((edge) => edge.parentId),
    });
  }

  const childrenOf = new Map<string, string[]>();
  for (const [childId, edge] of parentOf) {
    const list = childrenOf.get(edge.parentId);
    if (list) list.push(childId);
    else childrenOf.set(edge.parentId, [childId]);
  }

  // ---- walk up to the top --------------------------------------------------
  const ancestors: string[] = [];
  const upward = new Set<string>([focusId]);
  let rootId = focusId;
  let depthLimited = false;
  let cursor = focusId;
  for (;;) {
    const edge = parentOf.get(cursor);
    if (!edge) break;
    if (upward.has(edge.parentId)) {
      // Walking up returned to a party already on the path, so there is no top.
      // The walk stops where it is and the cycle is named: the tree below is
      // drawn from here, which is a partial picture and says so.
      //
      // Only the members *of the cycle* are named, not the whole path climbed to
      // reach it. A brand three levels below a two-party loop is not part of the
      // contradiction, and listing it would send a member to fix a record that is
      // correct.
      const closesAt = ancestors.indexOf(edge.parentId);
      conflicts.push({
        kind: "cycle",
        partyId: focusId,
        involvedPartyIds: closesAt === -1 ? [focusId, ...ancestors] : ancestors.slice(closesAt),
      });
      break;
    }
    if (ancestors.length >= ORG_DEPTH_LIMIT) {
      depthLimited = true;
      break;
    }
    ancestors.push(edge.parentId);
    upward.add(edge.parentId);
    rootId = edge.parentId;
    cursor = edge.parentId;
  }

  // ---- walk down from the top, in the order the edges were given ----------
  const nodes: OrgNode[] = [];
  const byId: Record<string, OrgNode> = {};
  const seen = new Set<string>();
  const queue: Array<{ partyId: string; depth: number; parentId: string | null }> = [
    { partyId: rootId, depth: 0, parentId: null },
  ];

  while (queue.length > 0) {
    const step = queue.shift()!;
    // The visited set is what makes a cycle terminate here as well as above: a
    // node reached twice is drawn once, and the second arrival is dropped.
    if (seen.has(step.partyId)) continue;
    seen.add(step.partyId);

    const node: OrgNode = {
      partyId: step.partyId,
      name: names[step.partyId] ?? "",
      depth: step.depth,
      parentId: step.parentId,
      isFocus: step.partyId === focusId,
      childIds: [],
      contestedParent: contested.has(step.partyId),
    };
    nodes.push(node);
    byId[node.partyId] = node;
    if (step.parentId && byId[step.parentId]) byId[step.parentId].childIds.push(node.partyId);

    if (step.depth + 1 > ORG_DEPTH_LIMIT) {
      depthLimited = true;
      continue;
    }
    for (const childId of childrenOf.get(step.partyId) ?? []) {
      queue.push({ partyId: childId, depth: step.depth + 1, parentId: step.partyId });
    }
  }

  // Depth-ordered, so an indented list is the array as returned. `nodes` is
  // already breadth-first from the root, which is that order.
  // Bounded by the same limit as the walk upward and as the render, because the
  // three have to describe one structure: an unbounded list of descendants next to
  // a depth-limited tree would name brands the tree does not show, and a screen
  // counting them would disagree with the picture beside it.
  const descendantIds: string[] = [];
  const downward = new Set<string>([focusId]);
  const downQueue: Array<{ partyId: string; depth: number }> = [{ partyId: focusId, depth: 0 }];
  while (downQueue.length > 0) {
    const current = downQueue.shift()!;
    if (current.depth >= ORG_DEPTH_LIMIT) {
      depthLimited = true;
      continue;
    }
    for (const childId of childrenOf.get(current.partyId) ?? []) {
      if (downward.has(childId)) continue;
      downward.add(childId);
      descendantIds.push(childId);
      downQueue.push({ partyId: childId, depth: current.depth + 1 });
    }
  }

  const touched = ancestors.length + descendantIds.length;
  return {
    rootId,
    focusId,
    nodes,
    byId,
    // Nearest first, which is the order a breadcrumb reads.
    ancestorIds: ancestors,
    descendantIds,
    conflicts,
    depthLimited,
    isEmpty: touched === 0,
  };
}

/**
 * The group's own name, for a card title.
 *
 * When the focus *is* the group there is nothing above it, and the honest title
 * is the focus's own name rather than an invented word for a group of one.
 */
export function orgGroupName(structure: OrgStructure): string {
  return structure.byId[structure.rootId]?.name ?? "";
}

/**
 * Whether this party is a brand of something else rather than its own group.
 *
 * The distinction the screen cares about: a brand's file should say which group
 * it belongs to, and a group's file should list its brands. Both are the same
 * structure read from a different node.
 */
export function isOrgBrand(structure: OrgStructure): boolean {
  return structure.ancestorIds.length > 0;
}

/** The brands directly below one party — its own children, not its grandchildren. */
export function directBrandIds(structure: OrgStructure, partyId: string): string[] {
  return structure.byId[partyId]?.childIds ?? [];
}
