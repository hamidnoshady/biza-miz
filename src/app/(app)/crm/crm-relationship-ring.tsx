"use client";

/**
 * The ring on a customer's file: this party in the middle, its relationships
 * around it.
 *
 * ## What it is, and what it deliberately is not
 *
 * It draws `relationshipsFor` — the same rows the list under it shows — so the
 * picture and the list can never disagree: there is one read, one shape
 * (`crm-relationship-graph.ts`) and one renderer. That also means the ring is
 * *optional* decoration over authoritative content, which is why the list stays
 * and why the figure is labelled with the whole picture in words: a person who
 * cannot see it gets the same information, and a person who can still reads the
 * exact names below.
 *
 * Not a force-directed graph, not zoomable, not pannable, and not a picture of
 * the whole business's network. A shop's CRM wants "who is connected to this
 * person", answered at a glance and reproducibly; a canvas that animates its
 * own layout would be slower to read than the list it sits above.
 *
 * ## One visual vocabulary
 *
 * Ink on the theme's own tokens: `currentColor` everywhere, the primary colour
 * for the edges that are marked primary, the muted colour for the rest, and the
 * foreground for the centre. No hex codes, no chart library, no second legend —
 * the labels come from `RELATIONSHIP_LABELS`, the same map the list uses.
 */

import { useMemo } from "react";
import type { PartyRelationship } from "@/lib/crm-shared";
import {
  GRAPH_SPACE,
  relationshipGraph,
  relationshipGraphCaption,
} from "@/lib/crm-relationship-graph";

const CENTRE = GRAPH_SPACE / 2;

/** A name that fits inside a node without covering its neighbours. */
function shortName(name: string, max = 16): string {
  const trimmed = name.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function anchorFor(align: "start" | "centre" | "end"): "start" | "middle" | "end" {
  if (align === "end") return "end";
  if (align === "start") return "start";
  return "middle";
}

export function CrmRelationshipRing({
  centre,
  links,
}: {
  centre: { id: string; name: string };
  links: readonly PartyRelationship[];
}) {
  const graph = useMemo(() => relationshipGraph(centre, links), [centre, links]);
  if (graph.total === 0) return null;

  const caption = relationshipGraphCaption(graph, centre.name);

  return (
    <figure className="grid gap-2">
      <div className="mx-auto w-full max-w-80 text-muted-foreground">
        <svg
          viewBox={`0 0 ${GRAPH_SPACE} ${GRAPH_SPACE}`}
          className="h-auto w-full"
          role="img"
          aria-label={caption}
        >
          {/* The spokes: one line per recorded relationship, drawn from the
              centre outwards so the eye reads "this person — and these". */}
          <g stroke="currentColor" strokeWidth="0.35" className="text-border" aria-hidden="true">
            {graph.nodes.map((node) => (
              <line
                key={node.relationshipId}
                x1={CENTRE}
                y1={CENTRE}
                x2={node.x}
                y2={node.y}
              />
            ))}
          </g>

          <g className="text-foreground" aria-hidden="true">
            <circle cx={CENTRE} cy={CENTRE} r="14" fill="currentColor" opacity="0.06" />
            <circle
              cx={CENTRE}
              cy={CENTRE}
              r="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="0.5"
            />
            <text
              x={CENTRE}
              y={CENTRE}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize="3.6"
              className="fill-current font-medium"
            >
              {shortName(centre.name)}
            </text>
          </g>

          {graph.nodes.map((node) => {
            const anchor = anchorFor(node.align);
            const offset = node.align === "end" ? -3.6 : node.align === "start" ? 3.6 : 0;
            const label = node.roleTitle ? `${node.name} — ${node.roleTitle}` : node.name;
            return (
              <g key={node.relationshipId}>
                <title>{`${label} (${node.label})`}</title>
                {/* The name sits *outside* the ring, growing away from the
                    centre, so two neighbours never share a line. */}
                <text
                  x={node.x + offset}
                  y={node.y}
                  textAnchor={anchor}
                  dominantBaseline="middle"
                  fontSize="3.2"
                  className="fill-current"
                >
                  {shortName(node.name, 12)}
                </text>
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={node.isPrimary ? 1.9 : 1.5}
                  fill="currentColor"
                  className={node.isPrimary ? "text-primary" : "text-muted-foreground"}
                />
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="text-center text-xs text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}
