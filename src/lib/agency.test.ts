import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AEC_OPERATING_PROFILES } from "./aec";
import {
  AGENCY_DEFAULT_OPERATING_PROFILE,
  AGENCY_INDUSTRY,
  AGENCY_OPERATING_PROFILES,
  AGENCY_OPERATING_PROFILE_DEFS,
  agencyOperatingProfileOptions,
  isAgencyOperatingProfile,
  parseAgencyProfileSetting,
} from "./agency";
import { ENABLED_INDUSTRIES } from "./industries";
import {
  AGENCY_BUILTIN_TEMPLATE_KEYS,
  AGENCY_BUILTIN_TEMPLATES,
  agencyTemplateRecommendedProfiles,
} from "./workspace-agency-templates";

/**
 * Issue #1128 — the eight operating profiles and the seven project blueprints.
 *
 * Two contracts are being pinned here, and they pull in opposite directions,
 * which is why both are tested rather than one:
 *
 *   * the presets are **real** — eight of them, named in the issue's own order,
 *     each one actually recommending at least one blueprint, so a choice an
 *     owner makes in settings changes something they can see;
 *   * the presets are **harmless** — a profile is a label and an ordering, and
 *     nothing in `agency.ts` can widen what a member may open. The issue's
 *     "presets … never replace role authorization" is asserted mechanically
 *     below (the module imports no permission code and a definition carries
 *     exactly three fields), because a preset that grew a capability switch
 *     would be an authorization system nobody reviewed.
 */

const PERSIAN = /[\u0600-\u06FF]/;

/** Words that belong to a shop or a café, not to an agency (§ non-goals). */
const RETAIL_WORDS = ["منو", "سفارش", "صندوق", "میز", "آشپزخانه", "کالا", "انبار", "رزرو"] as const;

describe("the eight operating profiles of one industry (#1128)", () => {
  it("are the eight the issue names, in its order", () => {
    expect([...AGENCY_OPERATING_PROFILES]).toEqual([
      "full_service",
      "digital_social",
      "branding_studio",
      "media_buying",
      "outdoor_print",
      "content_video",
      "pr_events",
      "small_agency",
    ]);
  });

  it("live inside one enabled industry key, never beside it", () => {
    expect(AGENCY_INDUSTRY).toBe("advertising_agency");
    expect(ENABLED_INDUSTRIES).toContain(AGENCY_INDUSTRY);
    // Eight shapes, one key: a preset is not a thirteenth industry, so none of
    // them may appear in the registry.
    for (const profile of AGENCY_OPERATING_PROFILES) {
      expect(ENABLED_INDUSTRIES).not.toContain(profile);
    }
  });

  it("describe every profile in Persian, with no two alike", () => {
    const labels = new Set<string>();
    for (const key of AGENCY_OPERATING_PROFILES) {
      const def = AGENCY_OPERATING_PROFILE_DEFS[key];
      expect(def.key, key).toBe(key);
      expect(def.label, key).toMatch(PERSIAN);
      expect(def.description, key).toMatch(PERSIAN);
      expect(def.description.length, key).toBeGreaterThan(20);
      expect(labels.has(def.label), def.label).toBe(false);
      labels.add(def.label);
    }
    expect(agencyOperatingProfileOptions().map((option) => option.key)).toEqual([
      ...AGENCY_OPERATING_PROFILES,
    ]);
  });

  it("default to the broadest shape", () => {
    expect(isAgencyOperatingProfile(AGENCY_DEFAULT_OPERATING_PROFILE)).toBe(true);
    expect(AGENCY_DEFAULT_OPERATING_PROFILE).toBe("full_service");
  });

  it("do not share a vocabulary with AEC's profiles", () => {
    // The two preset sets are disjoint, which is what makes a blueprint's
    // `recommendedProfiles` meaningful: «contractor» must never badge an agency
    // template, and «media_buying» must never badge an AEC one.
    for (const profile of AGENCY_OPERATING_PROFILES) {
      expect(isAgencyOperatingProfile(profile), profile).toBe(true);
      expect(AEC_OPERATING_PROFILES as readonly string[]).not.toContain(profile);
    }
    for (const aec of AEC_OPERATING_PROFILES) {
      expect(isAgencyOperatingProfile(aec), aec).toBe(false);
    }
    for (const junk of ["", "advertising_agency", "FULL_SERVICE", "agency", "full-service"]) {
      expect(isAgencyOperatingProfile(junk), junk).toBe(false);
    }
  });
});

describe("a preset is a starting point, never an authorization", () => {
  it("keeps agency.ts free of permission, role and module code", () => {
    const source = readFileSync(join(process.cwd(), "src", "lib", "agency.ts"), "utf8");
    const imports = source.match(/^import .*$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      // The only thing a preset module may know about the rest of the product
      // is which industry key it belongs to.
      expect(line, line).toContain('"./industries"');
    }
  });

  it("carries nothing but a key and its copy", () => {
    for (const key of AGENCY_OPERATING_PROFILES) {
      expect(Object.keys(AGENCY_OPERATING_PROFILE_DEFS[key]).sort(), key).toEqual([
        "description",
        "key",
        "label",
      ]);
    }
  });
});

describe("the seven agency blueprints (§B)", () => {
  const keys = new Set(AGENCY_BUILTIN_TEMPLATE_KEYS);

  it("are the seven sequences the issue lists", () => {
    expect([...keys].sort()).toEqual(
      [
        "agency_brand_identity",
        "agency_website_landing",
        "agency_social_retainer",
        "agency_ad_campaign",
        "agency_outdoor_print",
        "agency_video_production",
        "agency_pr_event",
      ].sort(),
    );
    expect(AGENCY_BUILTIN_TEMPLATES.map((t) => t.key)).toEqual([...AGENCY_BUILTIN_TEMPLATE_KEYS]);
  });

  it("belong to the agency industry alone", () => {
    for (const template of AGENCY_BUILTIN_TEMPLATES) {
      expect(template.industry, template.key).toBe("advertising_agency");
      expect(template.name, template.key).toMatch(PERSIAN);
      expect(template.description, template.key).toMatch(PERSIAN);
      expect(template.projectType, template.key).toBeTruthy();
      expect(template.phases.length, template.key).toBeGreaterThanOrEqual(9);
      expect(template.defaultTasks.length, template.key).toBeGreaterThanOrEqual(3);
    }
  });

  it("keep both control points: an internal review, then the client's approval", () => {
    // §B's stage list runs brief → … → internal review → client approval →
    // publication. The two the agency is judged on must survive in every
    // blueprint, including the retainer that repeats monthly and the shoot that
    // has a production day the others do not.
    for (const template of AGENCY_BUILTIN_TEMPLATES) {
      const phases = template.phases.map((phase) => phase.name);
      expect(phases.some((name) => name.includes("بازبینی داخلی")), template.key).toBe(true);
      expect(
        phases.some((name) => name.includes("تأیید") && name.includes("کارفرما")),
        template.key,
      ).toBe(true);
      // A phase list is a sequence, not a bag: no blank and no duplicate.
      for (const name of phases) expect(name.trim(), template.key).toBeTruthy();
      expect(new Set(phases).size, template.key).toBe(phases.length);
    }
  });

  it("speak the trade's language, not a shop's", () => {
    for (const template of AGENCY_BUILTIN_TEMPLATES) {
      const text = [
        template.name,
        template.description,
        ...template.phases.map((phase) => phase.name),
        ...template.defaultTasks,
      ].join(" ");
      for (const word of RETAIL_WORDS) {
        expect(text, `${template.key}: ${word}`).not.toContain(word);
      }
    }
  });

  it("recommend real presets, and leave no preset without a blueprint", () => {
    const recommended = agencyTemplateRecommendedProfiles();
    expect(recommended.length).toBeGreaterThan(0);
    for (const profile of recommended) {
      expect(isAgencyOperatingProfile(profile), profile).toBe(true);
    }
    // A preset that recommended nothing would reorder nothing, and the picker in
    // settings would be offering a choice with no effect.
    for (const profile of AGENCY_OPERATING_PROFILES) {
      const templates = AGENCY_BUILTIN_TEMPLATES.filter((template) =>
        template.recommendedProfiles?.includes(profile),
      );
      expect(templates.length, profile).toBeGreaterThan(0);
    }
  });
});

describe("the stored setting", () => {
  it("reads a saved choice", () => {
    expect(
      parseAgencyProfileSetting({
        operatingProfile: "media_buying",
        specialties: ["outdoor_print", "media_buying", "branding_studio"],
        updatedAt: "2026-10-26T10:00:00.000Z",
      }),
    ).toEqual({
      operatingProfile: "media_buying",
      // The primary is never also a secondary, and a repeat is stored once.
      specialties: ["outdoor_print", "branding_studio"],
      updatedAt: "2026-10-26T10:00:00.000Z",
    });
  });

  it("answers null — never a coerced default — for anything it does not recognise", () => {
    // Null is what lets a caller tell "never saved" from "saved", and it is why
    // a value written by a newer version is not silently overwritten.
    for (const raw of [
      null,
      undefined,
      "media_buying",
      [],
      {},
      { operatingProfile: "contractor" },
      { operatingProfile: "" },
      { operatingProfile: 7 },
      { operatingProfile: "media_buying", specialties: "outdoor_print" },
    ]) {
      expect(parseAgencyProfileSetting(raw), JSON.stringify(raw) ?? String(raw)).toBeNull();
    }
  });

  it("drops junk specialties and a junk timestamp but keeps the choice", () => {
    const parsed = parseAgencyProfileSetting({
      operatingProfile: "content_video",
      specialties: [null, 3, "contractor", "pr_events", "pr_events"],
      updatedAt: 12345,
    });
    expect(parsed).toEqual({
      operatingProfile: "content_video",
      specialties: ["pr_events"],
      updatedAt: null,
    });
  });

  it("caps the secondary list at the number of profiles there are", () => {
    const parsed = parseAgencyProfileSetting({
      operatingProfile: "small_agency",
      specialties: [...AGENCY_OPERATING_PROFILES],
      updatedAt: null,
    });
    expect(parsed?.specialties.length).toBeLessThanOrEqual(AGENCY_OPERATING_PROFILES.length);
    expect(parsed?.specialties).not.toContain("small_agency");
  });
});
