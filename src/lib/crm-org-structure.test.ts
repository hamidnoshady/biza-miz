import { describe, expect, it } from "vitest";

import {
  ORG_DEPTH_LIMIT,
  ORG_RELATIONSHIP_KINDS,
  directBrandIds,
  isOrgBrand,
  isOrgRelationshipKind,
  normalizeOrgEdge,
  orgGroupName,
  resolveOrgStructure,
  type OrgEdgeInput,
  type OrgParentEdge,
} from "./crm-org-structure";

const GROUP = "aaaaaaaa-0000-0000-0000-000000000001";
const BRAND_A = "aaaaaaaa-0000-0000-0000-000000000002";
const BRAND_B = "aaaaaaaa-0000-0000-0000-000000000003";
const DIVISION = "aaaaaaaa-0000-0000-0000-000000000004";
const OTHER = "aaaaaaaa-0000-0000-0000-000000000005";
const CONTACT = "aaaaaaaa-0000-0000-0000-000000000006";

const NAMES: Record<string, string> = {
  [GROUP]: "گروه صنعتی مهر",
  [BRAND_A]: "مهر فود",
  [BRAND_B]: "مهر کیمیا",
  [DIVISION]: "دستهٔ مصرفی",
  [OTHER]: "گروه دیگر",
  [CONTACT]: "نازنین موحد",
};

/** Edges as the table stores them, normalised the way the service does. */
function edgesOf(inputs: OrgEdgeInput[]): OrgParentEdge[] {
  return inputs.map(normalizeOrgEdge).filter((e): e is OrgParentEdge => e !== null);
}

/** `parent_organization` is written parent → child. */
const parentOrg = (from: string, to: string, createdAt = ""): OrgEdgeInput => ({
  fromPartyId: from,
  toPartyId: to,
  kind: "parent_organization",
  createdAt,
});
/** `branch_of` is written child → parent. */
const branchOf = (from: string, to: string, createdAt = ""): OrgEdgeInput => ({
  fromPartyId: from,
  toPartyId: to,
  kind: "branch_of",
  createdAt,
});

describe("the two hierarchy kinds are one relation", () => {
  it("names exactly the kinds that state a hierarchy", () => {
    expect([...ORG_RELATIONSHIP_KINDS]).toEqual(["parent_organization", "branch_of"]);
    for (const kind of ORG_RELATIONSHIP_KINDS) expect(isOrgRelationshipKind(kind)).toBe(true);
    // A contact is not a brand, and treating one as such would put a person in
    // the organisation tree.
    expect(isOrgRelationshipKind("contact_of")).toBe(false);
    expect(isOrgRelationshipKind("decision_maker")).toBe(false);
    expect(isOrgRelationshipKind("household")).toBe(false);
    expect(isOrgRelationshipKind(undefined)).toBe(false);
  });

  it("collapses both storage directions to the same child → parent statement", () => {
    // «from → to» reads "from is *kind* of to", so the two kinds point opposite
    // ways about the same fact. A resolver reading only one sees half the group.
    const viaParent = normalizeOrgEdge(parentOrg(GROUP, BRAND_A));
    const viaBranch = normalizeOrgEdge(branchOf(BRAND_A, GROUP));
    expect(viaParent).not.toBeNull();
    expect(viaBranch).not.toBeNull();
    expect(viaParent!.childId).toBe(BRAND_A);
    expect(viaParent!.parentId).toBe(GROUP);
    expect(viaBranch!.childId).toBe(BRAND_A);
    expect(viaBranch!.parentId).toBe(GROUP);
  });

  it("refuses what is not a usable hierarchy edge", () => {
    expect(normalizeOrgEdge({ fromPartyId: CONTACT, toPartyId: GROUP, kind: "contact_of" })).toBeNull();
    expect(normalizeOrgEdge(parentOrg(GROUP, GROUP))).toBeNull();
    expect(normalizeOrgEdge({ fromPartyId: "", toPartyId: GROUP, kind: "branch_of" })).toBeNull();
    expect(normalizeOrgEdge({ fromPartyId: GROUP, toPartyId: "", kind: "branch_of" })).toBeNull();
  });

  it("keeps the stored edge, so a screen can name the record to fix", () => {
    const edge = normalizeOrgEdge(branchOf(BRAND_A, GROUP, "2026-01-02T00:00:00Z"))!;
    expect(edge.fromPartyId).toBe(BRAND_A);
    expect(edge.toPartyId).toBe(GROUP);
    expect(edge.kind).toBe("branch_of");
    expect(edge.createdAt).toBe("2026-01-02T00:00:00Z");
  });

  it("treats a missing stamp as the oldest statement", () => {
    expect(normalizeOrgEdge(parentOrg(GROUP, BRAND_A))!.createdAt).toBe("");
  });
});

describe("resolving a group", () => {
  const twoBrands = edgesOf([parentOrg(GROUP, BRAND_A), parentOrg(GROUP, BRAND_B)]);

  it("roots on the group when the file being read is the group", () => {
    const structure = resolveOrgStructure({ focusId: GROUP, edges: twoBrands, names: NAMES });
    expect(structure.rootId).toBe(GROUP);
    expect(structure.ancestorIds).toEqual([]);
    expect(structure.descendantIds).toEqual([BRAND_A, BRAND_B]);
    expect(isOrgBrand(structure)).toBe(false);
    expect(orgGroupName(structure)).toBe("گروه صنعتی مهر");
    expect(structure.conflicts).toEqual([]);
    expect(structure.depthLimited).toBe(false);
    expect(structure.isEmpty).toBe(false);
  });

  it("roots on the group when the file being read is one of its brands", () => {
    const structure = resolveOrgStructure({ focusId: BRAND_A, edges: twoBrands, names: NAMES });
    expect(structure.rootId).toBe(GROUP);
    expect(structure.ancestorIds).toEqual([GROUP]);
    expect(isOrgBrand(structure)).toBe(true);
    expect(orgGroupName(structure)).toBe("گروه صنعتی مهر");
    // The brand's own siblings are in the picture: a member reading «مهر فود» needs
    // to see that «مهر کیمیا» is a different brand of the same group, which is the
    // fact that stops one brand's work being priced for the other.
    expect(structure.nodes.map((n) => n.partyId)).toEqual([GROUP, BRAND_A, BRAND_B]);
    expect(structure.descendantIds).toEqual([]);
  });

  it("returns nodes root-first and depth-ordered, ready to indent", () => {
    const structure = resolveOrgStructure({
      focusId: BRAND_A,
      edges: edgesOf([parentOrg(GROUP, DIVISION), parentOrg(DIVISION, BRAND_A), branchOf(BRAND_B, GROUP)]),
      names: NAMES,
    });
    expect(structure.nodes.map((n) => [n.partyId, n.depth])).toEqual([
      [GROUP, 0],
      [DIVISION, 1],
      [BRAND_B, 1],
      [BRAND_A, 2],
    ]);
    expect(structure.ancestorIds).toEqual([DIVISION, GROUP]);
    expect(structure.byId[BRAND_A].parentId).toBe(DIVISION);
    expect(structure.byId[DIVISION].childIds).toEqual([BRAND_A]);
    expect(directBrandIds(structure, GROUP)).toEqual([DIVISION, BRAND_B]);
  });

  it("resolves a hierarchy recorded in both directions as one tree", () => {
    const mixed = edgesOf([parentOrg(GROUP, BRAND_A), branchOf(BRAND_B, GROUP)]);
    const structure = resolveOrgStructure({ focusId: GROUP, edges: mixed, names: NAMES });
    expect(structure.descendantIds).toEqual([BRAND_A, BRAND_B]);
    expect(structure.conflicts).toEqual([]);
  });

  it("says there is nothing to draw when no hierarchy touches the focus", () => {
    // Different from an empty group and from a failure: a client that is not part
    // of a group gets no card at all, rather than a card saying «بدون برند».
    const structure = resolveOrgStructure({
      focusId: CONTACT,
      edges: edgesOf([
        parentOrg(GROUP, BRAND_A),
        { fromPartyId: CONTACT, toPartyId: GROUP, kind: "contact_of" },
      ]),
      names: NAMES,
    });
    expect(structure.isEmpty).toBe(true);
    expect(structure.nodes.map((n) => n.partyId)).toEqual([CONTACT]);
    expect(structure.rootId).toBe(CONTACT);
  });

  it("ignores a group the focus has nothing to do with", () => {
    const structure = resolveOrgStructure({
      focusId: BRAND_A,
      edges: edgesOf([parentOrg(GROUP, BRAND_A), parentOrg(OTHER, "bbbbbbbb-0000-0000-0000-000000000009")]),
      names: NAMES,
    });
    expect(structure.nodes.map((n) => n.partyId)).toEqual([GROUP, BRAND_A]);
  });

  it("leaves a name blank rather than inventing one", () => {
    const structure = resolveOrgStructure({ focusId: GROUP, edges: twoBrands });
    expect(structure.byId[GROUP].name).toBe("");
  });
});

describe("contradictory records, reported rather than resolved", () => {
  it("takes the newest claim when a brand has two parents, and says so", () => {
    // A re-parenting is recorded by adding an edge, not by removing the old one,
    // so two claims is the normal shape of a correction in progress.
    const structure = resolveOrgStructure({
      focusId: BRAND_A,
      edges: edgesOf([
        parentOrg(OTHER, BRAND_A, "2025-01-01T00:00:00Z"),
        parentOrg(GROUP, BRAND_A, "2026-01-01T00:00:00Z"),
      ]),
      names: NAMES,
    });
    expect(structure.byId[BRAND_A].parentId).toBe(GROUP);
    expect(structure.byId[BRAND_A].contestedParent).toBe(true);
    expect(structure.conflicts).toEqual([
      { kind: "two_parents", partyId: BRAND_A, involvedPartyIds: [GROUP, OTHER] },
    ]);
  });

  it("outranks an undated claim with a dated one, whichever order they arrive in", () => {
    for (const order of [
      [parentOrg(OTHER, BRAND_A), parentOrg(GROUP, BRAND_A, "2026-01-01T00:00:00Z")],
      [parentOrg(GROUP, BRAND_A, "2026-01-01T00:00:00Z"), parentOrg(OTHER, BRAND_A)],
    ]) {
      const structure = resolveOrgStructure({
        focusId: BRAND_A,
        edges: edgesOf(order),
        names: NAMES,
      });
      expect(structure.byId[BRAND_A].parentId).toBe(GROUP);
      expect(structure.conflicts).toHaveLength(1);
    }
  });

  it("terminates on a two-party cycle and names it", () => {
    // Each member recorded the hierarchy from their own end. There is no top, so
    // the walk stops where it is and the tree is drawn partial — and says so.
    const structure = resolveOrgStructure({
      focusId: GROUP,
      edges: edgesOf([parentOrg(GROUP, BRAND_A), parentOrg(BRAND_A, GROUP)]),
      names: NAMES,
    });
    expect(structure.conflicts).toEqual([
      { kind: "cycle", partyId: GROUP, involvedPartyIds: [GROUP, BRAND_A] },
    ]);
    // Both parties are drawn exactly once, not forever.
    expect(structure.nodes.map((n) => n.partyId).sort()).toEqual([BRAND_A, GROUP].sort());
    expect(structure.rootId).toBe(BRAND_A);
  });

  it("terminates on a longer cycle", () => {
    const structure = resolveOrgStructure({
      focusId: GROUP,
      edges: edgesOf([
        parentOrg(GROUP, DIVISION),
        parentOrg(DIVISION, BRAND_A),
        branchOf(GROUP, BRAND_A),
      ]),
      names: NAMES,
    });
    expect(structure.nodes.length).toBeLessThanOrEqual(3);
    expect(structure.conflicts.some((c) => c.kind === "cycle")).toBe(true);
  });

  it("reports a cycle reached from below as well as from above", () => {
    const structure = resolveOrgStructure({
      focusId: BRAND_A,
      edges: edgesOf([parentOrg(GROUP, BRAND_A), parentOrg(BRAND_A, GROUP)]),
      names: NAMES,
    });
    expect(structure.conflicts.some((c) => c.kind === "cycle")).toBe(true);
    expect(structure.nodes.length).toBeLessThanOrEqual(2);
  });

  it("stops at the depth limit and reports that the picture is incomplete", () => {
    // A runaway edge must not produce a thousand-node tree, and a truncated one
    // must not look complete.
    const ids = Array.from({ length: ORG_DEPTH_LIMIT + 6 }, (_, i) => `n${i}`);
    const chain = edgesOf(ids.slice(0, -1).map((id, i) => parentOrg(id, ids[i + 1])));
    const structure = resolveOrgStructure({ focusId: ids[ids.length - 1], edges: chain });
    expect(structure.depthLimited).toBe(true);
    expect(structure.ancestorIds).toHaveLength(ORG_DEPTH_LIMIT);
    expect(structure.nodes).toHaveLength(ORG_DEPTH_LIMIT + 1);
    expect(structure.rootId).toBe(ids[ids.length - 1 - ORG_DEPTH_LIMIT]);
  });

  it("bounds a downward runaway too", () => {
    // Each node claims the next as its brand, in a chain with no top reachable
    // from the focus: the downward walk has to stop on its own.
    const ids = Array.from({ length: ORG_DEPTH_LIMIT + 6 }, (_, i) => `d${i}`);
    const chain = edgesOf(ids.slice(0, -1).map((id, i) => parentOrg(id, ids[i + 1])));
    const structure = resolveOrgStructure({ focusId: ids[0], edges: chain });
    expect(structure.nodes.length).toBeLessThanOrEqual(ORG_DEPTH_LIMIT + 2);
    expect(structure.descendantIds.length).toBeLessThanOrEqual(ORG_DEPTH_LIMIT + 1);
  });
});
