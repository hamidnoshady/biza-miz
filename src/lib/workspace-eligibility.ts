/**
 * Issue #1110 — is «میز کار من» (My Workspace) applicable to this business type?
 *
 * My Workspace is a project/execution work area, not a fifth app and not a
 * universal entitlement. A business whose work is orders, tables, stock or a
 * sales counter has no execution projects to manage, so the whole area must not
 * exist for it — in the navigation, in the API, in the assistant, or in a deep
 * link.
 *
 * This module is the ONE answer to that question. It is framework-free (no
 * `db`, no `next`, no React) so the sidebar, the server guards, the AI prompt
 * builder and the unit tests all read the same table.
 *
 * ## The rules
 *
 *   * **A default per industry, exhaustive over `INDUSTRIES`.** The record
 *     below is typed `Record<Industry, boolean>`, so adding an industry to
 *     `industries.ts` is a TypeScript error until it gets an explicit decision.
 *     Never infer eligibility from a module list, an enabled app or the mere
 *     presence of old `ai_projects` rows.
 *   * **Unknown fails closed.** A value that is not one of `INDUSTRIES` is
 *     ineligible with `BUSINESS_TYPE_UNSUPPORTED`, even if it looks familiar.
 *   * **An override is explicit and audited, never inferred.** Product policy
 *     does not currently approve blanket business-level overrides, so no
 *     database source reads one. The resolver accepts an override object for a
 *     future reviewed surface, and only an `approved: true` override can change
 *     the industry's default — in either direction.
 *
 * This file answers **industry applicability only**. Service activation,
 * deployment capability and effective permissions are separate axes in
 * `workspace-access.ts`; they are intersected with this answer, never
 * substituted for it.
 */
import { INDUSTRIES, isIndustry, type Industry } from "./industries";

/**
 * The default eligibility of every business type.
 *
 * AEC and the two service trades sell work as projects (studies, drawing sets,
 * supervision periods, client engagements, campaigns, retainers), so My
 * Workspace is their operational centre. Restaurants, shops, wholesalers and
 * dealerships sell goods or serve guests; their work views live in Accounting,
 * Growth and CRM, and a project portal is not an affordance they need.
 */
export const WORKSPACE_INDUSTRY_DEFAULTS: Record<Industry, boolean> = {
  architecture_construction: true,
  service_saas: true,
  advertising_agency: true,
  food_service: false,
  jewelry: false,
  watch: false,
  accessories: false,
  cosmetics: false,
  wholesale: false,
  tools_fittings: false,
  haberdashery: false,
  automotive: false,
  // Issue #1567 — a fashion shop's work lives at the counter, the stockroom
  // and the products workspace, exactly like the other retail trades; My
  // Workspace (projects, briefs, approvals) is not an affordance it needs, so
  // the industry default is false. Any future tailoring/custom-order wave
  // must go through this same explicit, reviewed decision rather than being
  // inferred from a module list.
  fashion_apparel: false,
};

/**
 * The industries eligible by default. Derived from the record above so the two
 * can never disagree.
 */
export const WORKSPACE_ELIGIBLE_INDUSTRIES: readonly Industry[] = INDUSTRIES.filter(
  (industry) => WORKSPACE_INDUSTRY_DEFAULTS[industry],
);

/**
 * A reviewed, tenant-scoped exception. `approved` is the audit switch: an
 * unapproved draft is ignored entirely, so a half-written row can never widen
 * access.
 */
export interface WorkspaceEligibilityOverride {
  /** True only after the platform's review/approval step. */
  approved: boolean;
  /** The reviewed decision. */
  eligible: boolean;
  /** Why, in the reviewer's words — shown in the audit trail. */
  rationale?: string;
  /** The platform user who approved it. */
  approvedBy?: string;
  /** ISO instant of approval. */
  approvedAt?: string;
}

export type WorkspaceIndustryEligibilityReason =
  | "INDUSTRY_ELIGIBLE"
  | "INDUSTRY_INELIGIBLE"
  | "BUSINESS_TYPE_UNSUPPORTED"
  | "APPROVED_OVERRIDE_ELIGIBLE"
  | "APPROVED_OVERRIDE_INELIGIBLE";

export interface WorkspaceIndustryEligibility {
  eligible: boolean;
  reason: WorkspaceIndustryEligibilityReason;
  /** The validated industry, or null for an unknown value. */
  industry: Industry | null;
  source: "industry" | "approved_override" | "none";
}

/**
 * Resolve industry applicability. Unknown industries fail closed; an override
 * only counts when it has been approved.
 */
export function resolveWorkspaceIndustryEligibility(
  industry: Industry | string | null | undefined,
  override?: WorkspaceEligibilityOverride | null,
): WorkspaceIndustryEligibility {
  if (!industry || !isIndustry(industry)) {
    return {
      eligible: false,
      reason: "BUSINESS_TYPE_UNSUPPORTED",
      industry: null,
      source: "none",
    };
  }

  if (override?.approved === true) {
    return {
      eligible: override.eligible === true,
      reason: override.eligible
        ? "APPROVED_OVERRIDE_ELIGIBLE"
        : "APPROVED_OVERRIDE_INELIGIBLE",
      industry,
      source: "approved_override",
    };
  }

  const eligible = WORKSPACE_INDUSTRY_DEFAULTS[industry] === true;
  return {
    eligible,
    reason: eligible ? "INDUSTRY_ELIGIBLE" : "INDUSTRY_INELIGIBLE",
    industry,
    source: "industry",
  };
}

/** Convenience for callers that only need the boolean. */
export function isWorkspaceEligibleIndustry(
  industry: Industry | string | null | undefined,
  override?: WorkspaceEligibilityOverride | null,
): boolean {
  return resolveWorkspaceIndustryEligibility(industry, override).eligible;
}

/**
 * Knowledge/article section keys that describe My Workspace.
 *
 * Stored in `knowledge_articles.section_keys` and the legacy
 * `knowledge_base_entries.section`. The assistant's retrieval and the learning
 * centre both use this list to keep these guides out of a business that does
 * not have the feature.
 */
export const WORKSPACE_KNOWLEDGE_SECTION_KEYS = [
  "projects",
  "page:/workspace",
  "page:/workspace/projects",
] as const;

export function isWorkspaceKnowledgeSection(key: string): boolean {
  return (WORKSPACE_KNOWLEDGE_SECTION_KEYS as readonly string[]).includes(key);
}
