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
    // must not offer a tab whose wave has not been built. `boq` left this list
    // in Wave 4 (the estimating domain), `documents` in Wave 5 (the drawing
    // register) and `rfis`/`submittals` in Wave 6 (the two registers of §10 and
    // §11), each when the service behind it arrived.
    for (const key of ["procurement", "site", "inspections", "changes", "payments", "financials"]) {
      expect(AEC_COCKPIT_SECTIONS.find((s) => s.key === key)?.shipped, key).toBe(false);
    }
    for (const key of ["boq", "documents", "rfis", "submittals"]) {
      expect(AEC_COCKPIT_SECTIONS.find((s) => s.key === key)?.shipped, key).toBe(true);
    }
    expect(AEC_SHIPPED_WAVE).toBe(6);
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
    const all = resolveAecCapabilities({ profile: "multidisciplinary", overrides: {} });
    for (const capability of AEC_LIVE_CAPABILITIES) {
      const without = all.filter((key) => key !== capability);
      expect(without.length).toBeLessThan(all.length); // the capability is really in the preset
      expect(aecCockpitSections(without).some((s) => s.capability === capability)).toBe(false);
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
    // Ordered, not appended: the parties tab sits before the team (Wave 6's two
    // registers come between them, so it is *before*, not adjacent).
    const keys = tabs.map((tab) => tab.key);
    expect(keys.indexOf("participants")).toBeLessThan(keys.indexOf("team"));
    // Nothing AEC-only leaks in for a business that lacks the capability.
    const lean = aecProjectTabs({
      capabilities: resolveAecCapabilities({ profile: "architecture_office", overrides: { participants: false } }),
    });
    expect(lean.some((tab) => tab.key === "participants")).toBe(false);
    expect(lean.some((tab) => String(tab.key) === "boq")).toBe(false);
  });

  it("gives the estimating tab to the profiles that price work, in §21's place", () => {
    const contractor = aecProjectTabs({
      capabilities: resolveAecCapabilities({ profile: "contractor", overrides: {} }),
    });
    const keys = contractor.map((tab) => tab.key);
    expect(keys).toContain("boq");
    // §21's order: what is being built, what it costs, then who is bound.
    expect(keys.indexOf("boq")).toBe(keys.indexOf("documents") + 1);
    expect(keys.indexOf("boq")).toBe(keys.indexOf("contracts") - 1);

    // A design office does not estimate by preset, so it never grows the tab —
    // but switching the capability on is all it takes.
    const design = aecProjectTabs({
      capabilities: resolveAecCapabilities({ profile: "architecture_office", overrides: {} }),
    });
    expect(design.map((tab) => tab.key)).not.toContain("boq");
    const designWithEstimating = aecProjectTabs({
      capabilities: resolveAecCapabilities({ profile: "architecture_office", overrides: { boq: true } }),
    });
    expect(designWithEstimating.map((tab) => tab.key)).toContain("boq");
  });

  it("adds the RFI and submittal registers between the contracts and the team", () => {
    const contractor = aecProjectTabs({
      capabilities: resolveAecCapabilities({ profile: "contractor", overrides: {} }),
    });
    const keys = contractor.map((tab) => tab.key);
    expect(keys).toContain("rfis");
    expect(keys).toContain("submittals");
    // §10 and §11 sit after what is bound (the contracts) and before who is on
    // it (the team) — the order a project manager reads their morning in.
    expect(keys.indexOf("rfis")).toBeGreaterThan(keys.indexOf("contracts"));
    expect(keys.indexOf("submittals")).toBe(keys.indexOf("rfis") + 1);
    expect(keys.indexOf("submittals")).toBe(keys.indexOf("team") - 1);
    expect(contractor.find((tab) => tab.key === "rfis")?.label).toBe("استعلام‌ها (RFI)");

    // Submittals ride `document_control` (they are a document cycle pointing at
    // §9's register), so switching it off removes *that* tab and only it.
    const withoutDocuments = aecProjectTabs({ capabilities: ["projects", "participants"] });
    expect(withoutDocuments.some((tab) => String(tab.key) === "submittals")).toBe(false);
    // An RFI is a question asked of a client, so every AEC shape keeps it.
    expect(withoutDocuments.some((tab) => String(tab.key) === "rfis")).toBe(true);
  });

  it("names the documents tab after the register the business actually has", () => {
    const contractor = aecProjectTabs({
      capabilities: resolveAecCapabilities({ profile: "contractor", overrides: {} }),
    });
    // Wave 5: with document control on, §21's "Drawings & Documents" is what
    // this tab is, and it says so.
    expect(contractor.find((tab) => tab.key === "documents")?.label).toBe("نقشه‌ها و اسناد");

    // Off, and the tab keeps the plain name the rest of the product uses rather
    // than promising a register that is not there.
    const plain = aecProjectTabs({ capabilities: ["projects"] });
    expect(plain.find((tab) => tab.key === "documents")?.label).toBe("اسناد");
  });

  it("places every shipped section somewhere a user can reach it", () => {
    // A guard against the two lists drifting: a shipped section must either be
    // a generic tab, own an AEC-only tab, or be declared as living inside
    // another. The explicit lists are the point — adding a shipped section and
    // forgetting to place it fails here.
    const ownsItsOwnTab = new Set(["participants", "boq", "rfis", "submittals"]);
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
