/**
 * The data-quality vocabulary, without a database.
 *
 * The *behaviour* of the four rules is pinned against real PostgreSQL in
 * `integration/crm-data-quality.integration.test.ts`. This file pins the part a
 * failing query can never tell you about: that every rule is described, that its
 * description quotes the threshold it uses, and that its destination is a real
 * section — so a new rule cannot ship as a count with no sentence and no link.
 */
import { describe, expect, it } from "vitest";
import { CRM_SECTION_KEYS } from "./crm-permissions";
import {
  CRM_DATA_QUALITY_KINDS,
  CRM_DATA_QUALITY_PRESENTATION,
  PREVIEW_LIMIT,
  STALE_LEAD_DAYS,
} from "./crm-data-quality";

describe("CRM_DATA_QUALITY_PRESENTATION", () => {
  it("describes every rule, and only the declared rules", () => {
    expect(Object.keys(CRM_DATA_QUALITY_PRESENTATION).sort()).toEqual(
      [...CRM_DATA_QUALITY_KINDS].sort(),
    );
    for (const key of CRM_DATA_QUALITY_KINDS) {
      const entry = CRM_DATA_QUALITY_PRESENTATION[key];
      expect(entry.label.trim().length, key).toBeGreaterThan(0);
      expect(entry.why.trim().length, key).toBeGreaterThan(0);
      expect(entry.action.trim().length, key).toBeGreaterThan(0);
      // A gap with nowhere to fix it is a complaint, not an issue.
      expect(CRM_SECTION_KEYS, `${key} → ${entry.section}`).toContain(entry.section);
    }
    const labels = CRM_DATA_QUALITY_KINDS.map((key) => CRM_DATA_QUALITY_PRESENTATION[key].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("quotes the threshold the stale-lead rule actually uses", () => {
    // The same rule `crm-queues.test.ts` applies to the queue copy: a sentence
    // that states a number has to state *this* number, or the screen teaches a
    // rule the query does not follow.
    expect(CRM_DATA_QUALITY_PRESENTATION.stale_lead.why).toContain(String(STALE_LEAD_DAYS));
  });

  it("keeps the preview smaller than a real page of results", () => {
    // The preview is an example, never the list: a cap equal to what people
    // expect to scroll through would quietly become the whole screen.
    expect(PREVIEW_LIMIT).toBeGreaterThan(0);
    expect(PREVIEW_LIMIT).toBeLessThanOrEqual(10);
  });
});
