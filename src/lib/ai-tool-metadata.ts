/**
 * Issue #1546 Phase 2 — server-side metadata for the assistant's tool catalogue.
 *
 * The model-facing schemas still live in `ai.ts`; this file does not declare a
 * second copy of any tool. It attaches the facts the selector needs to the
 * tool's existing name:
 *
 *   - the app and section that own it,
 *   - the task lenses it belongs to,
 *   - the permission the execute path already requires,
 *   - the feature / industry / runtime dependencies that must exist for the
 *     tool to be relevant.
 *
 * `TOOL_GROUP_MAP` remains the section source of truth and
 * `AI_TOOL_PERMISSION_MAP` remains the permission source of truth; both are
 * reused rather than restated. A tool with no section entry is still handled by
 * the routing fallback (kept), and a tool with no permission entry is denied by
 * the existing fail-closed capability filter.
 *
 * Framework-free: no `db`, no `next`, no provider.
 */
import type { AppKey } from "./apps";
import type { AiTaskFeatureKey, AiTaskId } from "./ai-tasks";
import type { Permission } from "./permissions";
import { aiToolPermission } from "./ai-capabilities";
import { toolGroupOf, type ToolGroup } from "./ai-tool-routing";

/**
 * A dependency that is not a permission but still decides whether a tool can
 * do useful work in this turn. None of these is authorization; the executor
 * re-checks everything they describe.
 */
export type AiToolDependency =
  | "workspace"
  | "retrieval"
  | "browserNavigation"
  | "attachment"
  | "branchWide"
  | "aecIndustry"
  | "externalMcp";

export interface AiToolGroupMetadata {
  group: ToolGroup;
  /** The owning app, or null for the shared/settings groups. */
  app: AppKey | null;
  /** Task lenses this section serves. */
  tasks: readonly AiTaskId[];
  /** Any-of feature requirements; empty means no extra feature gate. */
  features: readonly AiTaskFeatureKey[];
  /** Runtime/context dependencies; empty means always relevant. */
  dependencies: readonly AiToolDependency[];
}

const GROUP_METADATA: Record<ToolGroup, AiToolGroupMetadata> = {
  shared: { group: "shared", app: null, tasks: [], features: [], dependencies: [] },
  settings: { group: "settings", app: null, tasks: [], features: [], dependencies: [] },
  "accounting:sales": {
    group: "accounting:sales",
    app: "accounting",
    tasks: ["sales", "menu", "delivery", "split"],
    features: [],
    dependencies: [],
  },
  "accounting:inventory": {
    group: "accounting:inventory",
    app: "accounting",
    tasks: ["inventory", "menu"],
    // Retail trades can have `stock` without the F&B `inventory` flag.
    features: ["inventory", "stock"],
    dependencies: [],
  },
  "accounting:ledger": {
    group: "accounting:ledger",
    app: "accounting",
    tasks: ["accounting"],
    features: ["ledger", "accounting"],
    dependencies: [],
  },
  "accounting:payroll": {
    group: "accounting:payroll",
    app: "accounting",
    tasks: ["operations"],
    features: ["ledger", "accounting"],
    dependencies: [],
  },
  "accounting:projects": {
    group: "accounting:projects",
    // AEC reads are construction-only (see `runAecReadTool`); the Workspace
    // eligibility check is the other half of the dependency.
    app: "accounting",
    tasks: ["operations"],
    features: [],
    dependencies: ["workspace", "aecIndustry"],
  },
  "accounting:workspace": {
    group: "accounting:workspace",
    app: "accounting",
    tasks: ["operations"],
    features: ["workspace"],
    dependencies: ["workspace"],
  },
  "crm:records": {
    group: "crm:records",
    app: "crm",
    tasks: ["customers"],
    features: ["crm"],
    dependencies: [],
  },
  "growth:campaigns": {
    group: "growth:campaigns",
    app: "growth",
    tasks: ["marketing"],
    features: ["growth"],
    dependencies: [],
  },
  "website:content": {
    group: "website:content",
    app: "website",
    tasks: [],
    features: ["website"],
    dependencies: [],
  },
};

interface ToolMetadataOverride {
  tasks?: readonly AiTaskId[];
  features?: readonly AiTaskFeatureKey[];
  dependencies?: readonly AiToolDependency[];
}

/**
 * Per-tool exceptions where the section's default is not the tool's own
 * dependency. These are data, not special cases in the selector.
 */
const TOOL_OVERRIDES: Readonly<Record<string, ToolMetadataOverride>> = {
  // Business-wide aggregation is only meaningful when the member can see more
  // than the active branch. The permission map still gates it independently.
  get_branch_comparison: { dependencies: ["branchWide"] },
  // Declared only when the managed knowledge integration is ready, and only
  // useful when retrieval was actually offered.
  search_business_knowledge: { dependencies: ["retrieval"] },
  // UI navigation tools exist only for the tenant browser surface.
  find_dashboard_feature: { dependencies: ["browserNavigation"] },
  navigate_to_feature: { dependencies: ["browserNavigation"] },
  get_feature_details: { dependencies: ["browserNavigation"] },
  start_guided_tour: { dependencies: ["browserNavigation"] },
  // The receipt draft is only declared for a turn carrying an attachment.
  draft_expense_from_receipt: { dependencies: ["attachment"] },
  // Hospitality sub-features inside the broad sales section.
  get_reservation_conflicts: { features: ["reservations"] },
  get_table_turnover_rate: { features: ["reservations"] },
  get_courier_performance: { features: ["delivery"] },
};

export interface AiToolMetadata {
  name: string;
  group: ToolGroup | null;
  app: AppKey | null;
  tasks: readonly AiTaskId[];
  features: readonly AiTaskFeatureKey[];
  dependencies: readonly AiToolDependency[];
  /** The existing execute-time permission, or null for protocol/external tools. */
  permission: Permission | null;
}

function appForGroup(group: ToolGroup | null): AppKey | null {
  if (!group || !group.includes(":")) return null;
  return group.split(":")[0] as AppKey;
}

/** The metadata for one tool name. Unknown tools stay unclassified, never denied here. */
export function toolMetadata(name: string): AiToolMetadata {
  const group = toolGroupOf(name);
  const base = group ? GROUP_METADATA[group] : null;
  const override = TOOL_OVERRIDES[name];
  const dependencySet = new Set<AiToolDependency>(base?.dependencies ?? []);
  for (const dependency of override?.dependencies ?? []) dependencySet.add(dependency);
  return {
    name,
    group,
    app: base?.app ?? appForGroup(group),
    tasks: override?.tasks ?? base?.tasks ?? [],
    features: override?.features ?? base?.features ?? [],
    dependencies: [...dependencySet],
    permission: aiToolPermission(name),
  };
}

/** Every group's declared metadata, for diagnostics and catalog tests. */
export function toolGroupMetadata(): readonly AiToolGroupMetadata[] {
  return Object.values(GROUP_METADATA);
}
