// @vitest-environment jsdom

/**
 * The ring renderer.
 *
 * The geometry is pinned in `crm-relationship-graph.test.ts`; what this file
 * pins is what the *picture* promises a person:
 *
 *  1. It is labelled in words. The figure's accessible name is the caption —
 *     the count and the kinds — so the ring is never the only copy of a fact.
 *  2. The names and the labels are on screen, in the same vocabulary as the
 *     list below it.
 *  3. Nothing is drawn for a party with no relationships: an empty ring would
 *     be a second, worse empty state next to the list's own sentence.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PartyRelationship } from "@/lib/crm-shared";
import { CrmRelationshipRing } from "./crm-relationship-ring";

afterEach(cleanup);

function link(over: Partial<PartyRelationship>): PartyRelationship {
  return {
    id: "rel-1",
    fromPartyId: "centre",
    fromName: "خانم رضایی",
    toPartyId: "company",
    toName: "شرکت الف",
    kind: "contact_of",
    roleTitle: "",
    isPrimary: true,
    note: "",
    inverse: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as PartyRelationship;
}

describe("CrmRelationshipRing", () => {
  it("names the whole picture for anybody who cannot see it", () => {
    render(
      <CrmRelationshipRing
        centre={{ id: "centre", name: "خانم رضایی" }}
        links={[link({ id: "a" }), link({ id: "b", kind: "referred_by", toName: "آقای رضایی" })]}
      />,
    );

    const figure = screen.getByRole("img");
    const caption = figure.getAttribute("aria-label") ?? "";
    expect(caption).toContain("خانم رضایی");
    expect(caption).toContain("۲ ارتباط");
    expect(caption).toContain("رابط ۱");
    expect(caption).toContain("معرفی‌شده توسط ۱");
    // The caption is also visible text, not an attribute nobody reads.
    screen.getByText(caption);
  });

  it("draws the centre and every neighbour by name", () => {
    render(
      <CrmRelationshipRing
        centre={{ id: "centre", name: "خانم رضایی" }}
        links={[link({ id: "a" }), link({ id: "b", toName: "آقای رضایی" })]}
      />,
    );
    // The centre plus two neighbours: the same names the list under the ring
    // shows, from the same rows.
    screen.getByText("خانم رضایی");
    screen.getByText("شرکت الف");
    screen.getByText("آقای رضایی");
  });

  it("stays out of the way when there is nothing to draw", () => {
    const { container } = render(
      <CrmRelationshipRing centre={{ id: "centre", name: "خانم رضایی" }} links={[]} />,
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
