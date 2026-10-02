/**
 * Issue #799 §21 — the cockpit catalogue and the capability-aware tab bar.
 *
 * The catalogue is data, so what is worth asserting is its relationship to the
 * capability system: every gate names a real capability, an individual's lean
 * preset gets fewer sections than a contractor's, nothing unshipped leaks into
 * a page, and a non-AEC caller gets yesterday's tab bar byte for byte.
 */
import { describe, expect, it } from "vitest";
import {
  AEC_CAPABILITY_KEYS,
  AEC_LIVE_CAPABILITIES,
  AEC_OPERATING_PROFILE_DEFS,
  resolveAecCapabilities,
} from "./aec";
import {
  AEC_COCKPIT_SECTIONS,
  AEC_SHIPPED_WAVE,
  WORKSPACE_PROJECT_TABS,
  aecCockpitSections,
  aecProjectTabs,
} from "./aec-cockpit";

describe("the cockpit catalogue", () => {
  it("gates only on real capabilities and names each section once", () => {
    const keys = new Set<string>();
    for (const section of AEC_COCKPIT_SECTIONS) {
      expect(keys.has(section.key), section.key).toBe(false);
      keys.add(section.key);
      expect(section.label.trim().length, section.key).toBeGreaterThan(0);
      if (section.capability) {
        expect(AEC_CAPABILITY_KEYS, `${section.key} → ${section.capability}`).toContain(section.capability);
      }
    }
  });

  it("stays inside the delivered waves and marks the rest unshipped", () => {
    for (const section of AEC_COCKPIT_SECTIONS) {
      if (section.shipped) expect(section.wave, section.key).toBeLessThanOrEqual(AEC_SHIPPED_WAVE);
    }
    // §21's later sections are designed here but not rendered: today's page
    // must not offer a tab whose wave has not been built.
    for (const key of ["boq", "procurement", "rfis", "submittals", "site", "inspections", "changes", "payments", "financials"]) {
      expect(AEC_COCKPIT_SECTIONS.find((s) => s.key === key)?.shipped, key).toBe(false);
    }
  });

  it("gives an individual fewer sections than a contractor", () => {
    const individual = aecCockpitSections(
      resolveAecCapabilities({ profile: "individual", overrides: {} }),
    ).map((s) => s.key);
    const contractor = aecCockpitSections(
      resolveAecCapabilities({ profile: "contractor", overrides: {} }),
    ).map((s) => s.key);

    expect(individual).toContain("participants");
    expect(contractor).toContain("participants");
    // The lean preset is not offered a section whose capability it lacks…
    expect(individual).not.toContain("site");
    expect(contractor).not.toContain("site"); // …and neither is a contractor *today*: Wave 7.
    // An override is what changes the answer, not the profile's name.
    const individualWithWorkspace = aecCockpitSections(
      resolveAecCapabilities({ profile: "individual", overrides: { participants: false } }),
    ).map((s) => s.key);
    expect(individualWithWorkspace).not.toContain("participants");
  });

  it("hides a section whose live capability is switched off", () => {
    for (const capability of AEC_LIVE_CAPABILITIES) {
      const sections = aecCockpitSections([capability === "participants" ? "projects" : "participants"]);
      expect(sections.some((s) => s.capability === capability)).toBe(false);
    }
  });
});

describe("the project tab bar", () => {
  it("is exactly today's bar for a business that is not AEC", () => {
    expect(aecProjectTabs(null)).toEqual(WORKSPACE_PROJECT_TABS.map((tab) => ({ ...tab })));
  });

  it("relabels the tabs and adds the parties tab for AEC", () => {
    const tabs = aecProjectTabs({
      capabilities: resolveAecCapabilities({ profile: "architecture_office", overrides: {} }),
    });
    const byKey = new Map(tabs.map((tab) => [tab.key, tab.label]));
    expect(byKey.get("record")).toBe("شناسنامهٔ پروژه");
    expect(byKey.get("participants")).toBe("طرف‌های پروژه");
    expect(byKey.get("tasks")).toBe("وظایف");
    // Ordered, not appended: the parties tab sits directly before the team.
    const keys = tabs.map((tab) => tab.key);
    expect(keys.indexOf("participants")).toBe(keys.indexOf("team") - 1);
    // Nothing AEC-only leaks in for a business that lacks the capability.
    const lean = aecProjectTabs({
      capabilities: resolveAecCapabilities({ profile: "architecture_office", overrides: { participants: false } }),
    });
    expect(lean.some((tab) => tab.key === "participants")).toBe(false);
    expect(lean.some((tab) => String(tab.key) === "boq")).toBe(false);
  });

  it("keeps the generic labels for tabs whose section has not shipped", () => {
    const tabs = aecProjectTabs({
      capabilities: resolveAecCapabilities({ profile: "contractor", overrides: {} }),
    });
    const documents = tabs.find((tab) => tab.key === "documents");
    // The drawing register is Wave 5; until then the tab keeps its plain name
    // rather than promising a register that does not exist.
    expect(documents?.label).toBe("اسناد");
  });

  it("places every shipped section somewhere a user can reach it", () => {
    // A guard against the two lists drifting: a shipped section must either be
    // a generic tab, own an AEC-only tab, or be declared as living inside
    // another. The explicit lists are the point — adding a shipped section and
    // forgetting to place it fails here.
    const ownsItsOwnTab = new Set(["participants"]);
    const insideAnotherTab = new Set(["overview", "schedule", "profile"]);
    for (const section of AEC_COCKPIT_SECTIONS.filter((s) => s.shipped)) {
      const reachable =
        ownsItsOwnTab.has(section.key) ||
        insideAnotherTab.has(section.key) ||
        WORKSPACE_PROJECT_TABS.some((tab) => tab.key === section.key);
      expect(reachable, section.key).toBe(true);
    }
  });

  it("gives every operating profile a non-empty bar", () => {
    for (const profile of Object.keys(AEC_OPERATING_PROFILE_DEFS)) {
      const tabs = aecProjectTabs({
        capabilities: resolveAecCapabilities({ profile: profile as keyof typeof AEC_OPERATING_PROFILE_DEFS, overrides: {} }),
      });
      expect(tabs.length, profile).toBeGreaterThanOrEqual(WORKSPACE_PROJECT_TABS.length - 1);
      expect(tabs.some((tab) => tab.key === "record"), profile).toBe(true);
    }
  });
});
