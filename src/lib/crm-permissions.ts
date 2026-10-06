/**
 * One source of truth for CRM access — section read, write, configure, delete
 * and merge.
 *
 * ## Why this file exists
 *
 * Before it, the answer to "who may open Deals?" lived in three places that had
 * already drifted apart:
 *
 *  - the sidebar and the route gate read a list of **alternatives**
 *    (`[crm.export, crm.configure]`), so a member holding *either* opened the
 *    page;
 *  - the page's own API required `crm.view`, which that first list did not
 *    mention;
 *  - the case screen drew its delete button on `crm.manage` while
 *    `DELETE /api/crm/cases/[id]` required `crm.delete`.
 *
 * The second is the worst of the three, and it is invisible: a member with
 * `crm.export` but not `crm.view` opened Deals, the page rendered, and every
 * request behind it answered 403 — a screen that looks broken rather than a
 * door that is shut. The third is the other way round: the UI offered a button
 * whose request could only fail.
 *
 * ## The model
 *
 * Each section declares the *capabilities* it needs, not the screens it draws:
 *
 * - `read` is a conjunction (`all`) plus an optional set of alternatives
 *   (`anyOf`). The alternatives exist where a section genuinely has two
 *   audiences that reach it by different rights — and the only place they are
 *   used here is the **management** sections, which require the base read
 *   (`crm.view`) *and* a management capability. That keeps `crm.export` from
 *   substituting for `crm.view` while still refusing to widen access: a
 *   cashier holds `crm.view` (through `crm.manage`) and is still not admitted
 *   to the pipeline, the segments or the leads.
 * - `write`, `configure`, `delete` and `merge` name the capability
 *   each *action* needs, and each API route must guard with exactly that one.
 *   `src/lib/crm-permissions.test.ts` reads the route files and fails the build
 *   when a route and this table disagree, which is the drift that produced the
 *   two bugs above.
 *
 * ## What must not change
 *
 * These helpers are the CRM's authorization boundary, so they are deliberately
 * boring: no role names, no module conditions, no `isOwner` shortcuts. A role
 * only ever enters through `effectivePermissions` in `permissions.ts`, and the
 * table below only compares permission keys. The regression test
 * (`crm-permissions.test.ts`) pins the admitted set per built-in role so an
 * "obvious" tweak here cannot silently hand the floor the pipeline.
 */

import { PERMISSIONS, type Permission } from "./permissions";

/**
 * The CRM's sections.
 *
 * `persons` is the 360° customer file: a real section with its own route gate,
 * but reached from `directory` rather than being a permanent menu entry of its
 * own. It is listed here so its permission cannot be defined anywhere else.
 */
export const CRM_SECTION_KEYS = [
  "overview",
  "directory",
  "persons",
  "leads",
  "segments",
  "deals",
  "activities",
  "cases",
  // The data-quality *workspace*: which records can be trusted. It hosts the
  // duplicate pairs, the external identities waiting for a decision and the
  // list of unusable records, because those three answer one question and
  // splitting them across the menu made people check three screens to learn
  // one thing.
  "quality",
  "duplicates",
  // Deciding who an anonymous online shopper is attaches their whole purchase
  // history to a named person, so it sits with the management sections rather
  // than on the floor.
  "reconciliation",
  "consent",
  // The CRM's decision log — who moved what, and why. A manager/admin reader:
  // it is a record of other people's judgement calls.
  "audit",
  // The CRM's *own* settings. `/settings` is the platform settings area;
  // `/crm/settings` configures this app (duplicates, consent defaults, pipeline
  // stages, business fields) and is a different route with a different
  // component.
  "settings",
  // The rules that put work in somebody's day without being asked: «وقتی → اگر
  // → آنگاه». Reached from the CRM's own settings screen rather than the rail
  // (see `CRM_SUB_SECTIONS`), because writing a rule is configuration — but it
  // is a *section* with its own route, gate and bookmarks like any other, and
  // the gate is the strongest CRM capability there is: an automation changes
  // records with nobody watching.
  "automations",
] as const;

export type CrmSectionKey = (typeof CRM_SECTION_KEYS)[number];

/**
 * A section's requirements.
 *
 * `read.all` and `read.anyOf` are separate fields rather than one list because
 * the two say different things and a single array cannot: an array of
 * permissions is read as "any of these" by every other gate in this codebase,
 * which is precisely the bug this module removes.
 */
export interface CrmSectionAccess {
  read: {
    /** Every one of these is required. */
    all: readonly Permission[];
    /** At least one of these, when the section has more than one audience. */
    anyOf?: readonly Permission[];
  };
  /** Creating and editing the section's records. */
  write?: readonly Permission[];
  /** Reconfiguring structure the section's reports are keyed to. */
  configure?: readonly Permission[];
  /** Destroying a record outright. */
  delete?: readonly Permission[];
  /** Irreversibly combining two identities. */
  merge?: readonly Permission[];
  /**
   * Actions this section's screen gates with a prop of its own, so the read
   * requirement is not obliged to imply them.
   *
   * This is the one honest exception to "whoever may open a section may do
   * everything on it", and it is declared rather than assumed: the directory
   * and the customer file already render themselves from the member's
   * permissions (a cashier may correct a phone number without holding
   * `crm.view` in any other context), and the case delete control is drawn
   * from `crm.delete` and nothing else. Any *other* action that is not implied
   * by the read requirement fails `crm-permissions.test.ts`, because a control
   * whose request can only fail is a bug this module exists to prevent.
   */
  screenOwned?: readonly Exclude<CrmSectionAction, "read">[];
  /**
   * Routes whose requirement is *not* the section action's default, keyed
   * `METHOD /path` with the path relative to `/api/crm/`.
   *
   * Some sections have two write tiers: the customer file's own record is floor
   * work (`parties.manage`) while the identity graph beside it — «نسبت‌ها» — is
   * management work (`crm.manage`), and neither may be described by the other.
   * A refinement is *declared*, never inferred, and `crm-permissions.test.ts`
   * fails when a route disagrees with the entry it claims.
   */
  routes?: Readonly<Record<string, readonly Permission[]>>;
}

export type CrmSectionAction = "read" | "write" | "configure" | "delete" | "merge";

/*
 * Not in this vocabulary, deliberately:
 *
 * - **export** — leaving with a customer list is the platform data-transfer
 *   engine's door, and it intersects `data.export` with the entity's own
 *   `crm.export` itself (`src/lib/data-transfer/entities/crm.ts`). A section
 *   that grew its own export button would be a second door with a second rule.
 * - **consent** — consent is written on the customer's file, next to the person
 *   it is about, and the file gates it on `crm.consent_manage`. There is no
 *   consent *section* action to declare.
 */

const {
  partiesView,
  partiesManage,
  crmView,
  crmManage,
  crmMerge,
  crmConsentManage,
  crmExport,
  crmConfigure,
  crmDelete,
} = PERMISSIONS;

/**
 * A management section: the base read **plus** a management capability.
 *
 * `crm.export` and `crm.configure` are the two manager-level CRM keys a cashier
 * never holds, so requiring one of them is what keeps the pipeline, the
 * segments, the leads and the overview off the floor. Stated once, here, because
 * repeating the pair in four sections is how one of them came to be missing
 * `crm.view` in the first place.
 */
const MANAGEMENT_READ = [crmExport, crmConfigure] as const;

/**
 * The access table.
 *
 * Read each row as a sentence: *who may open it, who may change it, who may
 * reshape it, who may destroy it*.
 */
export const CRM_SECTION_ACCESS: Record<CrmSectionKey, CrmSectionAccess> = {
  /*
   * The read rules below are deliberately **conjunctive**, and the second half
   * of each is not a duplicate:
   *
   * - `crm.view` is what the section's own API requires to read anything. A
   *   section that admitted somebody without it rendered a page whose every
   *   request answered 403 — a screen that looks broken rather than a door that
   *   is shut. That is the bug this module was written to end.
   * - a management capability (`crm.export`, `crm.configure`, `crm.merge`) is
   *   what keeps the pipeline, the leads, the segments and the overview off the
   *   floor. The cashier holds `crm.view` — through `crm.manage` — so the base
   *   read alone would hand a shift the business's forecast.
   * - the day-to-day write capability is included where the section's screen is
   *   a working surface, so nobody opens a board whose controls can only fail.
   */
  overview: {
    read: { all: [crmView, crmManage], anyOf: MANAGEMENT_READ },
    // «محاسبهٔ دوبارهٔ RFM» rewrites every customer's score, and the saved-view
    // routes are the same key: a view is a decision about how the business reads
    // its customer list, not a per-member preference the floor owns.
    write: [crmManage],
  },
  // The shared parties directory, seen through the CRM's scope. The screen
  // renders itself from the member's permissions — a cashier takes a phone
  // number and edits a person without any other CRM key — so its write actions
  // are `screenOwned`.
  directory: {
    read: { all: [crmView, partiesView] },
    write: [partiesManage],
    screenOwned: ["write"],
  },
  // The 360° file: purchase history, notes, timeline, consent state. Its write
  // controls are permission-aware for the same reason as the directory's.
  persons: {
    read: { all: [crmView, partiesView] },
    write: [partiesManage],
    screenOwned: ["write"],
    routes: {
      // The identity graph: linking two people changes who is related to whom
      // business-wide, which is a management decision even though it is written
      // from the floor's own screen.
      "POST customers/[id]/relationships": [crmManage],
      "DELETE customers/[id]/relationships": [crmManage],
    },
  },
  leads: {
    read: { all: [crmView, crmManage], anyOf: MANAGEMENT_READ },
    write: [crmManage],
  },
  // Whoever opens this may reshape it: the screen's whole point is editing
  // segment rules, and `crm.configure` is what the write path requires.
  segments: {
    read: { all: [crmView, crmConfigure] },
    configure: [crmConfigure],
  },
  deals: {
    read: { all: [crmView, crmManage], anyOf: MANAGEMENT_READ },
    write: [crmManage],
  },
  // Floor work: logging a call, ticking off a callback, taking a complaint. The
  // records live in the CRM but the read and write paths are the shared parties
  // service, so all three keys are real requirements — and a member with
  // `parties.view` alone (an accountant) is not admitted into the CRM's task
  // list by them.
  activities: {
    read: { all: [partiesView, partiesManage, crmManage] },
    write: [partiesManage],
  },
  cases: {
    read: { all: [partiesView, partiesManage, crmManage] },
    write: [partiesManage],
    // Destroying the evidence a complaint was made is not floor work, and it is
    // the one action a cashier who may work the service desk does not get. The
    // screen draws this button from `crm.delete` — the same key the endpoint
    // requires, via `crm-section.tsx`.
    delete: [crmDelete],
    screenOwned: ["delete"],
  },
  // Whoever cleans the record owns the workspace. `crm.merge` is the capability
  // that decides whether two rows are one person; the issues list beside it is
  // the same judgement about the same data, and the screen hides the two views a
  // narrower member cannot use rather than promising them.
  quality: {
    read: { all: [crmMerge] },
  },
  duplicates: {
    read: { all: [crmMerge] },
    merge: [crmMerge],
  },
  reconciliation: {
    read: { all: [crmMerge, crmManage] },
    write: [crmManage],
  },
  // A legal record: somebody who may make the business's messaging lawful or
  // unlawful. Reading it is holding it.
  consent: {
    read: { all: [crmConsentManage] },
    // Reading this register is holding it: the same key writes the event.
    write: [crmConsentManage],
  },
  // The decision log names who decided what, which is a record *about staff* —
  // and the people it is about are not its audience.
  audit: {
    read: { all: [crmConfigure] },
  },
  settings: {
    read: { all: [crmConfigure] },
    configure: [crmConfigure],
  },
  // The same capability that may reshape the pipeline may write a rule that acts
  // on it, and no wider one may: a rule assigns work to members and files
  // follow-ups against real customers. Reading the rules is reading the
  // configuration, so it is held by the same key.
  automations: {
    read: { all: [crmConfigure] },
    configure: [crmConfigure],
    delete: [crmConfigure],
  },
};

/** The declared requirement for one action on one section. `undefined` = not an action this section has. */
export function crmSectionPermission(
  key: CrmSectionKey,
  action: Exclude<CrmSectionAction, "read">,
): readonly Permission[] | undefined {
  return CRM_SECTION_ACCESS[key][action];
}

function satisfies(
  permissions: ReadonlySet<Permission>,
  requirement: CrmSectionAccess["read"],
): boolean {
  if (!requirement.all.every((permission) => permissions.has(permission))) return false;
  const anyOf = requirement.anyOf ?? [];
  return anyOf.length === 0 || anyOf.some((permission) => permissions.has(permission));
}

/** Whether a member may open a section. */
export function canViewCrmSection(
  permissions: ReadonlySet<Permission>,
  key: CrmSectionKey,
): boolean {
  return satisfies(permissions, CRM_SECTION_ACCESS[key].read);
}

/**
 * A section route's declared requirement, when it differs from the action's
 * default. `undefined` means "the action's own default applies".
 */
export function crmSectionRoutePermission(
  key: CrmSectionKey,
  route: string,
): readonly Permission[] | undefined {
  return CRM_SECTION_ACCESS[key].routes?.[route];
}

/** Whether a member may create or edit that section's records. */
export function canWriteCrmSection(
  permissions: ReadonlySet<Permission>,
  key: CrmSectionKey,
): boolean {
  return holds(permissions, crmSectionPermission(key, "write"));
}

/** Whether a member may reshape that section's configuration. */
export function canConfigureCrmSection(
  permissions: ReadonlySet<Permission>,
  key: CrmSectionKey,
): boolean {
  return holds(permissions, crmSectionPermission(key, "configure"));
}

/** Whether a member may destroy a record outright. */
export function canDeleteCrmSection(
  permissions: ReadonlySet<Permission>,
  key: CrmSectionKey,
): boolean {
  return holds(permissions, crmSectionPermission(key, "delete"));
}

/**
 * Whether a member may save or delete a named view — `crm_saved_views`.
 *
 * Stated as its own question because the answer is not any one section's write
 * key: the saved-view routes are shared by every screen and are guarded by
 * `crm.manage`. Spelling that inline on a screen is how the case delete button
 * came to be drawn for people whose endpoint required `crm.delete`; the screen
 * asks this function, which asks the same constant the route does.
 */
export function canSaveCrmViews(permissions: ReadonlySet<Permission>): boolean {
  return permissions.has(crmManage);
}

/** Whether a member may merge identity records. */
export function canMergeCrmSection(
  permissions: ReadonlySet<Permission>,
  key: CrmSectionKey,
): boolean {
  return holds(permissions, crmSectionPermission(key, "merge"));
}

/**
 * A section with no declared requirement for an action is *closed* for it.
 *
 * The alternative — treating "not declared" as "allowed" — turns a forgotten
 * table row into an open door, which is exactly how `crm.delete` ended up
 * guarding a button drawn on `crm.manage`.
 */
function holds(
  permissions: ReadonlySet<Permission>,
  requirement: readonly Permission[] | undefined,
): boolean {
  if (!requirement || requirement.length === 0) return false;
  return requirement.every((permission) => permissions.has(permission));
}

/** Whether the app has anything at all to show this member. */
export function canOpenCrm(permissions: ReadonlySet<Permission>): boolean {
  return CRM_SECTION_KEYS.some((key) => canViewCrmSection(permissions, key));
}

/**
 * Where a member who followed a link into the CRM lands when the section they
 * asked for is not theirs.
 *
 * Kept here beside the table so "what may they see" and "where do we send them
 * instead" cannot disagree. The caller turns the key into an href — this module
 * knows permissions, not routes.
 */
export function crmFallbackSection(
  permissions: ReadonlySet<Permission>,
): CrmSectionKey | null {
  // `CRM_SECTION_KEYS` order, not a second preference list: the section the app
  // opens on is the section the menu lists first, so the two cannot disagree.
  return CRM_SECTION_KEYS.find((key) => canViewCrmSection(permissions, key)) ?? null;
}
