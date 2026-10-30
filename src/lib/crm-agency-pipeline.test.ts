import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENABLED_INDUSTRIES } from "./industries";
import {
  AGENCY_PIPELINE_NAME,
  AGENCY_PIPELINE_STAGES,
  agencyPipelinePreset,
  agencyPresetIsSavable,
  isAgencyPipelineName,
} from "./crm-agency-pipeline";

/**
 * §A's sales-pipeline preset (issue #1128).
 *
 * The point of these tests is not that the list has seven entries — it is that
 * the preset can be handed to the platform's own `savePipelineStages` and cannot
 * be refused, and that it stays an addition beside the universal default rather
 * than a fork of it. Both of those are properties a future edit could break
 * without any type error.
 */
describe("the agency sales pipeline preset (issue #1128 §A)", () => {
  it("satisfies both invariants savePipelineStages enforces", () => {
    // A pipeline must keep at least one `open` stage — without one no deal can be
    // created — and at least one `won` stage, without which a deal can never be
    // closed successfully and the win rate is structurally zero. A preset that
    // failed either would be rejected by the very function that writes it.
    expect(agencyPresetIsSavable()).toBe(true);
    expect(AGENCY_PIPELINE_STAGES.some((stage) => stage.outcome === "open")).toBe(true);
    expect(AGENCY_PIPELINE_STAGES.some((stage) => stage.outcome === "won")).toBe(true);
  });

  it("has exactly one won and one lost stage", () => {
    // Two `won` stages would let one report's win rate disagree with another's,
    // which is the silent divergence the seed-stages warning is about.
    expect(AGENCY_PIPELINE_STAGES.filter((stage) => stage.outcome === "won")).toHaveLength(1);
    expect(AGENCY_PIPELINE_STAGES.filter((stage) => stage.outcome === "lost")).toHaveLength(1);
  });

  it("orders stages contiguously from one", () => {
    AGENCY_PIPELINE_STAGES.forEach((stage, index) => {
      expect(stage.displayOrder, stage.name).toBe(index + 1);
    });
  });

  it("names every stage uniquely, within the column's own limit", () => {
    // `(pipeline_id, name)` is unique, and `createPipeline` caps a name at 120.
    const names = AGENCY_PIPELINE_STAGES.map((stage) => stage.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.trim().length, name).toBeGreaterThan(0);
      expect(name.length, name).toBeLessThanOrEqual(120);
    }
  });

  it("keeps every requirement note within the 300 characters the column allows", () => {
    for (const stage of AGENCY_PIPELINE_STAGES) {
      expect(stage.requirementNote.length, stage.name).toBeLessThanOrEqual(300);
    }
  });

  it("keeps probabilities in range and rising to won", () => {
    // A forecast multiplies value by probability, so a preset whose probabilities
    // fell as a deal advanced would produce a number that rewards stalling.
    let previous = -1;
    for (const stage of AGENCY_PIPELINE_STAGES) {
      expect(stage.defaultProbability, stage.name).toBeGreaterThanOrEqual(0);
      expect(stage.defaultProbability, stage.name).toBeLessThanOrEqual(100);
      if (stage.outcome === "open") {
        expect(stage.defaultProbability, stage.name).toBeGreaterThan(previous);
        previous = stage.defaultProbability;
      }
    }
    const won = AGENCY_PIPELINE_STAGES.find((stage) => stage.outcome === "won");
    const lost = AGENCY_PIPELINE_STAGES.find((stage) => stage.outcome === "lost");
    expect(won?.defaultProbability).toBe(100);
    expect(lost?.defaultProbability).toBe(0);
  });

  it("carries no legacy key, because it is not a pre-0157 stage list", () => {
    // `SaveStageInput` has no `legacyKey` field and `legacyStageKey` exists to
    // recognise the six strings the old CHECK allowed. Reusing them here would
    // make reports keyed on the legacy vocabulary count agency stages as though
    // they were the seeded ones.
    for (const stage of AGENCY_PIPELINE_STAGES) {
      expect(Object.keys(stage)).not.toContain("legacyKey");
      expect(Object.keys(stage)).not.toContain("legacy_key");
    }
  });

  it("covers §A's own list: intake, qualification, brief, proposal, scope and contract", () => {
    const notes = AGENCY_PIPELINE_STAGES.map((stage) => `${stage.name} ${stage.requirementNote}`).join(" ");
    for (const word of ["سرنخ", "واجد شرایط", "بریف", "پیشنهاد", "قرارداد", "دامنهٔ کار"]) {
      expect(notes, word).toContain(word);
    }
  });

  it("offers the preset to the agency and to no other trade", () => {
    const preset = agencyPipelinePreset("advertising_agency");
    expect(preset).not.toBeNull();
    expect(preset?.name).toBe(AGENCY_PIPELINE_NAME);
    expect(preset?.stages).toEqual(AGENCY_PIPELINE_STAGES);

    for (const industry of ENABLED_INDUSTRIES) {
      if (industry === "advertising_agency") continue;
      expect(agencyPipelinePreset(industry), industry).toBeNull();
    }
  });

  it("recognises its own pipeline by name, which is what makes creating it idempotent", () => {
    // `(business_id, name)` is unique in crm_pipelines, so a read path that
    // creates the preset must be able to recognise what it already made.
    expect(isAgencyPipelineName(AGENCY_PIPELINE_NAME)).toBe(true);
    expect(isAgencyPipelineName(`  ${AGENCY_PIPELINE_NAME}  `)).toBe(true);
    expect(isAgencyPipelineName("قیف فروش پیش‌فرض")).toBe(false);
    expect(isAgencyPipelineName(null)).toBe(false);
    expect(isAgencyPipelineName(42)).toBe(false);
  });

  it("is not the default pipeline, and does not claim to be", () => {
    // The universal default keeps its own name; the agency's track sits beside
    // it so a report over the default means the same thing for every tenant.
    expect(AGENCY_PIPELINE_NAME).not.toBe("قیف فروش پیش‌فرض");
  });

  it("writes Persian copy", () => {
    for (const stage of AGENCY_PIPELINE_STAGES) {
      expect(stage.name, stage.name).not.toMatch(/[A-Za-z]/);
    }
    expect(AGENCY_PIPELINE_NAME).not.toMatch(/[A-Za-z]/);
  });

  it("imports nothing but a type, so either side of the client boundary can use it", () => {
    // The same guard §E's pure module carries: a module that decides what an
    // agency's pipeline looks like must not be able to reach a database.
    const source = readFileSync(join(__dirname, "crm-agency-pipeline.ts"), "utf8");
    const imports = [...source.matchAll(/^import .*$/gm)].map((match) => match[0]);
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line, line).toMatch(/^import type /);
    }
    expect(source).not.toMatch(/from ["']pg["']/);
    expect(source).not.toMatch(/from ["']\.\/db["']/);
  });
});
