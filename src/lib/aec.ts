/**
 * Issue #799 Wave 2 — what an AEC business *is*, as opposed to which industry
 * it chose.
 *
 * `architecture_construction` (industries.ts) is deliberately one business type
 * covering an architecture office, a structural engineering firm, a general
 * contractor, a design & build company, a supervision consultant and a single
 * freelance architect. The issue is explicit that these must **not** become
 * separate industries: they are *operating profiles* — configuration a business
 * picks, changes, and that a super-admin can recommend — and the difference
 * between them is which capabilities they start with.
 *
 * This module is that catalogue, and it is framework-free (no `db`, no `next`)
 * exactly like `industries.ts` and `industry-profile.ts`, so the setup wizard, a
 * settings panel and a server guard can all read the same answer.
 *
 * ## Three lists, one direction of truth
 *
 *   * `AEC_OPERATING_PROFILES` — the eight business shapes from §2 of the issue.
 *   * `AEC_SPECIALTIES` — the disciplines (architecture, MEP, surveying, …) a
 *     business tags itself with. They are *labels*, never a gate: they describe
 *     what a firm does, and Wave 3's templates and search read them.
 *   * `AEC_CAPABILITY_KEYS` — the fine-grained switches a profile turns on.
 *     A capability is what a screen or a domain asks about ("does this business
 *     keep a BOQ?"), never which profile it picked.
 *
 * A profile is therefore nothing but a *preset over capabilities*. Changing the
 * profile re-derives the preset; an explicit override beats it in both
 * directions (a contractor that does not subcontract can switch
 * `subcontractors` off; an individual who runs one site can switch
 * `site_operations` on) — which is the issue's "Hide contractor-heavy
 * functionality unless explicitly enabled" made mechanical.
 *
 * Nothing here decides *permissions*. A capability says which screens and
 * domains a business has; who may use them is still the platform permission
 * intersected with the member's project role (`workspace.ts`), and an external
 * participant recorded here is a directory record, never a login.
 *
 * ## Honest status
 *
 * Most capabilities here describe domains that arrive wave by wave (BOQ and
 * estimating in Wave 4, document control in Wave 5, site execution in Wave 7,
 * commercial controls in Wave 8, procurement in Wave 9 — the last two still to
 * come). Declaring them all at once is deliberate: the preset a business is
 * *given* is the one each wave reads, and `AEC_CAPABILITY_LABELS` is what the
 * settings panel shows an owner so the choice is legible before a screen exists. `AEC_LIVE_CAPABILITIES`
 * names the handful that gate something today, and they are not decorative — a
 * participant role whose capability is off is refused by the API, not merely
 * hidden (see `aec-service.ts`).
 */

/* ===========================================================================
 * Capabilities
 * ======================================================================== */

export const AEC_CAPABILITY_KEYS = [
  /** The project register itself: projects, phases, tasks, documents, calendar. */
  "projects",
  /** External participants (the client, the consultants, the contractor). */
  "participants",
  /** Design phase management — brief → concept → schematic → detailed design. */
  "design_phases",
  /** A drawing register with revisions and issue purposes. Wave 5. */
  "document_control",
  /** Approval cycles over drawings, submittals and documents. */
  "approvals",
  /** Sub-consultants engaged by the lead designer. */
  "subconsultants",
  /** Estimating and rate build-up. Wave 4. */
  "estimating",
  /** The bill of quantities itself. Wave 4. */
  "boq",
  /** Tendering and bid comparison. Wave 8. */
  "tendering",
  /** Procurement: requests, RFQs, comparison, delivery tracking. Wave 9. */
  "procurement",
  /** Subcontractor packages and their settlements. Wave 9. */
  "subcontractors",
  /** Site operations: daily logs, site reports. Wave 7. */
  "site_operations",
  /** Inspections, QA/QC and NCRs. Wave 7. */
  "qa_qc",
  /** Snagging / punch lists. Wave 7. */
  "snagging",
  /**
   * HSE observations and incidents (issue §14's "where enabled"). Wave 7.
   * A business that does not run a site — a pure design office — has no
   * observations to record, which is why this is a switch rather than a field
   * every issue register carries.
   */
  "hse",
  /**
   * Material tracking on site. **Reserved, and not a promise.** Delivery
   * *tracking* — what was ordered, what arrived, who signed for it — is §18's
   * and rides `procurement` (migration 0201's commitments and deliveries); a
   * materials *ledger* with quantities on hand would need the products/stock
   * model an AEC tenant deliberately does not have (Wave 1: no `items`, no
   * `item_stock`). No screen waits on this switch, which is why it is absent from
   * `AEC_LIVE_CAPABILITIES` with a reason instead of a wave number.
   */
  "material_tracking",
  /** Supervision cycles and inspection visits. Wave 8. */
  "supervision",
  /** Progress measurement, certificates and payment claims. Wave 8. */
  "progress_claims",
  /** Variations and change orders. Wave 8. */
  "variations",
  /** The project commercial cockpit: budget vs actual, forecast, margin. */
  "financials",
] as const;
export type AecCapabilityKey = (typeof AEC_CAPABILITY_KEYS)[number];

export const AEC_CAPABILITY_LABELS: Record<AecCapabilityKey, string> = {
  projects: "پروژه‌ها، فازها و وظایف",
  participants: "طرف‌های پروژه (کارفرما، مشاور، پیمانکار)",
  design_phases: "فازهای طراحی",
  document_control: "کنترل نقشه و مستندات (رویزیون و صدور)",
  approvals: "چرخهٔ تأیید",
  subconsultants: "مشاوران جزء",
  estimating: "برآورد و آنالیز قیمت",
  boq: "متره و فهرست بها (BOQ)",
  tendering: "مناقصه و پیشنهاد",
  procurement: "تأمین و خرید",
  subcontractors: "پیمانکاران جزء",
  site_operations: "عملیات کارگاه و گزارش روزانه",
  qa_qc: "کنترل کیفیت و بازرسی",
  snagging: "رفع نقص و لیست نواقص",
  hse: "ایمنی و بهداشت کارگاه (HSE)",
  material_tracking: "ردیابی مصالح",
  supervision: "نظارت و بازدید",
  progress_claims: "صورت‌وضعیت و گواهی پیشرفت",
  variations: "تغییرات و دستور کار",
  financials: "مالی پروژه (بودجه، تعهد، پیش‌بینی)",
};

/**
 * The capabilities whose subject already exists in the product, so a switch on
 * them means something *today* rather than "a screen in a later wave". Kept
 * explicit so the settings panel can say so honestly instead of implying that
 * every line is already built.
 */
export const AEC_LIVE_CAPABILITIES: readonly AecCapabilityKey[] = [
  "projects",
  "participants",
  // Issue #799 Wave 4 — the estimating domain has screens and tables behind it
  // now (`aec-boq-service.ts`, migration 0196), so the capability stops being a
  // label in a settings panel and starts refusing requests when it is off.
  "boq",
  // Wave 5 — same promotion for the drawing register and the transmittals
  // (`aec-doc-service.ts`, migration 0197).
  "document_control",
  // Wave 7 — the site and the QA register (`aec-site-service.ts`, migration
  // 0199): the daily log, the issue/QA register, snagging and HSE observations.
  // `material_tracking` deliberately stays out: §13's "materials delivered" line
  // on a day's log rides `site_operations`, and a material *tracking* register
  // is Wave 9's procurement half.
  "site_operations",
  "qa_qc",
  "snagging",
  "hse",
  // Wave 8 — the commercial controls (`aec-commercial-service.ts`, migration
  // 0200): the change-order register, the payment certificates and the project's
  // commercial cockpit. §15/§16/§20 are the sections a construction business
  // cannot run without, so they stop being labels the settings panel shows and
  // start refusing requests when a preset turns them off.
  "variations",
  "progress_claims",
  "financials",
  // Wave 9 — procurement (`aec-procurement-service.ts`, migration 0201): the
  // material request, the RFQ and its comparison, the purchase/subcontract
  // commitment and its deliveries. §18 asks for the whole flow to be
  // switchable — "small architecture offices should be able to disable/hide
  // this entire capability" — and the design presets already have it off.
  "procurement",
  "subcontractors",
];

/* ===========================================================================
 * Specialties — labels, never gates
 * ======================================================================== */

export const AEC_SPECIALTIES = [
  "architecture",
  "structural_engineering",
  "civil_engineering",
  "interior_architecture",
  "landscape",
  "mep",
  "surveying",
  "project_management",
  "construction_management",
  "site_supervision",
  "quantity_surveying",
] as const;
export type AecSpecialty = (typeof AEC_SPECIALTIES)[number];

export const AEC_SPECIALTY_LABELS: Record<AecSpecialty, string> = {
  architecture: "معماری",
  structural_engineering: "مهندسی سازه",
  civil_engineering: "مهندسی عمران",
  interior_architecture: "معماری داخلی",
  landscape: "منظر و محوطه‌سازی",
  mep: "تأسیسات مکانیکی، برقی و لوله‌کشی (MEP)",
  surveying: "نقشه‌برداری",
  project_management: "مدیریت پروژه",
  construction_management: "مدیریت ساخت",
  site_supervision: "نظارت بر اجرا",
  quantity_surveying: "متره و برآورد",
};

/* ===========================================================================
 * Operating profiles
 * ======================================================================== */

export const AEC_OPERATING_PROFILES = [
  "architecture_office",
  "civil_engineering",
  "contractor",
  "design_build",
  "consulting_supervision",
  "multidisciplinary",
  "team",
  "individual",
] as const;
export type AecOperatingProfile = (typeof AEC_OPERATING_PROFILES)[number];

export interface AecOperatingProfileDef {
  key: AecOperatingProfile;
  label: string;
  /** One line, in the owner's terms, of what this shape of business is. */
  description: string;
  /** The capability preset. An override may add to or remove from it. */
  capabilities: readonly AecCapabilityKey[];
}

/**
 * The design capabilities: what an office that *designs* needs. Shared by three
 * profiles rather than copied, so "an architecture office and a civil office
 * differ in their specialties, not in their modules" is true by construction.
 */
const DESIGN_CAPABILITIES: readonly AecCapabilityKey[] = [
  "projects",
  "participants",
  "design_phases",
  "document_control",
  "approvals",
  "subconsultants",
  "financials",
];

/**
 * The construction capabilities: what a business that *builds* needs. The
 * contractor-heavy half of the issue's §2 list, verbatim.
 */
const CONSTRUCTION_CAPABILITIES: readonly AecCapabilityKey[] = [
  "projects",
  "participants",
  // Issue #799 Wave 5. A contractor issues shop drawings and as-builts as
  // routinely as a designer issues drawings — §9's register and §12's
  // transmittals are how the site gets the revision it is supposed to build
  // from — so the capability belongs in this preset rather than being something
  // a contractor has to switch on.
  "document_control",
  "estimating",
  "boq",
  "tendering",
  "procurement",
  "subcontractors",
  "site_operations",
  "qa_qc",
  "snagging",
  // Issue #799 Wave 7. §14 lists HSE observations "where enabled", and a
  // contractor running a site is exactly the profile that has them.
  "hse",
  "material_tracking",
  "progress_claims",
  "variations",
  "approvals",
  "financials",
];

/** What supervision/monitoring work needs: verification rather than production. */
const SUPERVISION_CAPABILITIES: readonly AecCapabilityKey[] = [
  "projects",
  "participants",
  "document_control",
  "approvals",
  "supervision",
  "qa_qc",
  "snagging",
  // A supervisor records incidents as often as a contractor does — §14's "HSE
  // observations/incidents where enabled" is part of the verification job.
  "hse",
  "progress_claims",
  "variations",
  "financials",
];

/** The lean set an individual professional or a small team starts from. */
const SOLO_CAPABILITIES: readonly AecCapabilityKey[] = [
  "projects",
  "participants",
  "design_phases",
  "document_control",
  "approvals",
  "financials",
];

export const AEC_OPERATING_PROFILE_DEFS: Record<AecOperatingProfile, AecOperatingProfileDef> = {
  architecture_office: {
    key: "architecture_office",
    label: "دفتر معماری",
    description: "دفتر طراحی با چند معمار و همکاران مشاور؛ از بریف تا تحویل.",
    capabilities: DESIGN_CAPABILITIES,
  },
  civil_engineering: {
    key: "civil_engineering",
    label: "شرکت مهندسی عمران و سازه",
    description: "مطالعات، تحلیل و طراحی سازه و عمران، همراه با هماهنگی و تأیید مدارک.",
    capabilities: DESIGN_CAPABILITIES,
  },
  contractor: {
    key: "contractor",
    label: "پیمانکار",
    description: "اجرای پروژه؛ برآورد، تأمین، کارگاه، پیمانکاران جزء و صورت‌وضعیت.",
    capabilities: CONSTRUCTION_CAPABILITIES,
  },
  design_build: {
    key: "design_build",
    label: "طراحی و ساخت (Design & Build)",
    description: "هم طراحی و هم اجرا زیر یک قرارداد؛ مجموعهٔ کامل قابلیت‌های طراحی و ساخت.",
    // The union, computed rather than typed twice: the issue asks for "the full
    // design + construction capability set", and a hand-written union would
    // drift the moment either half changes.
    capabilities: [...new Set([...DESIGN_CAPABILITIES, ...CONSTRUCTION_CAPABILITIES])],
  },
  consulting_supervision: {
    key: "consulting_supervision",
    label: "مشاور و ناظر",
    description: "مشاوره، نظارت بر اجرا، بازدید و تأیید صورت‌وضعیت پیمانکار.",
    capabilities: SUPERVISION_CAPABILITIES,
  },
  multidisciplinary: {
    key: "multidisciplinary",
    label: "شرکت چندرشته‌ای",
    description: "چند رشته زیر یک سقف؛ طراحی، نظارت و اجرا با همهٔ قابلیت‌ها.",
    capabilities: [
      ...new Set([
        ...DESIGN_CAPABILITIES,
        ...CONSTRUCTION_CAPABILITIES,
        ...SUPERVISION_CAPABILITIES,
      ]),
    ],
  },
  team: {
    key: "team",
    label: "تیم کوچک",
    description: "چند نفر با پروژه‌های کوچک؛ بدون بخش‌های سنگین پیمانکاری.",
    capabilities: SOLO_CAPABILITIES,
  },
  individual: {
    key: "individual",
    label: "فرد متخصص (شخص حقیقی)",
    description: "معمار، مهندس یا پیمانکار مستقل؛ سبک‌ترین حالت، بدون بخش‌های پیمانکاری.",
    // The issue's individual-architect example: projects, tasks, clients,
    // drawings/documents, calendar, invoices, project financial summary and the
    // assistant. Calendar, invoices and the assistant are platform-wide and not
    // AEC capabilities, so what is declared here is the AEC-specific remainder.
    capabilities: ["projects", "participants", "design_phases", "document_control", "financials"],
  },
};

/**
 * The profile an AEC business gets when it has not chosen one yet.
 *
 * `architecture_office` rather than the widest set: choosing for a business must
 * never *presume* it subcontracts, tenders or runs a site. The setup wizard asks
 * on the first pass, and this default is what the narrow window before that
 * answer (and every API read for a business created outside the wizard) falls
 * back to. Nothing is lost by being lean here — an override or a profile change
 * turns anything on, and the settings panel says so.
 */
export const AEC_DEFAULT_OPERATING_PROFILE: AecOperatingProfile = "architecture_office";

/* ===========================================================================
 * Participant roles (§6) — professional titles, never permission roles
 * ======================================================================== */

export const AEC_PARTICIPANT_ROLES = [
  "client",
  "employer_representative",
  "architect",
  "lead_architect",
  "structural_engineer",
  "civil_engineer",
  "mep_consultant",
  "landscape_consultant",
  "project_manager",
  "construction_manager",
  "supervision_consultant",
  "contractor",
  "subcontractor",
  "supplier",
  "quantity_surveyor",
  "estimator",
  "site_engineer",
  "foreman",
  "inspector",
  "qa_qc",
  "hse",
  "surveyor",
] as const;
export type AecParticipantRole = (typeof AEC_PARTICIPANT_ROLES)[number];

/** The four sides a project's participants are grouped by, for the picker. */
export const AEC_PARTICIPANT_GROUPS = ["client", "consultant", "contractor", "field"] as const;
export type AecParticipantGroup = (typeof AEC_PARTICIPANT_GROUPS)[number];

export const AEC_PARTICIPANT_GROUP_LABELS: Record<AecParticipantGroup, string> = {
  client: "کارفرما",
  consultant: "مشاوران و عوامل طراحی",
  contractor: "پیمانکاران و تأمین‌کنندگان",
  field: "عوامل کارگاه",
};

export interface AecParticipantRoleDef {
  key: AecParticipantRole;
  label: string;
  group: AecParticipantGroup;
  /**
   * Capabilities, **any** of which makes this role offerable. Empty means every
   * AEC profile has it — a client, an architect and a contractor exist on every
   * project whatever shape the business is.
   *
   * This is what makes the presets do work in Wave 2 rather than merely
   * describing the future: an individual architect's project is not offered
   * «سرکارگر» or «پیمانکار جزء» unless they deliberately switched those
   * capabilities on, and `aec-service.ts` refuses such a role in the API, not
   * just in the picker.
   */
  requires?: readonly AecCapabilityKey[];
}

export const AEC_PARTICIPANT_ROLE_DEFS: Record<AecParticipantRole, AecParticipantRoleDef> = {
  client: { key: "client", label: "کارفرما", group: "client" },
  employer_representative: {
    key: "employer_representative",
    label: "نمایندهٔ کارفرما",
    group: "client",
  },
  architect: { key: "architect", label: "معمار", group: "consultant" },
  lead_architect: { key: "lead_architect", label: "معمار ارشد", group: "consultant" },
  structural_engineer: {
    key: "structural_engineer",
    label: "مهندس سازه",
    group: "consultant",
  },
  civil_engineer: { key: "civil_engineer", label: "مهندس عمران", group: "consultant" },
  mep_consultant: {
    key: "mep_consultant",
    label: "مشاور تأسیسات (MEP)",
    group: "consultant",
  },
  landscape_consultant: {
    key: "landscape_consultant",
    label: "مشاور منظر و محوطه",
    group: "consultant",
  },
  project_manager: { key: "project_manager", label: "مدیر پروژه", group: "consultant" },
  construction_manager: {
    key: "construction_manager",
    label: "مدیر ساخت",
    group: "consultant",
    requires: ["site_operations", "subcontractors"],
  },
  supervision_consultant: {
    key: "supervision_consultant",
    label: "مشاور ناظر",
    group: "consultant",
    requires: ["supervision"],
  },
  quantity_surveyor: {
    key: "quantity_surveyor",
    label: "متره‌کار / کارشناس برآورد",
    group: "consultant",
    requires: ["estimating", "boq", "progress_claims"],
  },
  estimator: {
    key: "estimator",
    label: "کارشناس برآورد",
    group: "consultant",
    requires: ["estimating", "boq", "tendering"],
  },
  surveyor: { key: "surveyor", label: "نقشه‌بردار", group: "consultant" },
  contractor: { key: "contractor", label: "پیمانکار", group: "contractor" },
  subcontractor: {
    // The one role whose requirement is a single capability on purpose: a party
    // recorded as a subcontractor IS the subcontracting capability, so turning
    // `subcontractors` off must hide the role even when procurement is on —
    // which is the difference between "this business buys materials" and "this
    // business lets packages".
    key: "subcontractor",
    label: "پیمانکار جزء",
    group: "contractor",
    requires: ["subcontractors"],
  },
  supplier: {
    key: "supplier",
    label: "تأمین‌کننده",
    group: "contractor",
    requires: ["procurement", "material_tracking"],
  },
  site_engineer: {
    key: "site_engineer",
    label: "مهندس ناظر مقیم / سرپرست کارگاه",
    group: "field",
    requires: ["site_operations", "supervision"],
  },
  foreman: { key: "foreman", label: "سرکارگر", group: "field", requires: ["site_operations"] },
  inspector: {
    key: "inspector",
    label: "بازرس",
    group: "field",
    requires: ["qa_qc", "supervision"],
  },
  qa_qc: { key: "qa_qc", label: "کارشناس کنترل کیفیت", group: "field", requires: ["qa_qc"] },
  hse: {
    key: "hse",
    label: "کارشناس HSE (ایمنی و بهداشت)",
    group: "field",
    requires: ["site_operations", "qa_qc"],
  },
};

/* ===========================================================================
 * Resolution
 * ======================================================================== */

/** An explicit add/remove on top of the profile's preset, per capability. */
export type AecCapabilityOverrides = Partial<Record<AecCapabilityKey, boolean>>;

export interface AecCapabilityResolutionInput {
  profile: AecOperatingProfile;
  overrides?: AecCapabilityOverrides | null;
}

/**
 * The capabilities a business actually has: its profile's preset, then its own
 * overrides applied on top — in that order, so an explicit choice always beats
 * the preset and changing the profile later re-derives the rest.
 *
 * Returned in `AEC_CAPABILITY_KEYS` order rather than preset order, so two
 * callers (the settings panel, the API payload and a test) always agree on the
 * list's ordering and a diff of two businesses is readable.
 */
export function resolveAecCapabilities({
  profile,
  overrides,
}: AecCapabilityResolutionInput): AecCapabilityKey[] {
  const preset = new Set<AecCapabilityKey>(AEC_OPERATING_PROFILE_DEFS[profile].capabilities);
  for (const [key, enabled] of Object.entries(overrides ?? {})) {
    // Strictly boolean: `"yes"` is truthy but is not an override, and treating
    // it as one would let a malformed client body turn a capability on. The
    // same rule `normalizeAecCapabilityOverrides` writes the column with.
    if (!isAecCapability(key) || typeof enabled !== "boolean") continue;
    if (enabled) preset.add(key);
    else preset.delete(key);
  }
  return AEC_CAPABILITY_KEYS.filter((key) => preset.has(key));
}

/** Whether one capability is on for this business. */
export function hasAecCapability(
  input: AecCapabilityResolutionInput,
  capability: AecCapabilityKey,
): boolean {
  return resolveAecCapabilities(input).includes(capability);
}

/**
 * The participant roles this business may record on a project, grouped for the
 * picker and stable within a group.
 *
 * The catalogue is ordered the way the issue lists the roles (client, then
 * consultants, then the contracting side, then site staff); rendering groups
 * the picker shows its four sections without the caller having to re-sort, so
 * this returns them ordered by *group* while keeping each group's internal
 * order exactly as declared.
 */
export function aecParticipantRolesFor(
  input: AecCapabilityResolutionInput,
): AecParticipantRoleDef[] {
  const capabilities = new Set(resolveAecCapabilities(input));
  return AEC_PARTICIPANT_ROLES.map((role) => AEC_PARTICIPANT_ROLE_DEFS[role])
    .filter((def) => {
      if (!def.requires || def.requires.length === 0) return true;
      return def.requires.some((capability) => capabilities.has(capability));
    })
    .sort(
      (a, b) => AEC_PARTICIPANT_GROUPS.indexOf(a.group) - AEC_PARTICIPANT_GROUPS.indexOf(b.group),
    );
}

/** Whether a role may be recorded by this business — the API's own check. */
export function aecParticipantRoleAllowed(
  input: AecCapabilityResolutionInput,
  role: string,
): role is AecParticipantRole {
  return aecParticipantRolesFor(input).some((def) => def.key === role);
}

/** Each role's group, so a caller never keeps a second copy of the mapping. */
export const AEC_PARTICIPANT_GROUP_BY_ROLE: Record<AecParticipantRole, AecParticipantGroup> =
  Object.fromEntries(
    Object.values(AEC_PARTICIPANT_ROLE_DEFS).map((def) => [def.key, def.group]),
  ) as Record<AecParticipantRole, AecParticipantGroup>;

export function isAecCapability(value: string): value is AecCapabilityKey {
  return (AEC_CAPABILITY_KEYS as readonly string[]).includes(value);
}

/* ===========================================================================
 * Assistant read tools (§23)
 * ======================================================================== */

/**
 * The two read tools §23 names. They live here, with the rest of the AEC
 * catalogue, so the agent builder's tool picker can list them without importing
 * the executor (which touches the database) — the same split
 * `workspace-shared.ts` uses for the workspace tools.
 *
 * Read tools only, deliberately: the issue's §23 list starts with reads, and
 * nothing AEC is written by the assistant yet. A write would have to go through
 * the confirmed-action flow, where §24's rule applies — a commercial action
 * must not inherit from ordinary task-edit access.
 */
export const AEC_AI_TOOL_NAMES = [
  "get_aec_project_financial_health",
  "list_delayed_project_activities",
  "get_boq_variance",
  // Issue #799 Wave 5 — §23's `get_latest_drawing_revision`, which the drawing
  // register (migration 0197) now makes answerable.
  "get_latest_drawing_revision",
  // Issue #799 Wave 6 — §23's two pending lists. They answer the question the
  // issue also writes in Persian («RFIهای بدون پاسخ این هفته چیست؟» and
  // «چه سابمیتال‌هایی منتظر تأیید هستند؟») from the same service the RFI and
  // submittal tabs read, so the assistant and the screen cannot disagree.
  "list_pending_rfis",
  "list_pending_submittals",
  // Issue #799 Wave 7 — §23's `list_site_issues`: what is open on site, which is
  // the inspection/NCR/snag register the «بازرسی و کنترل کیفیت» tab reads.
  "list_site_issues",
  // Issue #799 Wave 8 — §23's commercial three. The issue writes the Persian
  // questions it wants answered («حاشیهٔ برآوردی پروژه چقدر است؟» and «چه
  // ریسک‌های تجاری در قراردادها و صورت‌وضعیت‌ها داریم؟») and names
  // `list_change_orders` and `list_payment_certificates`; the third,
  // `list_project_commercial_risks`, is the question those two exist to answer.
  // All three read the same service the change-order and certificate tabs read,
  // and none of them writes: a commercial action still needs a human pressing
  // «اعمال», where §24's permission split applies.
  "list_change_orders",
  "list_payment_certificates",
  "list_project_commercial_risks",
  // Issue #799 Wave 9 — §23's `list_procurement_delays`, which §22's widget and
  // §29's warning also name: awards that are past the delivery date the supplier
  // agreed to, and the material requests nobody has picked up. It reads the same
  // queue functions the procurement tab reads, so the chat answer and the screen
  // are the same rows.
  "list_procurement_delays",
] as const;
export type AecAiToolName = (typeof AEC_AI_TOOL_NAMES)[number];

export function isAecAiToolName(name: string): name is AecAiToolName {
  return (AEC_AI_TOOL_NAMES as readonly string[]).includes(name);
}

/** Persian labels for the agent builder's tool picker. */
export const AEC_AI_TOOL_LABELS: Record<AecAiToolName, string> = {
  get_aec_project_financial_health: "سلامت مالی پروژه (عمرانی)",
  list_delayed_project_activities: "فعالیت‌های عقب‌افتادهٔ پروژه",
  get_boq_variance: "مغایرت برآورد با هزینهٔ واقعی",
  get_latest_drawing_revision: "آخرین بازنگری نقشه‌ها",
  list_pending_rfis: "استعلام‌های بی‌پاسخ (RFI)",
  list_pending_submittals: "سابمیتال‌های منتظر تأیید",
  list_site_issues: "موارد باز کارگاه و بازرسی",
  list_change_orders: "تغییرات و دستور کارها",
  list_payment_certificates: "صورت‌وضعیت‌ها و گواهی‌ها",
  list_project_commercial_risks: "ریسک‌های تجاری پروژه",
  list_procurement_delays: "تأخیر تأمین و تعهدات باز",
};

export function isAecOperatingProfile(value: string): value is AecOperatingProfile {
  return (AEC_OPERATING_PROFILES as readonly string[]).includes(value);
}

export function isAecSpecialty(value: string): value is AecSpecialty {
  return (AEC_SPECIALTIES as readonly string[]).includes(value);
}

export function isAecParticipantRole(value: string): value is AecParticipantRole {
  return (AEC_PARTICIPANT_ROLES as readonly string[]).includes(value);
}

/**
 * The specialties to persist: trimmed, de-duplicated, in catalogue order, and
 * with anything outside the catalogue dropped rather than rejected.
 *
 * Dropping is the right failure mode for a *tag* list — a stale client that
 * sends a retired discipline must not be able to fail an otherwise valid save,
 * and the catalogue above is the one place the set of disciplines is decided.
 */
export function normalizeAecSpecialties(values: Iterable<unknown>): AecSpecialty[] {
  const raw = new Set<string>();
  for (const value of values) {
    if (typeof value === "string") raw.add(value.trim());
  }
  return AEC_SPECIALTIES.filter((specialty) => raw.has(specialty));
}

/**
 * The overrides to persist: unknown keys dropped, non-boolean values dropped,
 * and a `false` kept only when it *differs* from the profile's own preset.
 *
 * That last rule is what keeps the column small and, more importantly, keeps it
 * honest: an override that merely restates the preset is not an override, and
 * storing it would freeze today's preset against a future change to the
 * profile's definition.
 */
export function normalizeAecCapabilityOverrides(
  values: Record<string, unknown> | null | undefined,
  profile: AecOperatingProfile,
): AecCapabilityOverrides {
  const preset = new Set<AecCapabilityKey>(AEC_OPERATING_PROFILE_DEFS[profile].capabilities);
  const out: AecCapabilityOverrides = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (!isAecCapability(key) || typeof value !== "boolean") continue;
    if (value === preset.has(key)) continue;
    out[key] = value;
  }
  return out;
}
