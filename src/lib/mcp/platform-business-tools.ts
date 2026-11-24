/**
 * Issue #1430 — argument handling for the Business Control Center's read-only
 * MCP tools.
 *
 * The directory itself is *not* re-implemented here: valid arguments are
 * translated into the console's own `BusinessQuery` and handed to
 * `queryBusinesses`, so the MCP caller sees exactly the rows, order and totals
 * the console's server-backed directory returns (the directory page and
 * `/api/platform/businesses` share that service too).
 *
 * What this module adds is the strict half the console can afford to be
 * tolerant about: a web URL silently drops an unknown `industry`, while a
 * machine caller needs to be told it typo'd one. Rejection is explicit and
 * never widens a filter (an invalid filter must not degrade to "show
 * everything").
 *
 * Framework-free on purpose: pure functions only, no database import, so the
 * contract is unit-testable without a Postgres.
 */
import {
  BUSINESS_SORT_VALUES,
  isBusinessSortValue,
  type SortDirection,
} from "../business-sort";
import { INDUSTRIES, isIndustry } from "../industries";
import type { OwnerProfile } from "../platform-owner-profile";
import type { BusinessQuery, BusinessStatus } from "../platform-service";

/**
 * A bad argument, as opposed to a failed operation. `callPlatformMcpTool`
 * answers these as a clear `invalid_arguments` result (and audits the failed
 * call) instead of letting them surface as an opaque 500.
 */
export class PlatformMcpInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformMcpInputError";
  }
}

/** The console's own options: `queryBusinesses` clamps to the same ceiling. */
export const BUSINESS_DIRECTORY_MAX_PAGE_SIZE = 100;
/** The console's default page (`BusinessQuery.pageSize` in queryBusinesses). */
export const BUSINESS_DIRECTORY_DEFAULT_PAGE_SIZE = 20;
/**
 * Deep-pagination guard. A page this deep would be ~20 million rows at the
 * default size — far past any real directory — and bounding it keeps the
 * page→offset arithmetic inside safe-integer range instead of handing the
 * database an imprecise float.
 */
export const BUSINESS_DIRECTORY_MAX_PAGE = 1_000_000;
/** The deepest row offset `page ≤ MAX_PAGE` can express. */
export const BUSINESS_DIRECTORY_MAX_OFFSET =
  (BUSINESS_DIRECTORY_MAX_PAGE - 1) * BUSINESS_DIRECTORY_MAX_PAGE_SIZE;

const BUSINESS_STATUSES: BusinessStatus[] = ["active", "suspended", "archived"];
const ACTIVITY_FILTERS = ["active", "idle"] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The wire shape of the tool's arguments. Deliberately `unknown` per field:
 * JSON-RPC gives us whatever the client sent, and every field is validated
 * here rather than trusted from the declared schema.
 */
export interface BusinessDirectoryArguments {
  search?: unknown;
  status?: unknown;
  plan?: unknown;
  industry?: unknown;
  createdFrom?: unknown;
  createdTo?: unknown;
  activity?: unknown;
  sort?: unknown;
  sortDir?: unknown;
  page?: unknown;
  pageSize?: unknown;
  /** Legacy pagination aliases kept for existing connectors. */
  limit?: unknown;
  offset?: unknown;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new PlatformMcpInputError(`${field} must be a string.`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function optionalInteger(
  value: unknown,
  field: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PlatformMcpInputError(`${field} must be an integer.`);
  }
  if (value < min || value > max) {
    throw new PlatformMcpInputError(`${field} must be between ${min} and ${max}.`);
  }
  return value;
}

/**
 * A calendar date in the wire format the console sends from its Shamsi
 * picker: `YYYY-MM-DD` (Gregorian storage; the console renders it as Shamsi).
 * Bounded to a real date so `2026-02-30` cannot silently become March.
 */
function optionalIsoDate(value: unknown, field: string): string | undefined {
  const text = optionalText(value, field);
  if (text === undefined) return undefined;
  if (!ISO_DATE.test(text)) {
    throw new PlatformMcpInputError(`${field} must be an ISO date (YYYY-MM-DD).`);
  }
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new PlatformMcpInputError(`${field} is not a real calendar date.`);
  }
  return text;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new PlatformMcpInputError(`${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

/**
 * Translate the tool's arguments into the console's canonical query.
 *
 * Invalid values are refused rather than ignored: silently dropping an
 * `industry` typo would hand the operator a wider directory than they asked
 * for, which on a tenant list is the wrong direction to fail.
 */
export function parseBusinessDirectoryQuery(args: BusinessDirectoryArguments): BusinessQuery {
  const search = optionalText(args.search, "search");
  const statusText = optionalText(args.status, "status");
  const plan = optionalText(args.plan, "plan");
  const industryText = optionalText(args.industry, "industry");
  const activityText = optionalText(args.activity, "activity");
  const sortText = optionalText(args.sort, "sort");
  const sortDirText = optionalText(args.sortDir, "sortDir");
  const createdFrom = optionalIsoDate(args.createdFrom, "createdFrom");
  const createdTo = optionalIsoDate(args.createdTo, "createdTo");

  if (createdFrom && createdTo && createdFrom > createdTo) {
    throw new PlatformMcpInputError("createdFrom must be on or before createdTo.");
  }

  const pageArg = optionalInteger(args.page, "page", 1, BUSINESS_DIRECTORY_MAX_PAGE);
  const pageSizeArg = optionalInteger(
    args.pageSize,
    "pageSize",
    1,
    BUSINESS_DIRECTORY_MAX_PAGE_SIZE,
  );
  const limit = optionalInteger(args.limit, "limit", 1, BUSINESS_DIRECTORY_MAX_PAGE_SIZE);
  const offset = optionalInteger(args.offset, "offset", 0, BUSINESS_DIRECTORY_MAX_OFFSET);

  if ((pageArg !== undefined || pageSizeArg !== undefined) && (limit !== undefined || offset !== undefined)) {
    throw new PlatformMcpInputError(
      "Use page/pageSize or the legacy limit/offset pair, not both.",
    );
  }

  // The console's `BusinessQuery` is page-based. An offset is translated with
  // the same arithmetic the tool used before this change, so an existing
  // connector's limit/offset call returns the same rows.
  const pageSize = pageSizeArg ?? limit ?? BUSINESS_DIRECTORY_DEFAULT_PAGE_SIZE;
  const page = pageArg ?? (offset === undefined ? 1 : Math.floor(offset / pageSize) + 1);

  const query: BusinessQuery = {
    search,
    status: statusText ? oneOf(statusText, BUSINESS_STATUSES, "status") : undefined,
    plan,
    industry: industryText ? oneOf(industryText, INDUSTRIES, "industry") : undefined,
    createdFrom,
    createdTo,
    activity: activityText ? oneOf(activityText, ACTIVITY_FILTERS, "activity") : undefined,
    sort: sortText ? oneOf(sortText, BUSINESS_SORT_VALUES, "sort") : undefined,
    sortDir: sortDirText ? oneOf(sortDirText, ["asc", "desc"] as const, "sortDir") : undefined,
    page,
    pageSize,
  };
  return query;
}

/** The declared JSON schema's enums, exported so the registry and tests cannot drift. */
export const BUSINESS_DIRECTORY_FILTER_ENUMS = {
  status: [...BUSINESS_STATUSES],
  industry: [...INDUSTRIES],
  activity: [...ACTIVITY_FILTERS],
  sort: [...BUSINESS_SORT_VALUES],
  sortDir: ["asc", "desc"] as SortDirection[],
} as const;

/**
 * One owner/manager profile, as this credential is allowed to see it.
 *
 * The console DTO includes `otherBusinesses` — the names of the person's other
 * memberships, which the console shows because an operator editing the login
 * needs to know the change reaches them. An MCP credential minted against a
 * fixed business list must not learn about tenants outside that list, so the
 * cross-business hints are filtered to the credential's own scope. Everything
 * else is the same DTO the console route returns; `membershipCount` stays the
 * identity's true count because it describes the person, not the other tenant.
 */
export function scopeOwnerProfileForCredential(
  profile: OwnerProfile,
  businessIds: string[] | null,
): OwnerProfile {
  if (businessIds === null) return profile;
  const allowed = new Set(businessIds);
  if (profile.otherBusinesses.every((business) => allowed.has(business.id))) return profile;
  return {
    ...profile,
    otherBusinesses: profile.otherBusinesses.filter((business) => allowed.has(business.id)),
  };
}

/** Validate and normalize the optional membership selector. */
export function parseMembershipId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = optionalText(value, "membershipId");
  if (text === undefined) {
    throw new PlatformMcpInputError("membershipId must be a non-empty string when provided.");
  }
  return text;
}
