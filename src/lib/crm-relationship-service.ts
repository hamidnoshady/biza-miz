/**
 * Relationships between parties — «ارتباط اشخاص».
 *
 * ## What this is for
 *
 * A business rarely sells to an abstraction. It sells to «شرکت الف» but talks
 * to «خانم رضایی», invoices «آقای تهرانی» in accounts payable, and needs a
 * different person's signature to close anything. Without a relationship
 * model, those four facts live in a notes field and nobody can answer "who do
 * I call about this invoice?" without reading it.
 *
 * The model is deliberately **a graph over `parties`, not a second hierarchy**.
 * Every node is already a party with its own file, history and consent; a
 * contact of a company is a real person who might also be a retail customer in
 * their own right. Modelling contacts as rows belonging to an organisation
 * would fork that identity in two.
 *
 * ## Direction matters, and is not symmetric
 *
 * `from → to` reads as "from is *kind* of to": «خانم رضایی» is
 * `contact_of` «شرکت الف». The reverse edge is a different statement and is
 * not created automatically, because the inverse of "is a contact of" is "has
 * as a contact", which is not the same relation and would double every count.
 *
 * `household` and `referred_by` are the exceptions people expect to be
 * symmetric — and `household` genuinely is, so the service creates both
 * directions for it. `referred_by` is emphatically not: A referred B does not
 * mean B referred A, and conflating them would corrupt attribution.
 *
 * ## Merging is not handled here
 *
 * When two parties merge, their edges have to be re-pointed — and both the
 * self-edges (the loser was a contact of the winner) and the collisions (both
 * were contacts of the same company) have to be dropped first, or the merge
 * aborts on a constraint. That logic lives in `party-merge-references.ts`,
 * which declares both directions of this table with `selfEdgeColumn` and
 * `uniqueWithSql`, and the merge service applies it generically. Writing a
 * second copy here is precisely the hand-maintained list that registry
 * replaced.
 */

import { query, withTenantTransaction } from "./db";
import { recordCrmAudit } from "./crm-audit-service";
import { isUuid } from "./uuid";
import {
  RELATIONSHIP_KINDS,
  RELATIONSHIP_LABELS,
  isRelationshipKind,
  type PartyRelationship,
  type RelationshipKind,
} from "./crm-shared";
import {
  ORG_RELATIONSHIP_KINDS,
  isOrgBrand,
  normalizeOrgEdge,
  orgGroupName,
  resolveOrgStructure,
  type OrgConflict,
  type OrgParentEdge,
} from "./crm-org-structure";

export {
  RELATIONSHIP_KINDS,
  RELATIONSHIP_LABELS,
  RELATIONSHIP_INVERSE_LABELS,
  isRelationshipKind,
  type RelationshipKind,
  type PartyRelationship,
} from "./crm-shared";

/**
 * Kinds that mean the same thing in both directions.
 *
 * Only `household`. Two people sharing a home each share it with the other,
 * and recording only one direction would make the relationship invisible from
 * one of the two files — which is exactly the file somebody will be looking at.
 */
const SYMMETRIC_KINDS: readonly RelationshipKind[] = ["household"];

/**
 * Every relationship touching one party, from both ends.
 *
 * Both directions in one list, because the question a person asks while
 * looking at a file is "who is connected to this?" — not "who is connected to
 * this in the direction somebody happened to enter it". Each row carries
 * `inverse` so the UI can label it correctly rather than reading «رابط» on the
 * company's file when the company is not anybody's contact.
 */
export async function relationshipsFor(
  businessId: string,
  partyId: string,
): Promise<PartyRelationship[]> {
  if (!isUuid(partyId)) return [];

  const { rows } = await query<PartyRelationship>(
    `SELECT r.id, r.from_party_id AS "fromPartyId", pf.name AS "fromName",
            r.to_party_id AS "toPartyId", pt.name AS "toName",
            r.kind, r.role_title AS "roleTitle", r.is_primary AS "isPrimary",
            r.note, false AS inverse, r.created_at AS "createdAt"
       FROM crm_party_relationships r
       JOIN parties pf ON pf.id = r.from_party_id
       JOIN parties pt ON pt.id = r.to_party_id
      WHERE r.business_id = $1 AND r.from_party_id = $2
      UNION ALL
     SELECT r.id, r.from_party_id, pf.name,
            r.to_party_id, pt.name,
            r.kind, r.role_title, r.is_primary, r.note, true, r.created_at
       FROM crm_party_relationships r
       JOIN parties pf ON pf.id = r.from_party_id
       JOIN parties pt ON pt.id = r.to_party_id
      WHERE r.business_id = $1 AND r.to_party_id = $2
        -- A symmetric kind already has both rows stored, so reading it from
        -- the other end too would show it twice on the same file.
        AND r.kind <> ALL($3::text[])
      ORDER BY "isPrimary" DESC, "createdAt" DESC`,
    [businessId, partyId, [...SYMMETRIC_KINDS]],
  );
  return rows;
}

export type LinkResult =
  | { ok: true; id: string }
  | { ok: false; error: "not_found" | "self_link" | "already_linked" | "invalid_kind" };

/**
 * Create a relationship.
 *
 * Both parties are verified to exist in this business before anything is
 * written: the ids arrive from a browser, and an edge to another tenant's
 * party would surface that party's name on this business's screen.
 */
export async function linkParties(
  businessId: string,
  input: {
    fromPartyId: string;
    toPartyId: string;
    kind: string;
    roleTitle?: string;
    isPrimary?: boolean;
    note?: string;
  },
  actor: { name: string; userId?: string | null },
): Promise<LinkResult> {
  if (!isUuid(input.fromPartyId) || !isUuid(input.toPartyId)) {
    return { ok: false, error: "not_found" };
  }
  if (input.fromPartyId === input.toPartyId) return { ok: false, error: "self_link" };
  if (!isRelationshipKind(input.kind)) return { ok: false, error: "invalid_kind" };
  const kind = input.kind;

  return withTenantTransaction(businessId, async () => {
    const { rows: parties } = await query<{ id: string; name: string }>(
      `SELECT id, name FROM parties
        WHERE business_id = $1 AND id = ANY($2::uuid[]) AND merged_into_id IS NULL`,
      [businessId, [input.fromPartyId, input.toPartyId]],
    );
    // Both, and both unmerged: linking to a record that has been merged away
    // would attach the relationship to a file no screen shows.
    if (parties.length !== 2) return { ok: false as const, error: "not_found" as const };
    const nameOf = new Map(parties.map((p) => [p.id, p.name]));

    // Only one primary contact of a given kind per party. Two "primary billing
    // contacts" is not a state anybody can act on — somebody has to be the one
    // you call first.
    if (input.isPrimary === true) {
      await query(
        `UPDATE crm_party_relationships SET is_primary = false, updated_at = now()
          WHERE business_id = $1 AND to_party_id = $2 AND kind = $3 AND is_primary`,
        [businessId, input.toPartyId, kind],
      );
    }

    const { rows } = await query<{ id: string }>(
      `INSERT INTO crm_party_relationships
         (business_id, from_party_id, to_party_id, kind, role_title, is_primary, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (business_id, from_party_id, to_party_id, kind) DO UPDATE
         SET role_title = EXCLUDED.role_title, is_primary = EXCLUDED.is_primary,
             note = EXCLUDED.note, updated_at = now()
       RETURNING id`,
      [
        businessId,
        input.fromPartyId,
        input.toPartyId,
        kind,
        (input.roleTitle ?? "").trim().slice(0, 120),
        input.isPrimary === true,
        (input.note ?? "").trim().slice(0, 500),
        actor.name,
      ],
    );

    // Symmetric kinds get the mirror edge, so the relationship is visible from
    // whichever file somebody happens to open.
    if (SYMMETRIC_KINDS.includes(kind)) {
      await query(
        `INSERT INTO crm_party_relationships
           (business_id, from_party_id, to_party_id, kind, role_title, is_primary, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (business_id, from_party_id, to_party_id, kind) DO NOTHING`,
        [
          businessId,
          input.toPartyId,
          input.fromPartyId,
          kind,
          (input.roleTitle ?? "").trim().slice(0, 120),
          false,
          (input.note ?? "").trim().slice(0, 500),
          actor.name,
        ],
      );
    }

    await recordCrmAudit({
      businessId,
      kind: "relationship.linked",
      entityType: "relationship",
      entityId: rows[0].id,
      partyId: input.toPartyId,
      summary: `«${nameOf.get(input.fromPartyId)}» ← ${RELATIONSHIP_LABELS[kind]} → «${nameOf.get(input.toPartyId)}»`,
      detail: { kind, fromPartyId: input.fromPartyId, toPartyId: input.toPartyId },
      actorUserId: actor.userId ?? null,
      actorName: actor.name,
    });

    return { ok: true as const, id: rows[0].id };
  });
}

/** Remove a relationship, and its mirror when the kind is symmetric. */
export async function unlinkParties(
  businessId: string,
  relationshipId: string,
  actor: { name: string; userId?: string | null },
): Promise<boolean> {
  if (!isUuid(relationshipId)) return false;

  return withTenantTransaction(businessId, async () => {
    const { rows } = await query<{
      from_party_id: string;
      to_party_id: string;
      kind: RelationshipKind;
    }>(
      `DELETE FROM crm_party_relationships
        WHERE business_id = $1 AND id = $2
        RETURNING from_party_id, to_party_id, kind`,
      [businessId, relationshipId],
    );
    const row = rows[0];
    if (!row) return false;

    if (SYMMETRIC_KINDS.includes(row.kind)) {
      // Leaving the mirror behind would show the relationship on one file and
      // not the other, which reads as a bug in whichever one you open second.
      await query(
        `DELETE FROM crm_party_relationships
          WHERE business_id = $1 AND from_party_id = $2 AND to_party_id = $3 AND kind = $4`,
        [businessId, row.to_party_id, row.from_party_id, row.kind],
      );
    }

    await recordCrmAudit({
      businessId,
      kind: "relationship.unlinked",
      entityType: "relationship",
      entityId: relationshipId,
      partyId: row.to_party_id,
      summary: "یک ارتباط حذف شد",
      detail: { kind: row.kind, fromPartyId: row.from_party_id, toPartyId: row.to_party_id },
      actorUserId: actor.userId ?? null,
      actorName: actor.name,
    });

    return true;
  });
}

/* ===========================================================================
 * The organisation structure behind one client — issue #1128 §A
 *
 * «Agency client companies with multiple contacts/brands». The edges are already
 * in this table; what was missing is a reading of them, because the customer file
 * showed every relationship as one spoke of a flat ring and a brand was
 * indistinguishable from a contact.
 *
 * The reading itself — collapsing `parent_organization` and `branch_of` into one
 * direction, and terminating on cycles and on a brand with two claimed parents —
 * lives in `crm-org-structure.ts`, which is pure and tested without a database.
 * What is here is only the fetch and the work counts, because those are the parts
 * that need a tenant.
 * ======================================================================== */

/**
 * What one brand of the group is carrying, from the registers that name a client.
 *
 * Every register counted here names a client, which is the whole qualification:
 * `crm_deals.customer_id`, `agency_client_briefs.party_id`,
 * `agency_proposals.party_id`, `workspace_contracts.party_id` and — since 0278 —
 * `agency_client_campaigns.party_id`.
 *
 * **`growth_campaigns` is still not counted, and still must not be.** It has no
 * client column, and reading #901's builder showed why adding one would have been
 * a mistake rather than a small extension: that table is a retail cashback
 * automation whose trigger vocabulary is exactly `pos_sale_settled` and whose
 * reward is `cashback`, so its party would be the shopper earning money back. One
 * column meaning two things in two trades is how a report starts lying. 0278's
 * header records the argument.
 *
 * Wave 8 refused to render a campaign count at all, because the only table it
 * could have counted said nothing — and a card reading «۰ کمپین» for every brand
 * states that no brand has campaigns, which is not what absent data says. That
 * refusal was the right call and it is now lifted by the register that could
 * answer, not by relaxing the standard: §A's "concurrent campaigns" is counted
 * here, with the in-flight subset broken out because "two of this brand's
 * campaigns are live now" and "this brand has had two" are different answers.
 */
export interface OrgWorkCounts {
  deals: number;
  briefs: number;
  proposals: number;
  /** Offers the client accepted — the ones that became work. */
  acceptedProposals: number;
  contracts: number;
  campaigns: number;
  /** Campaigns running or paused: §A's "concurrent campaigns" for this brand. */
  campaignsInFlight: number;
}

/** One node of the resolved structure, with what it is carrying. */
export interface OrgMember {
  partyId: string;
  name: string;
  depth: number;
  parentId: string | null;
  isFocus: boolean;
  childIds: string[];
  contestedParent: boolean;
  work: OrgWorkCounts;
}

export interface OrganizationStructure {
  focusId: string;
  focusName: string;
  /** The topmost party — the client account the group rolls up to. */
  groupId: string;
  groupName: string;
  /** True when this file is a brand of something else rather than its own group. */
  isBrand: boolean;
  /** Root-first and depth-ordered: exactly the order an indented list wants. */
  members: OrgMember[];
  ancestorIds: string[];
  descendantIds: string[];
  conflicts: OrgConflict[];
  depthLimited: boolean;
  /** No hierarchy edge touches this party, so there is no card to draw. */
  isEmpty: boolean;
}

type OrgEdgeRow = Record<string, unknown> & {
  from_party_id: string;
  to_party_id: string;
  from_name: string;
  to_name: string;
  kind: RelationshipKind;
  created_at: Date | string;
};

type OrgWorkRow = Record<string, unknown> & {
  party: string;
  register: string;
  total: string | number;
  accepted: string | number;
};

const EMPTY_WORK: OrgWorkCounts = {
  deals: 0,
  briefs: 0,
  proposals: 0,
  acceptedProposals: 0,
  contracts: 0,
  campaigns: 0,
  campaignsInFlight: 0,
};

/**
 * One client's organisation structure, with the work each party in it carries.
 *
 * Returns `null` when the party is not this tenant's — the same answer the file
 * route gives, and the reason the check is here rather than in the route: an id
 * from another tenant must not resolve to a name on this business's screen.
 *
 * Two queries, not one per node. The edges arrive in a single read filtered to the
 * two hierarchy kinds — a small subset of this table by nature, since a business
 * has tens of companies and thousands of contacts — and the counts arrive in a
 * single grouped read over the four registers that name a client, restricted to
 * the parties actually in this group. Both carry their own `business_id` on every
 * table they touch, *including inside each join*: the join is where a predicate
 * is easiest to forget and where forgetting it resolves another tenant's party
 * into this screen's tree.
 */
export async function organizationStructureFor(
  businessId: string,
  partyId: string,
): Promise<OrganizationStructure | null> {
  if (!isUuid(partyId)) return null;

  const { rows: focusRows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM parties WHERE id = $1 AND business_id = $2`,
    [partyId, businessId],
  );
  const focus = focusRows[0];
  if (!focus) return null;

  const { rows: edgeRows } = await query<OrgEdgeRow>(
    `SELECT r.from_party_id, r.to_party_id, r.kind, r.created_at,
            pf.name AS from_name, pt.name AS to_name
       FROM crm_party_relationships r
       JOIN parties pf
         ON pf.id = r.from_party_id AND pf.business_id = r.business_id
       JOIN parties pt
         ON pt.id = r.to_party_id AND pt.business_id = r.business_id
      WHERE r.business_id = $1
        AND r.kind = ANY($2::text[])
      ORDER BY r.created_at`,
    [businessId, [...ORG_RELATIONSHIP_KINDS]],
  );

  const edges = edgeRows
    .map((row) =>
      normalizeOrgEdge({
        fromPartyId: row.from_party_id,
        toPartyId: row.to_party_id,
        kind: row.kind,
        createdAt:
          row.created_at instanceof Date
            ? row.created_at.toISOString()
            : String(row.created_at ?? ""),
      }),
    )
    .filter((edge): edge is OrgParentEdge => edge !== null);

  const names: Record<string, string> = { [focus.id]: focus.name };
  for (const row of edgeRows) {
    names[row.from_party_id] = row.from_name;
    names[row.to_party_id] = row.to_name;
  }

  const structure = resolveOrgStructure({ focusId: focus.id, edges, names });

  const memberIds = structure.nodes.map((node) => node.partyId);
  const work = new Map<string, OrgWorkCounts>();
  for (const id of memberIds) work.set(id, { ...EMPTY_WORK });

  if (memberIds.length > 0) {
    // One grouped read over the four registers that name a client. Each branch
    // carries its own `business_id`, and the party list is this group's own, so
    // the scan is bounded by the structure rather than by the tenant's history.
    const { rows: workRows } = await query<OrgWorkRow>(
      `SELECT party, register, total, accepted FROM (
         SELECT customer_id AS party, 'deals' AS register,
                count(*)::int AS total, 0 AS accepted
           FROM crm_deals
          WHERE business_id = $1 AND customer_id = ANY($2::uuid[])
          GROUP BY customer_id
         UNION ALL
         SELECT party_id, 'briefs', count(*)::int, 0
           FROM agency_client_briefs
          WHERE business_id = $1 AND party_id = ANY($2::uuid[])
          GROUP BY party_id
         UNION ALL
         SELECT party_id, 'proposals', count(*)::int,
                count(*) FILTER (WHERE status = 'accepted')::int
           FROM agency_proposals
          WHERE business_id = $1 AND party_id = ANY($2::uuid[])
          GROUP BY party_id
         UNION ALL
         SELECT party_id, 'contracts', count(*)::int, 0
           FROM workspace_contracts
          WHERE business_id = $1 AND party_id = ANY($2::uuid[])
          GROUP BY party_id
         UNION ALL
         SELECT party_id, 'campaigns', count(*)::int,
                count(*) FILTER (WHERE status IN ('running', 'paused'))::int
           FROM agency_client_campaigns
          WHERE business_id = $1 AND party_id = ANY($2::uuid[])
          GROUP BY party_id
       ) w`,
      [businessId, memberIds],
    );
    for (const row of workRows) {
      const counts = work.get(row.party);
      if (!counts) continue;
      const total = Number(row.total) || 0;
      if (row.register === "deals") counts.deals = total;
      else if (row.register === "briefs") counts.briefs = total;
      else if (row.register === "contracts") counts.contracts = total;
      else if (row.register === "proposals") {
        counts.proposals = total;
        counts.acceptedProposals = Number(row.accepted) || 0;
      } else if (row.register === "campaigns") {
        counts.campaigns = total;
        counts.campaignsInFlight = Number(row.accepted) || 0;
      }
    }
  }

  const members: OrgMember[] = structure.nodes.map((node) => ({
    partyId: node.partyId,
    name: node.name,
    depth: node.depth,
    parentId: node.parentId,
    isFocus: node.isFocus,
    childIds: node.childIds,
    contestedParent: node.contestedParent,
    work: work.get(node.partyId) ?? { ...EMPTY_WORK },
  }));

  return {
    focusId: focus.id,
    focusName: focus.name,
    groupId: structure.rootId,
    groupName: orgGroupName(structure),
    isBrand: isOrgBrand(structure),
    members,
    ancestorIds: structure.ancestorIds,
    descendantIds: structure.descendantIds,
    conflicts: structure.conflicts,
    depthLimited: structure.depthLimited,
    isEmpty: structure.isEmpty,
  };
}
