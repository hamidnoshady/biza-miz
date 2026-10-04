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
  // Wave 7. §13's daily log and site diary ride `site_operations` — a business
  // that does not run a site has no day to report. §14's issue register
  // (inspections, NCRs, corrective actions, snags, HSE, handover) rides
  // `qa_qc`, and two of its *kinds* have their own switch inside the register:
  // a snag needs `snagging` and an HSE observation needs `hse`, both of which
  // the API enforces rather than merely hiding a button.
  { key: "site", label: "کارگاه و گزارش روزانه", capability: "site_operations", wave: 7, shipped: true },
  { key: "inspections", label: "بازرسی و کنترل کیفیت", capability: "qa_qc", wave: 7, shipped: true },
  { key: "changes", label: "تغییرات", capability: "variations", wave: 8, shipped: false },
  { key: "payments", label: "صورت‌وضعیت و پرداخت", capability: "progress_claims", wave: 8, shipped: false },
  { key: "team", label: "تیم", wave: 3, shipped: true },
  { key: "approvals", label: "تأییدها", capability: "approvals", wave: 3, shipped: true },
  { key: "calendar", label: "تقویم", wave: 3, shipped: true },
  { key: "financials", label: "مالی پروژه", capability: "financials", wave: 8, shipped: false },
  { key: "assistant", label: "دستیار", wave: 3, shipped: true },
];

/** The highest wave this build implements — the boundary between designed and built. */
export const AEC_SHIPPED_WAVE = 7;

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

/**
 * The tabs the workspace project page has today, for every industry — #761's
 * Project Cockpit: seven tabs organised around how a project is run, not one
 * tab per table.
 *
 * This list is the *generic* bar. `aecProjectTabs` composes the AEC one from
 * it, so the two can never disagree about what a tab is called.
 */
export const WORKSPACE_PROJECT_TABS = [
  { key: "overview", label: "نمای کلی" },
  { key: "work", label: "کار" },
  { key: "files", label: "اسناد" },
  { key: "finance", label: "مالی" },
  { key: "team", label: "تیم" },
  { key: "activity", label: "رویدادها" },
  { key: "assistant", label: "دستیار" },
] as const;

export type WorkspaceProjectTabKey = (typeof WORKSPACE_PROJECT_TABS)[number]["key"];

export interface ProjectTab {
  key: WorkspaceProjectTabKey | AecCockpitSectionKey;
  label: string;
}

/**
 * How a cockpit section maps onto a tab the generic bar already has. `null`
 * means the section renders *inside* another tab rather than owning one — the
 * page's own summary, §21's project identity card, the phases, the contracts
 * register (which shares «مالی» with the budget card), the approval queue
 * (which shares «رویدادها» with the activity feed) and #761's calendar (which
 * was merged into «کار»). A shipped section never has to invent a tab to be
 * declared, and a later wave changes one line here rather than the bar.
 *
 * Exported because the coverage test in `aec-cockpit.test.ts` asserts every
 * shipped section is placed — either by owning a tab or by naming the tab it
 * lives in — and a private map would make that assertion a restatement.
 */
export const TAB_FOR_SECTION: Record<AecCockpitSectionKey, WorkspaceProjectTabKey | null> = {
  overview: null, // the page IS the project; its summary is the KPI row above the bar
  profile: null, // the identity card sits at the top of «نمای کلی»
  schedule: null, // phases are edited inside «نمای کلی»
  participants: null, // its own tab, immediately before «تیم» — see aecProjectTabs
  boq: null, // its own tab, between «اسناد» and «مالی»
  rfis: null, // its own tab, before «تیم», with the submittals
  submittals: null,
  site: null, // its own tab, after the submittals — see aecProjectTabs
  inspections: null,
  tasks: "work",
  documents: "files",
  contracts: null, // the register renders inside «مالی», above the budget card
  approvals: null, // the queue renders inside «رویدادها», above the feed
  calendar: null, // #761 merged the calendar into «کار»
  team: "team",
  assistant: "assistant",
  procurement: null, // unshipped (Wave 9); the wave that ships it places it
  changes: null, // unshipped (Wave 8)
  payments: null, // unshipped (Wave 8)
  financials: null, // unshipped (Wave 8)
};

/**
 * The one generic tab an AEC section renames: «اسناد» becomes §9's «نقشه‌ها و
 * اسناد» when the business has the drawing register, because that is what the
 * tab then contains.
 *
 * Every other generic tab keeps #761's name. A section that renders *inside* a
 * tab does not get to rename it («کار» holds the tasks and the calendar,
 * «مالی» the budget card and the contracts, «رویدادها» the queue and the feed),
 * and renaming a tab to match one of the things inside it would promise a
 * screen the tab is not.
 */
const TAB_RENAMED_BY: Partial<Record<WorkspaceProjectTabKey, AecCockpitSectionKey>> = {
  files: "documents",
};

/**
 * The AEC tab bar: the tabs the page already has, with the sections this
 * business's capabilities add, placed where §21 puts them.
 *
 * An AEC-only tab (parties, the BOQ, §10–§14's registers) appears only when its
 * capability is on: an individual architect never gets ten greyed-out tabs, and
 * a business that does not estimate never grows a «متره و برآورد».
 *
 * A non-AEC caller passes `null` and gets exactly today's bar, which is what
 * keeps this file invisible to the other nine industries.
 */
export function aecProjectTabs(
  aec: { capabilities: readonly AecCapabilityKey[] } | null,
): ProjectTab[] {
  if (!aec) return WORKSPACE_PROJECT_TABS.map((tab) => ({ ...tab }));

  const sections = aecCockpitSections(aec.capabilities);
  const labelOf = new Map(sections.map((section) => [section.key, section.label]));
  const labelFor = new Map<WorkspaceProjectTabKey, string>();
  for (const tab of Object.keys(TAB_RENAMED_BY) as WorkspaceProjectTabKey[]) {
    const sectionKey = TAB_RENAMED_BY[tab];
    const label = sectionKey ? labelOf.get(sectionKey) : undefined;
    // The rename only happens when the section is actually there: without the
    // register, «اسناد» keeps the plain name rather than promising drawings it
    // cannot show.
    if (label) labelFor.set(tab, label);
  }

  const owns = (key: AecCockpitSectionKey) => sections.some((section) => section.key === key);
  // The shipped sections with no counterpart in the generic bar. Each is
  // capability-gated by `aecCockpitSections` above, so the bar only grows for a
  // business that actually has the thing.
  const aecOnly = (key: AecCockpitSectionKey): ProjectTab | null =>
    owns(key) ? { key, label: labelOf.get(key) ?? key } : null;
  const insertBeforeTeam = (["participants", "rfis", "submittals", "site", "inspections"] as const)
    .map(aecOnly)
    .filter((tab): tab is ProjectTab => tab !== null);

  const tabs: ProjectTab[] = [];
  for (const tab of WORKSPACE_PROJECT_TABS) {
    // §21's order for the priced work: what is being built, what it costs, then
    // who is bound — the BOQ tab sits between «اسناد» and «مالی».
    if (tab.key === "finance") {
      const boq = aecOnly("boq");
      if (boq) tabs.push(boq);
    }
    // And the registers §21 puts after the documents and the money and before
    // the team: what was asked and sent, then what is happening on the ground
    // and what failed inspection, before the "who is on it" tabs.
    if (tab.key === "team") tabs.push(...insertBeforeTeam);
    tabs.push({ key: tab.key, label: labelFor.get(tab.key) ?? tab.label });
  }
  return tabs;
}
