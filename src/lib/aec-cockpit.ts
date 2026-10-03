/**
 * Issue #799 §21 — the AEC project cockpit, as a pure catalogue.
 *
 * The issue asks for a project page whose tabs are the AEC ones, with two
 * constraints attached: *do not show every section for every operating profile*
 * (capability-aware navigation) and *avoid an overwhelming ERP UI for
 * individual professionals*. Both are answered by the same rule — a section
 * exists when the capability behind it is on — and the rule lives here rather
 * than inside a component so it can be asserted without rendering anything.
 *
 * Two lists, deliberately separate:
 *
 *   * `AEC_COCKPIT_SECTIONS` is the issue's §21 list in full, each entry
 *     carrying the capability that gates it and the wave that builds it. A
 *     later wave flips `shipped: true` (or lowers `maxWave` at the call site)
 *     and the tab appears — no second catalogue, no branching in the UI.
 *   * `aecProjectTabs` composes what a project page renders *today*: the
 *     sections the shipped waves provide, translated for the industry, over the
 *     tabs the workspace already has.
 *
 * The shipped/unshipped split is why an individual architect does not see ten
 * greyed-out «بهزودی» tabs: an unbuilt section is simply absent.
 */

import { type AecCapabilityKey } from "./aec";

export const AEC_COCKPIT_SECTION_KEYS = [
  "overview",
  "profile",
  "participants",
  "schedule",
  "tasks",
  "documents",
  "boq",
  "contracts",
  "procurement",
  "rfis",
  "submittals",
  "site",
  "inspections",
  "changes",
  "payments",
  "team",
  "approvals",
  "calendar",
  "financials",
  "assistant",
] as const;
export type AecCockpitSectionKey = (typeof AEC_COCKPIT_SECTION_KEYS)[number];

export interface AecCockpitSection {
  key: AecCockpitSectionKey;
  /** Persian label for the tab, the rail entry or the section heading. */
  label: string;
  /**
   * The capability that must be on for this section to exist for a business.
   * Omitted means every AEC business has it — the project record, its tasks and
   * its calendar are not optional parts of running a project.
   */
  capability?: AecCapabilityKey;
  /** The delivery wave that builds the section (issue §36). */
  wave: number;
  /**
   * Whether the section has a shipped surface today. Everything unshipped is
   * described here — so the phase doc and the tests can see the whole plan —
   * but is never rendered.
   */
  shipped: boolean;
}

/** The issue's §21 tab list, verbatim in its order, with the wave that builds each. */
export const AEC_COCKPIT_SECTIONS: readonly AecCockpitSection[] = [
  { key: "overview", label: "نمای کلی", wave: 3, shipped: true },
  { key: "profile", label: "شناسنامهٔ پروژه", wave: 3, shipped: true },
  { key: "participants", label: "طرف‌های پروژه", capability: "participants", wave: 3, shipped: true },
  { key: "schedule", label: "زمان‌بندی و فازها", wave: 3, shipped: true },
  { key: "tasks", label: "وظایف", wave: 3, shipped: true },
  { key: "documents", label: "نقشه‌ها و اسناد", capability: "document_control", wave: 5, shipped: true },
  { key: "boq", label: "متره و برآورد", capability: "boq", wave: 4, shipped: true },
  { key: "contracts", label: "قراردادها", wave: 3, shipped: true },
  { key: "procurement", label: "تأمین و خرید", capability: "procurement", wave: 9, shipped: false },
  // Wave 6. An RFI is a question asked of a client or a consultant, so every AEC
  // shape has the register and the section carries no capability. Submittals are
  // a *document* cycle — §11's shop drawings, samples and method statements
  // point at §9's register — so they ride `document_control`, the same switch
  // that gates the register they answer to.
  { key: "rfis", label: "استعلام‌ها (RFI)", wave: 6, shipped: true },
  {
    key: "submittals",
    label: "ارسال مدارک (Submittal)",
    capability: "document_control",
    wave: 6,
    shipped: true,
  },
  { key: "site", label: "کارگاه", capability: "site_operations", wave: 7, shipped: false },
  { key: "inspections", label: "بازرسی و کنترل کیفیت", capability: "qa_qc", wave: 7, shipped: false },
  { key: "changes", label: "تغییرات", capability: "variations", wave: 8, shipped: false },
  { key: "payments", label: "صورت‌وضعیت و پرداخت", capability: "progress_claims", wave: 8, shipped: false },
  { key: "team", label: "تیم", wave: 3, shipped: true },
  { key: "approvals", label: "تأییدها", capability: "approvals", wave: 3, shipped: true },
  { key: "calendar", label: "تقویم", wave: 3, shipped: true },
  { key: "financials", label: "مالی پروژه", capability: "financials", wave: 8, shipped: false },
  { key: "assistant", label: "دستیار", wave: 3, shipped: true },
];

/** The highest wave this build implements — the boundary between designed and built. */
export const AEC_SHIPPED_WAVE = 6;

/**
 * The cockpit sections a business sees: shipped, and allowed by its capability
 * set. Order is the issue's order, which is also the order a project manager
 * reads them in (what is this → who is on it → what happens when).
 */
export function aecCockpitSections(
  capabilities: readonly AecCapabilityKey[],
  options: { maxWave?: number } = {},
): AecCockpitSection[] {
  const maxWave = options.maxWave ?? AEC_SHIPPED_WAVE;
  const on = new Set(capabilities);
  return AEC_COCKPIT_SECTIONS.filter(
    (section) =>
      section.shipped &&
      section.wave <= maxWave &&
      (!section.capability || on.has(section.capability)),
  );
}

/* ---------------------------------------------------------------------------
 * The project page's tab bar
 * ------------------------------------------------------------------------- */

/** The tabs the workspace project page has today, for every industry. */
export const WORKSPACE_PROJECT_TABS = [
  { key: "record", label: "پرونده" },
  { key: "tasks", label: "وظایف" },
  { key: "documents", label: "اسناد" },
  { key: "contracts", label: "قراردادها" },
  { key: "team", label: "تیم" },
  { key: "approvals", label: "تأییدها" },
  { key: "calendar", label: "تقویم" },
  { key: "assistant", label: "دستیار" },
] as const;

export type WorkspaceProjectTabKey = (typeof WORKSPACE_PROJECT_TABS)[number]["key"];

export interface ProjectTab {
  key: WorkspaceProjectTabKey | AecCockpitSectionKey;
  label: string;
}

/**
 * How a cockpit section maps onto a tab the page already has. `null` means the
 * section has no surface of its own yet (its content lives inside another tab,
 * or a later wave brings it) — so a shipped section never has to invent a tab
 * to be declared.
 */
const TAB_FOR_SECTION: Partial<Record<AecCockpitSectionKey, WorkspaceProjectTabKey | null>> = {
  overview: null, // the page IS the project; its summary sits at the top of «پرونده»
  schedule: null, // phases are edited inside «پرونده»
  profile: "record",
  participants: null, // its own tab, before «تیم» — see aecProjectTabs
  boq: null, // its own tab, between the documents and the contracts
  rfis: null, // its own tab, with the submittals — see aecProjectTabs
  submittals: null,
  tasks: "tasks",
  documents: "documents",
  contracts: "contracts",
  approvals: "approvals",
  calendar: "calendar",
  assistant: "assistant",
};

/**
 * The AEC tab bar: the labels the tabs take on for this industry, plus the AEC
 * tabs that do not exist for anyone else.
 *
 * The set is derived, not restated — a section this business lacks collapses
 * its tab back to the generic label, and a tab that only AEC has (`participants`
 * — nothing else in the product has external project parties) appears only when
 * its capability is on. A non-AEC caller passes `null` and gets exactly today's
 * tab bar, which is what keeps this change invisible to every other industry.
 */
export function aecProjectTabs(
  aec: { capabilities: readonly AecCapabilityKey[] } | null,
): ProjectTab[] {
  if (!aec) return WORKSPACE_PROJECT_TABS.map((tab) => ({ ...tab }));

  const sections = aecCockpitSections(aec.capabilities);
  const labelFor = new Map<WorkspaceProjectTabKey, string>();
  for (const section of sections) {
    const tab = TAB_FOR_SECTION[section.key];
    if (tab) labelFor.set(tab, section.label);
  }
  // The two shipped sections with no counterpart in the generic tab bar: this
  // industry alone has external project parties and priced work. Both are
  // capability-gated above, so an office that does not estimate never grows the
  // second one.
  const participantsSection = sections.find((section) => section.key === "participants");
  const boqSection = sections.find((section) => section.key === "boq");
  const rfisSection = sections.find((section) => section.key === "rfis");
  const submittalsSection = sections.find((section) => section.key === "submittals");

  const tabs: ProjectTab[] = [];
  for (const tab of WORKSPACE_PROJECT_TABS) {
    // The project's parties belong immediately before its team — they are the
    // same question ("who is on this?") asked of the outside world.
    if (tab.key === "team" && participantsSection) {
      tabs.push({ key: "participants", label: participantsSection.label });
    }
    // The two registers of §10 and §11 sit between the contracts and the team:
    // what is being built, what it costs and who is bound come first, then what
    // is still being asked and what is still being submitted — which is also
    // the order the project manager works through their morning in.
    if (tab.key === "team" && rfisSection) {
      tabs.push({ key: "rfis", label: rfisSection.label });
    }
    if (tab.key === "team" && submittalsSection) {
      tabs.push({ key: "submittals", label: submittalsSection.label });
    }
    // And the priced work sits where §21 puts it: after the documents, before
    // the contracts — what is being built, what it costs, then who is bound.
    if (tab.key === "contracts" && boqSection) {
      tabs.push({ key: "boq", label: boqSection.label });
    }
    tabs.push({ key: tab.key, label: labelFor.get(tab.key) ?? tab.label });
  }
  return tabs;
}
