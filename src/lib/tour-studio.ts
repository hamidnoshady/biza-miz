/**
 * The authored tour catalogue, in the super-admin console (issue #972) — the
 * pure half.
 *
 * `tours.ts` is the code catalogue: reviewed definitions that ship with a
 * deployment. This module is the shape the console writes instead — a tour the
 * super-admin authors, drafts, publishes and rolls back without a release —
 * and every rule it must satisfy **before it is stored**:
 *
 *  - the page exists in the canonical `KNOWLEDGE_PAGES` registry and the route
 *    equals that page's route (a tour must run where it is listed);
 *  - the id is a lowercase dotted key that cannot shadow a `baseline.` id;
 *  - every step is either an explanation (no anchor) or a spotlight of an
 *    anchor that is **registered** in `TOUR_ANCHORS` — never a raw selector,
 *    a label or a DOM position. A page that has no anchor for the thing being
 *    explained is authored as an explanation, not as a highlight that quietly
 *    points at nothing;
 *  - a tour opens with a plain explanation, so a missing first highlight can
 *    never be the first thing a member meets;
 *  - eligibility uses the same vocabulary `tourForViewer` evaluates (known
 *    permissions, known industries, known feature-flag names, the costing
 *    system, `anyOf`), so what an editor writes is exactly what the server
 *    later checks per member.
 *
 * Validation here is **publish-blocking but not authoring-blocking**: a draft
 * is allowed to be incomplete in the same ways a code review would reject, and
 * the console shows every problem as a sentence. Publishing reuses
 * `validateTours` on the built definition, so a stored tour can never be
 * structurally broken on the member side.
 *
 * Client-safe: no database and no DOM, so the console panel and the unit tests
 * import this same module as the server route does.
 */
import { INDUSTRIES, type Industry } from "./industries";
import { knowledgePage } from "./knowledge-base";
import { PERMISSIONS, type Permission } from "./permissions";
import {
  MAX_TOUR_STEPS,
  TOUR_ANCHORS,
  tourById,
  validateTours,
  type TourDefinition,
  type TourEligibility,
  type TourInventorySystem,
  type TourStep,
} from "./tours";

export const STUDIO_TOUR_STATUSES = ["draft", "published", "archived"] as const;
export type StudioTourStatus = (typeof STUDIO_TOUR_STATUSES)[number];

/** One authored tour as the console sees it. */
export interface StudioTour {
  /** Row id; the console's URLs use it. The *tour* id is `tourKey`. */
  id: string;
  tourKey: string;
  pageKey: string;
  route: string;
  title: string;
  description: string;
  eligibility: TourEligibility;
  steps: readonly TourStep[];
  status: StudioTourStatus;
  /** The working copy's revision. */
  version: number;
  /** The revision members play, or null before the first publish. */
  publishedVersion: number | null;
  updatedBy: string;
  updatedAt: string;
  publishedAt: string | null;
}

/** An immutable content snapshot, as the console's revision list shows it. */
export interface StudioTourRevision {
  version: number;
  title: string;
  description: string;
  eligibility: TourEligibility;
  steps: readonly TourStep[];
  createdBy: string;
  createdAt: string;
  publishedAt: string | null;
  /** This revision is the one members play right now. */
  live: boolean;
}

/** The content of a tour, independent of its status: what a revision stores. */
export interface StudioTourContent {
  tourKey: string;
  pageKey: string;
  route: string;
  title: string;
  description: string;
  eligibility: TourEligibility;
  steps: readonly TourStep[];
}

export type StudioTourInputError =
  | "bad_request"
  | "unknown_page"
  | "route_mismatch"
  | "invalid_tour_key"
  | "baseline_key_reserved"
  | "tour_key_owned_by_another_page"
  | "invalid_title"
  | "invalid_description"
  | "invalid_steps"
  | "invalid_eligibility";

export interface StudioTourInvalid {
  ok: false;
  error: StudioTourInputError;
  /** A sentence the console can show: which step, which permission, … */
  detail: string;
}

export type StudioTourParseResult =
  | { ok: true; input: StudioTourContent }
  | StudioTourInvalid;

const TOUR_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const STEP_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FEATURE_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const BASELINE_PREFIX = "baseline.";

export const STUDIO_TITLE_MAX = 120;
export const STUDIO_DESCRIPTION_MAX = 300;
export const STUDIO_STEP_TITLE_MAX = 120;
export const STUDIO_STEP_BODY_MAX = 1000;

/**
 * The console's Persian sentence for every code this feature can emit — the
 * input errors below and the service's own (`not_found`, `version_conflict`,
 * `not_draft`, `invalid_content`).
 *
 * The API answers a stable code plus an English diagnostic `detail` (which step,
 * which permission). The panel shows this sentence, never the code and never
 * the English: two tour-specific codes mean something different from their
 * namesakes elsewhere (`version_conflict` here is a tour revision, not a
 * knowledge article; `not_draft` explains why delete was refused).
 */
export const STUDIO_ERROR_TEXT: Record<string, string> = {
  bad_request: "درخواست نامعتبر بود.",
  unknown_page: "این صفحه در فهرست راهنمای سیستم نیست؛ صفحه را از فهرست انتخاب کنید.",
  route_mismatch: "نشانی صفحه با فهرست راهنما هم‌خوانی ندارد؛ صفحه را دوباره انتخاب کنید.",
  invalid_tour_key: "شناسهٔ تور باید با حرف کوچک انگلیسی یا رقم شروع شود و فقط حرف کوچک، رقم، نقطه، خط تیره و زیرخط داشته باشد.",
  baseline_key_reserved:
    "شناسه‌های آغازشده با baseline برای «معرفی خودکار» رزرو شده‌اند؛ شناسهٔ دیگری انتخاب کنید.",
  tour_key_owned_by_another_page:
    "این شناسه پیش‌تر برای تور صفحهٔ دیگری ثبت شده است؛ شناسهٔ دیگری انتخاب کنید.",
  invalid_title: `عنوان تور لازم است (حداکثر ${STUDIO_TITLE_MAX} نویسه).`,
  invalid_description: `توضیح تور از ${STUDIO_DESCRIPTION_MAX} نویسه بلندتر است؛ کوتاه‌ترش کنید.`,
  invalid_steps:
    "مرحله‌ها معتبر نیستند: هر مرحله شناسهٔ یکتا، عنوان و متن دارد، هایلایت فقط به لنگر ثبت‌شده اشاره می‌کند و تور با یک «توضیح» شروع می‌شود.",
  invalid_eligibility:
    "شرط دسترسی معتبر نیست؛ فقط دسترسی‌ها، صنف‌ها و گزینه‌های شناخته‌شدهٔ سیستم مجازند.",
  invalid_content: "این نسخه با صفحه‌ها و لنگرهای فعلی معتبر نیست؛ صفحه و لنگرها را بررسی کنید.",
  not_found: "این تور پیدا نشد؛ فهرست را تازه کنید.",
  version_conflict:
    "این تور هم‌زمان توسط فرد دیگری ذخیره شده است؛ نسخهٔ تازه را باز کنید و تغییرات را دوباره اعمال کنید.",
  not_draft: "فقط توری که هرگز منتشر نشده حذف می‌شود؛ برای تور منتشرشده «بایگانی» را بزنید.",
};

const PERMISSION_VALUES = new Set<string>(Object.values(PERMISSIONS));
const INDUSTRY_VALUES = new Set<string>(INDUSTRIES);
const ANCHOR_VALUES = new Set<string>(Object.values(TOUR_ANCHORS));
const INVENTORY_SYSTEMS = new Set<TourInventorySystem>(["perpetual", "periodic"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function invalid(error: StudioTourInputError, detail: string): StudioTourInvalid {
  return { ok: false, error, detail };
}

/**
 * Eligibility is the one field an editor can get subtly wrong, so it is
 * checked key by key: an unknown permission or trade must be a message now,
 * never a step that silently never matches a member.
 */
function parseEligibility(raw: unknown, path: string): { ok: true; value: TourEligibility } | StudioTourInvalid {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (!isRecord(raw)) return invalid("invalid_eligibility", `${path}: must be an object`);

  const known = new Set([
    "permissions",
    "withoutPermissions",
    "industries",
    "features",
    "withoutFeatures",
    "inventorySystem",
    "anyOf",
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) return invalid("invalid_eligibility", `${path}: unknown rule "${key}"`);
  }

  const value: {
    permissions?: Permission[];
    withoutPermissions?: Permission[];
    industries?: Industry[];
    features?: string[];
    withoutFeatures?: string[];
    inventorySystem?: TourInventorySystem;
    anyOf?: TourEligibility[];
  } = {};

  for (const key of ["permissions", "withoutPermissions"] as const) {
    const list = raw[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return invalid("invalid_eligibility", `${path}.${key}: must be an array`);
    const permissions: Permission[] = [];
    for (const entry of list) {
      if (typeof entry !== "string" || !PERMISSION_VALUES.has(entry)) {
        return invalid("invalid_eligibility", `${path}.${key}: unknown permission "${String(entry)}"`);
      }
      permissions.push(entry as Permission);
    }
    value[key] = permissions;
  }

  if (raw.industries !== undefined) {
    if (!Array.isArray(raw.industries)) {
      return invalid("invalid_eligibility", `${path}.industries: must be an array`);
    }
    const industries: Industry[] = [];
    for (const entry of raw.industries) {
      if (typeof entry !== "string" || !INDUSTRY_VALUES.has(entry)) {
        return invalid("invalid_eligibility", `${path}.industries: unknown trade "${String(entry)}"`);
      }
      industries.push(entry as Industry);
    }
    value.industries = industries;
  }

  for (const key of ["features", "withoutFeatures"] as const) {
    const list = raw[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return invalid("invalid_eligibility", `${path}.${key}: must be an array`);
    const features: string[] = [];
    for (const entry of list) {
      if (typeof entry !== "string" || !FEATURE_NAME.test(entry)) {
        return invalid("invalid_eligibility", `${path}.${key}: invalid feature flag "${String(entry)}"`);
      }
      features.push(entry);
    }
    value[key] = features;
  }

  if (raw.inventorySystem !== undefined) {
    if (
      typeof raw.inventorySystem !== "string" ||
      !INVENTORY_SYSTEMS.has(raw.inventorySystem as TourInventorySystem)
    ) {
      return invalid("invalid_eligibility", `${path}.inventorySystem: must be perpetual or periodic`);
    }
    value.inventorySystem = raw.inventorySystem as TourInventorySystem;
  }

  if (raw.anyOf !== undefined) {
    if (!Array.isArray(raw.anyOf) || raw.anyOf.length === 0 || raw.anyOf.length > 8) {
      return invalid("invalid_eligibility", `${path}.anyOf: needs 1–8 alternatives`);
    }
    const alternatives: TourEligibility[] = [];
    for (const [index, alternative] of raw.anyOf.entries()) {
      const parsed = parseEligibility(alternative, `${path}.anyOf[${index}]`);
      if (!parsed.ok) return parsed;
      alternatives.push(parsed.value);
    }
    value.anyOf = alternatives;
  }

  return { ok: true, value: value as TourEligibility };
}

function parseSteps(raw: unknown): { ok: true; steps: TourStep[] } | StudioTourInvalid {
  if (!Array.isArray(raw) || raw.length === 0) {
    return invalid("invalid_steps", "a tour needs at least one step");
  }
  if (raw.length > MAX_TOUR_STEPS) {
    return invalid("invalid_steps", `a tour may have at most ${MAX_TOUR_STEPS} steps`);
  }

  const steps: TourStep[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const at = `step ${index + 1}`;
    if (!isRecord(entry)) return invalid("invalid_steps", `${at}: must be an object`);

    const id = text(entry.id);
    if (!STEP_ID.test(id)) return invalid("invalid_steps", `${at}: invalid step id "${id}"`);
    if (ids.has(id)) return invalid("invalid_steps", `${at}: duplicate step id "${id}"`);
    ids.add(id);

    const kind = entry.kind;
    if (kind !== "explain" && kind !== "spotlight") {
      return invalid("invalid_steps", `${at}: kind must be explain or spotlight`);
    }

    const title = text(entry.title);
    if (!title || title.length > STUDIO_STEP_TITLE_MAX) {
      return invalid("invalid_steps", `${at}: title is required (max ${STUDIO_STEP_TITLE_MAX} characters)`);
    }
    const body = text(entry.body);
    if (!body || body.length > STUDIO_STEP_BODY_MAX) {
      return invalid("invalid_steps", `${at}: body is required (max ${STUDIO_STEP_BODY_MAX} characters)`);
    }

    let anchor: (typeof TOUR_ANCHORS)[keyof typeof TOUR_ANCHORS] | undefined;
    if (kind === "spotlight") {
      const rawAnchor = text(entry.anchor);
      if (!rawAnchor) return invalid("invalid_steps", `${at}: a spotlight needs an anchor`);
      if (!ANCHOR_VALUES.has(rawAnchor)) {
        return invalid(
          "invalid_steps",
          `${at}: anchor "${rawAnchor}" is not registered on any component`,
        );
      }
      anchor = rawAnchor as (typeof TOUR_ANCHORS)[keyof typeof TOUR_ANCHORS];
    } else if (entry.anchor !== undefined && entry.anchor !== null && text(entry.anchor) !== "") {
      // An explanation never names an anchor: that is how an editor says
      // "describe this, do not point at a control".
      return invalid("invalid_steps", `${at}: an explanation must not name an anchor`);
    }

    const eligibility = parseEligibility(entry.eligibility, at);
    if (!eligibility.ok) return eligibility;

    steps.push({
      id,
      kind,
      ...(anchor ? { anchor } : {}),
      title,
      body,
      ...(Object.keys(eligibility.value).length > 0 ? { eligibility: eligibility.value } : {}),
    });
  }

  if (steps[0].kind !== "explain") {
    return invalid("invalid_steps", "the first step must be an explanation, not a spotlight");
  }
  return { ok: true, steps };
}

/**
 * Validates one authoring payload. The console sends the page **key**, never an
 * arbitrary route: the route is read from the registry, so a tour cannot be
 * addressed at a page it does not belong to (or at a legacy `/dashboard/…`
 * address that no longer exists).
 */
export function parseStudioTourInput(body: unknown): StudioTourParseResult {
  if (!isRecord(body)) return invalid("bad_request", "body must be an object");

  const tourKey = text(body.tourKey);
  if (!TOUR_KEY.test(tourKey)) {
    return invalid("invalid_tour_key", "a tour id is lowercase letters, digits, dots and dashes");
  }
  if (tourKey.startsWith(BASELINE_PREFIX)) {
    return invalid("baseline_key_reserved", `ids starting with "${BASELINE_PREFIX}" are reserved`);
  }

  const pageKey = text(body.pageKey);
  const page = knowledgePage(pageKey);
  if (!page) return invalid("unknown_page", "this page is not in the Knowledge registry");

  const route = text(body.route);
  if (route && route !== page.route) {
    return invalid("route_mismatch", `this page runs at ${page.route}`);
  }

  // Reusing a code tour's id is how an authored definition replaces a shipped
  // one — but only on that tour's own page: an id is what member progress is
  // keyed on, so it must not start pointing at a different screen.
  const codeTour = tourById(tourKey);
  if (codeTour && codeTour.pageKey !== page.key) {
    return invalid(
      "tour_key_owned_by_another_page",
      `"${tourKey}" already identifies a tour of ${codeTour.route}`,
    );
  }

  const title = text(body.title);
  if (!title || title.length > STUDIO_TITLE_MAX) {
    return invalid("invalid_title", `a title is required (max ${STUDIO_TITLE_MAX} characters)`);
  }
  const description = text(body.description);
  if (description.length > STUDIO_DESCRIPTION_MAX) {
    return invalid("invalid_description", `the description is longer than ${STUDIO_DESCRIPTION_MAX} characters`);
  }

  const steps = parseSteps(body.steps);
  if (!steps.ok) return steps;

  const eligibility = parseEligibility(body.eligibility, "eligibility");
  if (!eligibility.ok) return eligibility;

  return {
    ok: true,
    input: {
      tourKey,
      pageKey: page.key,
      route: page.route,
      title,
      description,
      eligibility: eligibility.value,
      steps: steps.steps,
    },
  };
}

/** The catalogue shape the runtime and the member API already speak. */
export function studioTourDefinition(content: StudioTourContent, version: number): TourDefinition {
  return {
    id: content.tourKey,
    version,
    pageKey: content.pageKey,
    route: content.route,
    title: content.title,
    description: content.description,
    eligibility: content.eligibility,
    steps: content.steps,
  };
}

/**
 * Whether a **stored** tour may be served. The write path already validated it,
 * but the row could have been edited by hand or left behind by a page that has
 * since been renamed: rather than serve a tour whose anchor no longer exists —
 * or that points at a route the registry no longer knows — the member-side
 * lookup skips it and the console shows it as needing attention.
 */
export function isServableStudioTour(content: StudioTourContent): boolean {
  const page = knowledgePage(content.pageKey);
  if (!page || page.route !== content.route) return false;
  return validateTours([studioTourDefinition(content, 1)]).length === 0;
}

/**
 * Published tours win by id: a Studio tour replaces a code tour with the same
 * key (that is how a reviewed definition is edited without a deployment) and
 * otherwise sits beside it, so the page's own catalogue still answers. The
 * result keeps the catalogue's order and appends the new tours, so the primary
 * tour the modal shows does not jump around when one more is published.
 */
export function mergePublishedTours(
  codeTours: readonly TourDefinition[],
  published: readonly TourDefinition[],
): TourDefinition[] {
  if (published.length === 0) return [...codeTours];
  const byId = new Map(published.map((tour) => [tour.id, tour]));
  const merged = codeTours.map((tour) => byId.get(tour.id) ?? tour);
  const codeIds = new Set(codeTours.map((tour) => tour.id));
  for (const tour of published) {
    if (!codeIds.has(tour.id)) merged.push(tour);
  }
  return merged;
}
