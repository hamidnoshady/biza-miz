import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MASTER_SYNC_TABLES } from "./master-sync-registry";
import {
  AEC_CAPABILITY_KEYS,
  AEC_CAPABILITY_LABELS,
  AEC_DEFAULT_OPERATING_PROFILE,
  AEC_LIVE_CAPABILITIES,
  AEC_OPERATING_PROFILES,
  AEC_OPERATING_PROFILE_DEFS,
  AEC_PARTICIPANT_GROUPS,
  AEC_PARTICIPANT_GROUP_LABELS,
  AEC_PARTICIPANT_ROLES,
  AEC_PARTICIPANT_ROLE_DEFS,
  AEC_SPECIALTIES,
  AEC_SPECIALTY_LABELS,
  aecParticipantRoleAllowed,
  aecParticipantRolesFor,
  hasAecCapability,
  isAecCapability,
  isAecOperatingProfile,
  isAecParticipantRole,
  isAecSpecialty,
  normalizeAecCapabilityOverrides,
  normalizeAecSpecialties,
  resolveAecCapabilities,
  type AecCapabilityKey,
} from "./aec";

/**
 * Issue #799 Wave 2 — the database's half of the catalogue, asserted from the
 * migration text exactly as `industry-coverage.test.ts` asserts the industry
 * constraint. A profile or a specialty that exists in code but not in the
 * CHECK is a 500 the first time somebody picks it; the reverse is a value the
 * UI can never offer.
 */
describe("migration 0194 and the catalogue are one contract", () => {
  const migration = readFileSync(
    join(process.cwd(), "migrations", "0194_aec_profiles_and_participants.sql"),
    "utf8",
  );

  /** The quoted values captured by a CHECK clause's pattern. */
  function valuesIn(column: string, pattern: RegExp): string[] {
    const clause = migration.match(pattern);
    expect(clause, `no CHECK for ${column}`).not.toBeNull();
    return [...clause![1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  }

  /** `CHECK (column IN ('a', 'b', …))` — profiles and roles. */
  function inList(column: string): string[] {
    return valuesIn(column, new RegExp(`${column} IN \\(([\\s\\S]*?)\\)\\)`, "i"));
  }

  it("names every operating profile exactly once", () => {
    const values = inList("operating_profile");
    expect(new Set(values).size).toBe(values.length);
    expect([...values].sort()).toEqual([...AEC_OPERATING_PROFILES].sort());
  });

  it("names every specialty exactly once", () => {
    // Specialties are `CHECK (specialties <@ ARRAY[ … ]::text[])` — a subset
    // test, so an unknown value is rejected by the database as well as dropped
    // by the service.
    const values = valuesIn("specialties", /specialties\s*<@\s*ARRAY\[([\s\S]*?)\]::text\[\]/i);
    expect(new Set(values).size).toBe(values.length);
    expect([...values].sort()).toEqual([...AEC_SPECIALTIES].sort());
  });

  it("names every participant role exactly once", () => {
    const values = inList("role");
    expect(new Set(values).size).toBe(values.length);
    expect([...values].sort()).toEqual([...AEC_PARTICIPANT_ROLES].sort());
  });

  it("defaults the column to the profile the code defaults to", () => {
    expect(migration).toContain(`operating_profile    text NOT NULL DEFAULT '${AEC_DEFAULT_OPERATING_PROFILE}'`);
  });

  it("leaves the tables out of the continuous sync feed for now", () => {
    // §36 puts sync classification in Wave 10. Stating that here means adding
    // an AEC table to MASTER_SYNC_TABLES is a decision with a test attached,
    // not a silent side effect of a later migration.
    const captured = new Set(MASTER_SYNC_TABLES.map((config) => config.table));
    for (const table of ["aec_business_profiles", "aec_project_profiles", "aec_project_participants"]) {
      expect(captured.has(table), table).toBe(false);
    }
  });
});

describe("the AEC capability catalogue", () => {
  it("gives every capability a Persian label", () => {
    for (const key of AEC_CAPABILITY_KEYS) {
      expect(AEC_CAPABILITY_LABELS[key]?.trim().length, key).toBeGreaterThan(0);
    }
    expect(Object.keys(AEC_CAPABILITY_LABELS).sort()).toEqual([...AEC_CAPABILITY_KEYS].sort());
  });

  it("names live capabilities that are actually in the catalogue", () => {
    for (const key of AEC_LIVE_CAPABILITIES) expect(AEC_CAPABILITY_KEYS).toContain(key);
  });

  it("classifies capabilities by the predicate", () => {
    expect(isAecCapability("boq")).toBe(true);
    expect(isAecCapability("construction_management")).toBe(false);
    expect(isAecCapability("")).toBe(false);
  });
});

describe("operating profiles", () => {
  it("covers every profile the issue lists, each with words of its own", () => {
    expect([...AEC_OPERATING_PROFILES].sort()).toEqual([
      "architecture_office",
      "civil_engineering",
      "consulting_supervision",
      "contractor",
      "design_build",
      "individual",
      "multidisciplinary",
      "team",
    ]);
    const labels = AEC_OPERATING_PROFILES.map((p) => AEC_OPERATING_PROFILE_DEFS[p].label);
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("has a key field that matches its own key, and only real capabilities", () => {
    for (const profile of AEC_OPERATING_PROFILES) {
      const def = AEC_OPERATING_PROFILE_DEFS[profile];
      expect(def.key).toBe(profile);
      expect(def.capabilities.length).toBeGreaterThan(0);
      expect(new Set(def.capabilities).size).toBe(def.capabilities.length);
      for (const capability of def.capabilities) {
        expect(AEC_CAPABILITY_KEYS, `${profile}/${capability}`).toContain(capability);
      }
    }
  });

  it("resolves a profile's preset exactly as declared", () => {
    for (const profile of AEC_OPERATING_PROFILES) {
      expect(resolveAecCapabilities({ profile }).sort()).toEqual(
        [...AEC_OPERATING_PROFILE_DEFS[profile].capabilities].sort(),
      );
    }
  });

  it("gives the default profile exactly the default answer", () => {
    expect(resolveAecCapabilities({ profile: AEC_DEFAULT_OPERATING_PROFILE })).toEqual(
      [...AEC_OPERATING_PROFILE_DEFS[AEC_DEFAULT_OPERATING_PROFILE].capabilities],
    );
  });

  it("classifies profiles by the predicate", () => {
    expect(isAecOperatingProfile("design_build")).toBe(true);
    expect(isAecOperatingProfile("design-build")).toBe(false);
    expect(isAecOperatingProfile("food_service")).toBe(false);
  });
});

describe("capability presets follow the issue's operating-profile examples", () => {
  it("keeps an individual architect lean and hides contractor-heavy work", () => {
    const caps = resolveAecCapabilities({ profile: "individual" });
    // The issue's individual-architect list: projects, tasks, clients,
    // drawings/documents, calendar, invoices, financial summary, AI. Everything
    // that is not an AEC capability (calendar, invoices, the assistant) is
    // platform-wide and not restated here.
    for (const capability of ["projects", "participants", "design_phases", "document_control", "financials"] as AecCapabilityKey[]) {
      expect(caps, capability).toContain(capability);
    }
    // "Hide contractor-heavy functionality unless explicitly enabled."
    for (const capability of ["boq", "estimating", "procurement", "subcontractors", "site_operations", "progress_claims", "variations", "tendering", "material_tracking", "qa_qc"] as AecCapabilityKey[]) {
      expect(caps, capability).not.toContain(capability);
    }
  });

  it("gives an architecture office teams, revisions, phases, approvals and subconsultants", () => {
    const caps = resolveAecCapabilities({ profile: "architecture_office" });
    for (const capability of ["design_phases", "document_control", "approvals", "subconsultants"] as AecCapabilityKey[]) {
      expect(caps, capability).toContain(capability);
    }
    expect(caps).not.toContain("site_operations");
  });

  it("gives a contractor the whole commercial and site set the issue lists", () => {
    const caps = resolveAecCapabilities({ profile: "contractor" });
    for (const capability of [
      "boq", "estimating", "procurement", "site_operations", "subcontractors",
      "qa_qc", "progress_claims", "variations", "material_tracking",
    ] as AecCapabilityKey[]) {
      expect(caps, capability).toContain(capability);
    }
  });

  it("gives design & build the union of design and construction", () => {
    const designBuild = resolveAecCapabilities({ profile: "design_build" });
    const office = resolveAecCapabilities({ profile: "architecture_office" });
    const contractor = resolveAecCapabilities({ profile: "contractor" });
    expect(designBuild.sort()).toEqual([...new Set([...office, ...contractor])].sort());
    expect(designBuild).toContain("design_phases");
    expect(designBuild).toContain("site_operations");
  });

  it("gives supervision the verification set and not production", () => {
    const caps = resolveAecCapabilities({ profile: "consulting_supervision" });
    expect(caps).toContain("supervision");
    expect(caps).toContain("progress_claims");
    expect(caps).not.toContain("site_operations");
    expect(caps).not.toContain("procurement");
  });

  it("gives a multidisciplinary company every capability there is", () => {
    expect(resolveAecCapabilities({ profile: "multidisciplinary" }).length).toBe(
      AEC_CAPABILITY_KEYS.length,
    );
  });
});

describe("overrides beat the preset in both directions", () => {
  it("lets an individual switch a contractor capability on", () => {
    expect(hasAecCapability({ profile: "individual" }, "boq")).toBe(false);
    expect(
      hasAecCapability({ profile: "individual", overrides: { boq: true } }, "boq"),
    ).toBe(true);
  });

  it("lets a contractor switch one off", () => {
    expect(
      hasAecCapability({ profile: "contractor", overrides: { subcontractors: false } }, "subcontractors"),
    ).toBe(false);
    expect(hasAecCapability({ profile: "contractor" }, "subcontractors")).toBe(true);
  });

  it("ignores unknown keys and non-boolean values", () => {
    const caps = resolveAecCapabilities({
      profile: "team",
      overrides: { nonsense: true, boq: "yes" } as never,
    });
    expect(caps).toEqual(resolveAecCapabilities({ profile: "team" }));
  });

  it("returns the catalogue's order, not the override's", () => {
    const a = resolveAecCapabilities({ profile: "contractor", overrides: { design_phases: true } });
    const b = resolveAecCapabilities({ profile: "contractor", overrides: { design_phases: true } });
    expect(a).toEqual(b);
    const indexOf = (key: AecCapabilityKey) => a.indexOf(key);
    expect(indexOf("projects")).toBeLessThan(indexOf("design_phases"));
    expect(indexOf("design_phases")).toBeLessThan(indexOf("boq"));
  });

  it("normalizes overrides: drops unknown keys, noise, and anything restating the preset", () => {
    expect(
      normalizeAecCapabilityOverrides(
        {
          boq: true, // individual has no boq ⇒ a real override
          projects: true, // already in the preset ⇒ not an override
          site_operations: false, // already off ⇒ not an override
          nonsense: true,
          estimating: "yes",
        },
        "individual",
      ),
    ).toEqual({ boq: true });

    expect(normalizeAecCapabilityOverrides({ subcontractors: false }, "contractor")).toEqual({
      subcontractors: false,
    });
    expect(normalizeAecCapabilityOverrides(null, "contractor")).toEqual({});
  });

  it("round-trips a normalized override through resolution", () => {
    const profile = "individual" as const;
    const overrides = normalizeAecCapabilityOverrides({ boq: true, subcontractors: false }, profile);
    expect(resolveAecCapabilities({ profile, overrides })).toContain("boq");
    expect(resolveAecCapabilities({ profile, overrides })).not.toContain("subcontractors");
  });
});

describe("specialties", () => {
  it("covers the issue's list with a label each", () => {
    expect([...AEC_SPECIALTIES].sort()).toEqual([
      "architecture",
      "civil_engineering",
      "construction_management",
      "interior_architecture",
      "landscape",
      "mep",
      "project_management",
      "quantity_surveying",
      "site_supervision",
      "structural_engineering",
      "surveying",
    ]);
    for (const specialty of AEC_SPECIALTIES) {
      expect(AEC_SPECIALTY_LABELS[specialty]?.trim().length, specialty).toBeGreaterThan(0);
      expect(isAecSpecialty(specialty)).toBe(true);
    }
    expect(isAecSpecialty("architecture_office")).toBe(false);
  });

  it("normalizes a tag list: trims, de-duplicates, orders, and drops what it does not know", () => {
    expect(
      normalizeAecSpecialties(["mep", "architecture", "mep", " architecture ", "welding", "", 42 as never]),
    ).toEqual(["architecture", "mep"]);
    expect(normalizeAecSpecialties([])).toEqual([]);
  });
});

describe("participant roles", () => {
  it("covers every role the issue lists, grouped, with a label each", () => {
    expect(AEC_PARTICIPANT_ROLES.length).toBe(22);
    for (const role of AEC_PARTICIPANT_ROLES) {
      const def = AEC_PARTICIPANT_ROLE_DEFS[role];
      expect(def.key).toBe(role);
      expect(def.label.trim().length, role).toBeGreaterThan(0);
      expect(AEC_PARTICIPANT_GROUPS, role).toContain(def.group);
      for (const capability of def.requires ?? []) {
        expect(AEC_CAPABILITY_KEYS, `${role}/${capability}`).toContain(capability);
      }
    }
    for (const group of AEC_PARTICIPANT_GROUPS) {
      expect(AEC_PARTICIPANT_GROUP_LABELS[group]?.trim().length, group).toBeGreaterThan(0);
    }
  });

  it("offers every always-on role to every profile", () => {
    for (const profile of AEC_OPERATING_PROFILES) {
      const keys = aecParticipantRolesFor({ profile }).map((def) => def.key);
      for (const role of ["client", "employer_representative", "architect", "lead_architect", "contractor"] as const) {
        expect(keys, `${profile}/${role}`).toContain(role);
      }
    }
  });

  it("hides the site and subcontractor roles from an individual unless enabled", () => {
    const lean = aecParticipantRolesFor({ profile: "individual" }).map((def) => def.key);
    for (const role of ["foreman", "site_engineer", "subcontractor", "supplier", "quantity_surveyor", "qa_qc", "hse", "supervision_consultant"] as const) {
      expect(lean, role).not.toContain(role);
    }
    // The explicit override is what turns them on — the issue's "unless
    // explicitly enabled".
    const enabled = aecParticipantRolesFor({
      profile: "individual",
      overrides: { site_operations: true, boq: true },
    }).map((def) => def.key);
    expect(enabled).toContain("foreman");
    expect(enabled).toContain("site_engineer");
    expect(enabled).toContain("quantity_surveyor");
    expect(enabled).not.toContain("subcontractor");
  });

  it("offers a contractor's roles on a contractor profile", () => {
    const keys = aecParticipantRolesFor({ profile: "contractor" }).map((def) => def.key);
    for (const role of ["subcontractor", "supplier", "foreman", "site_engineer", "qa_qc", "quantity_surveyor"] as const) {
      expect(keys, role).toContain(role);
    }
    // And supervision-only roles stay off — a contractor does not record their
    // own client's supervisor as a *capability* of their business.
    expect(keys).not.toContain("supervision_consultant");
  });

  it("keeps the picker's order stable and grouped", () => {
    const defs = aecParticipantRolesFor({ profile: "multidisciplinary" });
    // Every role is offered to the widest profile — and only in group order,
    // which is what lets the picker render four sections without re-sorting.
    expect([...defs.map((d) => d.key)].sort()).toEqual([...AEC_PARTICIPANT_ROLES].sort());
    expect(defs.map((d) => d.key)).not.toEqual([...AEC_PARTICIPANT_ROLES]);
    const groups = defs.map((d) => d.group);
    const firstIndexOf = (group: string) => groups.indexOf(group as never);
    const lastIndexOf = (group: string) => groups.lastIndexOf(group as never);
    for (const group of AEC_PARTICIPANT_GROUPS) {
      if (firstIndexOf(group) === -1) continue;
      // Each group is contiguous: the picker renders four sections, not a
      // shuffled list.
      expect(lastIndexOf(group) - firstIndexOf(group) + 1).toBe(
        groups.filter((g) => g === group).length,
      );
    }
  });

  it("answers the API's own check, which is stricter than the picker", () => {
    expect(aecParticipantRoleAllowed({ profile: "contractor" }, "subcontractor")).toBe(true);
    expect(aecParticipantRoleAllowed({ profile: "individual" }, "subcontractor")).toBe(false);
    expect(aecParticipantRoleAllowed({ profile: "individual" }, "architect")).toBe(true);
    expect(aecParticipantRoleAllowed({ profile: "individual" }, "welder")).toBe(false);
    expect(isAecParticipantRole("foreman")).toBe(true);
    expect(isAecParticipantRole("foreman_2")).toBe(false);
  });
});
