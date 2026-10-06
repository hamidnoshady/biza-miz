/**
 * The relationship graph's shape — the ring on a customer's file.
 *
 * The renderer is deliberately dumb (it draws what this module computes), so
 * everything worth getting right is pinned here: the direction an edge reads
 * from *this* file's end, the determinism of the ring, one spoke per recorded
 * fact, the kinds legend, and the caption that carries the whole picture in
 * words for anybody who cannot see it.
 */
import { describe, expect, it } from "vitest";
import type { PartyRelationship } from "./crm-shared";
import {
  GRAPH_SPACE,
  relationshipGraph,
  relationshipGraphCaption,
} from "./crm-relationship-graph";

function link(over: Partial<PartyRelationship>): PartyRelationship {
  return {
    id: "rel-1",
    fromPartyId: "centre",
    fromName: "خانم رضایی",
    toPartyId: "other-1",
    toName: "شرکت الف",
    kind: "contact_of",
    roleTitle: "",
    isPrimary: false,
    note: "",
    inverse: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as PartyRelationship;
}

const CENTRE = { id: "centre", name: "خانم رضایی" };

describe("relationshipGraph", () => {
  it("reads every edge from the file it is drawn on", () => {
    const graph = relationshipGraph(CENTRE, [
      link({ id: "out", toPartyId: "company", toName: "شرکت الف", kind: "contact_of" }),
      link({
        id: "in",
        fromPartyId: "person",
        fromName: "آقای رضایی",
        toPartyId: "centre",
        toName: "خانم رضایی",
        kind: "decision_maker",
        inverse: true,
      }),
    ]);

    // Outgoing: the far end is the *to* side, labelled as stored.
    expect(graph.nodes[0]).toMatchObject({
      relationshipId: "out",
      partyId: "company",
      name: "شرکت الف",
      label: "رابط",
    });
    // Incoming: on this file's end the same row says the opposite thing, and the
    // far end is the *from* side — a ring that read both ends the same way would
    // print «مخاطب» on the company's file for a person who is its contact.
    expect(graph.nodes[1].partyId).toBe("person");
    expect(graph.nodes[1].name).toBe("آقای رضایی");
    expect(graph.nodes[1].label).toBe("تصمیم‌گیرنده دارد");
  });

  it("keeps one spoke per recorded fact, even when the same person appears twice", () => {
    const graph = relationshipGraph(CENTRE, [
      link({ id: "a", kind: "contact_of" }),
      link({ id: "b", kind: "referred_by", roleTitle: "معرف" }),
    ]);
    expect(graph.total).toBe(2);
    expect(graph.nodes.map((node) => node.relationshipId)).toEqual(["a", "b"]);
    expect(graph.kinds).toEqual([
      { kind: "contact_of", label: "رابط", count: 1 },
      { kind: "referred_by", label: "معرفی‌شده توسط", count: 1 },
    ]);
  });

  it("places the ring deterministically, the primary relationships first", () => {
    const links = [
      link({ id: "primary", isPrimary: true }),
      link({ id: "second" }),
      link({ id: "third" }),
    ];
    const first = relationshipGraph(CENTRE, links);
    const again = relationshipGraph(CENTRE, links);

    // The same input renders the same picture, visit after visit: a graph that
    // rearranges itself teaches people not to trust it.
    expect(first).toEqual(again);
    // The first spoke sits at the top, and the rest follow clockwise inside the
    // declared 0–100 space — no layout engine, no clock, no randomness.
    expect(first.nodes[0].x).toBeCloseTo(GRAPH_SPACE / 2, 1);
    expect(first.nodes[0].y).toBeLessThan(GRAPH_SPACE / 2);
    for (const node of first.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(GRAPH_SPACE);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(GRAPH_SPACE);
    }
  });

  it("labels each node outwards, so two neighbours never share a line", () => {
    const graph = relationshipGraph(CENTRE, [
      link({ id: "west" }),
      link({ id: "east" }),
      link({ id: "south" }),
      link({ id: "north" }),
    ]);
    const west = graph.nodes.find((node) => node.x < 42);
    const east = graph.nodes.find((node) => node.x > 58);
    expect(west?.align).toBe("end");
    expect(east?.align).toBe("start");
  });

  it("counts the kinds for the caption, commonest first", () => {
    const graph = relationshipGraph(CENTRE, [
      link({ id: "1", kind: "contact_of" }),
      link({ id: "2", kind: "contact_of" }),
      link({ id: "3", kind: "household" }),
    ]);
    expect(graph.kinds[0]).toMatchObject({ kind: "contact_of", count: 2 });
    expect(graph.kinds[1]).toMatchObject({ kind: "household", count: 1 });
  });
});

describe("relationshipGraphCaption", () => {
  it("says the whole picture in one line — the figure's accessible name", () => {
    const graph = relationshipGraph(CENTRE, [
      link({ id: "1", kind: "contact_of" }),
      link({ id: "2", kind: "household" }),
    ]);
    const caption = relationshipGraphCaption(graph, "خانم رضایی");
    expect(caption).toContain("خانم رضایی");
    expect(caption).toContain("۲ ارتباط");
    expect(caption).toContain("رابط ۱");
  });

  it("says so plainly when there is nothing to draw", () => {
    expect(relationshipGraphCaption(relationshipGraph(CENTRE, []), "خانم رضایی")).toBe(
      "«خانم رضایی» هنوز به کسی متصل نیست.",
    );
  });
});
