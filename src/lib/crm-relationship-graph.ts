/**
 * The shape of one customer's network — the whole of it, without a physics
 * engine.
 *
 * ## Why this is a pure module and not part of the screen
 *
 * A graph is a picture of data that already exists, and the only decisions in
 * it are geometric: where a node sits, which way its label reads, how the kinds
 * are counted. Those are worth testing without a DOM, a viewport or a layout
 * engine, so they live here — no `db`, no `next/*`, no JSX — and the component
 * that draws them is left with nothing to get wrong.
 *
 * ## Ego network, not a hairball
 *
 * `crm_party_relationships` is directed, and the question a person asks while
 * looking at a file is always "who is connected to *this* person" — which is
 * exactly what `relationshipsFor` answers. Drawing the whole business's graph
 * would need a force layout, a viewport, and a reason to exist that a shop's
 * CRM does not have; drawing one party's neighbours is a picture of a list the
 * screen already shows, and the list stays the authoritative copy.
 *
 * ## Determinism
 *
 * Positions are a function of the input order (`isPrimary` first, newest first,
 * as the service returns them), so the same file looks the same on every visit
 * — a graph that rearranges itself teaches people not to use it. Nothing here
 * reads a clock, a random number or the container's size: the layout is in a
 * fixed 0–100 space and the renderer scales it.
 */

import { toPersianDigits } from "./digits";
import {
  RELATIONSHIP_INVERSE_LABELS,
  RELATIONSHIP_LABELS,
  type PartyRelationship,
  type RelationshipKind,
} from "./crm-shared";

/** The layout's coordinate space. The renderer maps it onto its own box. */
export const GRAPH_SPACE = 100;

/** How far from the centre the ring of neighbours sits, in that space. */
export const GRAPH_RADIUS = 36;

export interface CrmRelationshipGraphNode {
  /** The row this spoke came from — two edges to one person are two spokes. */
  relationshipId: string;
  /** The party at the far end, as seen from this file. */
  partyId: string;
  name: string;
  kind: RelationshipKind;
  /** The relation read from *this* file's end — never the stored direction. */
  label: string;
  roleTitle: string;
  isPrimary: boolean;
  /** Position in the 0–100 space, ready for `left`/`top` percentages. */
  x: number;
  y: number;
  /**
   * Which way the label grows, decided from the node's own side of the ring so
   * two neighbouring labels never run into each other or over the centre.
   */
  align: "start" | "centre" | "end";
}

export interface CrmRelationshipKindCount {
  kind: RelationshipKind;
  label: string;
  count: number;
}

export interface CrmRelationshipGraph {
  total: number;
  nodes: CrmRelationshipGraphNode[];
  /** Kinds by name, most common first — the legend, and the caption's numbers. */
  kinds: CrmRelationshipKindCount[];
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Lay one party's relationships out as a ring.
 *
 * Every edge becomes one spoke, even when the same person appears twice with
 * different roles: «مریم» as a contact *and* as the person who referred them is
 * two facts, and collapsing the spokes would silently drop one of them. The
 * first spoke sits at the top and the rest follow clockwise, which puts the
 * primary relationships (`isPrimary` first in the input) nearest the top where
 * the eye lands first.
 */
export function relationshipGraph(
  centre: { id: string; name: string },
  links: readonly PartyRelationship[],
): CrmRelationshipGraph {
  const nodes: CrmRelationshipGraphNode[] = [];
  const counts = new Map<RelationshipKind, number>();

  links.forEach((link, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(links.length, 1);
    const x = round(GRAPH_SPACE / 2 + GRAPH_RADIUS * Math.cos(angle));
    const y = round(GRAPH_SPACE / 2 + GRAPH_RADIUS * Math.sin(angle));
    nodes.push({
      relationshipId: link.id,
      partyId: link.inverse ? link.fromPartyId : link.toPartyId,
      name: link.inverse ? link.fromName : link.toName,
      kind: link.kind,
      label: link.inverse ? RELATIONSHIP_INVERSE_LABELS[link.kind] : RELATIONSHIP_LABELS[link.kind],
      roleTitle: link.roleTitle ?? "",
      isPrimary: Boolean(link.isPrimary),
      x,
      y,
      align: x < 42 ? "end" : x > 58 ? "start" : "centre",
    });
    counts.set(link.kind, (counts.get(link.kind) ?? 0) + 1);
  });

  const kinds = [...counts.entries()]
    .map(([kind, count]) => ({ kind, label: RELATIONSHIP_LABELS[kind], count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "fa"));

  return { total: nodes.length, nodes, kinds };
}

/**
 * One Persian line naming what the picture holds — the caption, and the text
 * alternative for anybody who cannot see the ring.
 */
export function relationshipGraphCaption(graph: CrmRelationshipGraph, centreName: string): string {
  if (graph.total === 0) return `«${centreName}» هنوز به کسی متصل نیست.`;
  const parts = graph.kinds.map((entry) => `${entry.label} ${toPersianDigits(entry.count)}`);
  return `شبکهٔ «${centreName}»: ${toPersianDigits(graph.total)} ارتباط — ${parts.join("، ")}.`;
}
