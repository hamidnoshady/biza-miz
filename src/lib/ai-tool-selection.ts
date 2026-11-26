/**
 * Issue #1546 Phase 2 — context-aware selection of the assistant's active tools.
 *
 * This is the one selector used by the tenant chat loop and (through
 * `sdkToolsFromSelection`) by the shared Vercel AI SDK adapter. It answers a
 * single question:
 *
 *   "Which declarations from the existing catalogue should this turn be allowed
 *    to see, given what the server already knows about the member, the tenant,
 *    and the page they are on?"
 *
 * It never calls a model, never reaches a provider, and never creates a schema:
 * the `OpenAiTool[]` passed in is the catalogue `toolDefinitions()` produced.
 * The selection can only remove entries from that list.
 *
 * Authorization is deliberately separate. Permission filtering is applied here
 * for diagnostics (so an excluded group has a reason), and `runAgentTurn` still
 * calls `filterAiToolsByPermissions` afterwards. Every executor then re-checks
 * tenant, permission, branch/project and approval state when the tool runs.
 */
import type { AgentMode, OpenAiTool } from "./ai";
import type { AiTaskFeatureKey } from "./ai-tasks";
import type { AppKey } from "./apps";
import type { Permission } from "./permissions";
import { canUseAiTool } from "./ai-capabilities";
import { estimateTokens } from "./ai-billing";
import {
  isAlwaysOnTool,
  groupsForTask,
  groupsMentionedIn,
  routeTools,
  toolGroupOf,
  type ToolGroup,
} from "./ai-tool-routing";
import { toolMetadata, type AiToolDependency } from "./ai-tool-metadata";

const PROTOCOL_TOOLS = new Set(["propose_action", "request_input"]);

export type AiToolSelectionSource =
  | "agent_focus"
  | "explicit_focus"
  | "workspace_focus"
  | "route_hint"
  | "message"
  | "task"
  | "no_context";

export type AiToolExclusionReason =
  | "not_selected"
  | "app_disabled"
  | "feature_disabled"
  | "dependency_unmet"
  | "agent_allowlist"
  | "permission";

export type AiToolInclusionReason =
  | "selected"
  | "always_on"
  | "shared"
  | "unclassified"
  | "protocol";

export interface AiToolGroupCount {
  group: string;
  count: number;
  reason: AiToolInclusionReason | AiToolExclusionReason;
}

/**
 * Everything the selector may use. Every field is server-resolved except the
 * two explicitly marked client hints. A hint can only narrow; the permission
 * filter and the execute-time checks remain authoritative.
 */
export interface AiToolSelectionContext {
  /**
   * The assistant surface. Context-aware selection belongs to the tenant
   * dashboard; floor/wizard/platform/proactive surfaces keep their own fixed
   * catalogues and are returned untouched.
   */
  mode?: AgentMode;
  /** Client hint: the app the member explicitly focused, already an AppKey. */
  appFocus?: AppKey | null;
  /** Client hint: the tenant page the compact assistant is docked beside. */
  routeApp?: AppKey | null;
  /** Server-resolved: the system agent assignment's own app focus. */
  agentApp?: AppKey | null;
  /** Server-resolved: the turn is for the Workspace/project area. */
  workspaceFocus?: boolean;
  /** The existing task lens (`AiTaskId`). */
  task?: string | null;
  /** The member's latest instruction, used only for section keyword hints. */
  message?: string | null;
  /** Effective permissions resolved for this request. */
  permissions?: ReadonlySet<Permission> | null;
  /** Apps the business can currently use; null/undefined means "not resolved". */
  enabledApps?: readonly AppKey[] | null;
  /** Resolved tenant feature map; null/undefined means "not resolved". */
  enabledFeatures?: Partial<Record<AiTaskFeatureKey, boolean>> | null;
  /** Current business industry, used only for the AEC-only project tools. */
  industry?: string | null;
  /** Workspace availability resolved by `workspaceAccessFor`. */
  workspaceAvailable?: boolean;
  /** The conversation belongs to a project. */
  projectScoped?: boolean;
  /** The member's location scope (`all` / `home` / `selected` / `none`). */
  branchScope?: string | null;
  /** A location was resolved for this turn (never the id itself). */
  locationScoped?: boolean;
  /** The assigned agent's read-tool allowlist, already server-resolved. */
  agentAllowedTools?: readonly string[] | null;
  /** Managed retrieval and browser navigation were offered this turn. */
  retrieval?: boolean;
  browserNavigation?: boolean;
  /** An attachment was attached to this turn. */
  hasAttachment?: boolean;
}

export interface AiToolSelectionInput extends AiToolSelectionContext {
  catalogue: readonly OpenAiTool[];
}

/**
 * Sanitized selection diagnostics. There is deliberately no field for a
 * prompt, message, tool argument, business name, user id or credential.
 */
export interface AiToolSelectionDiagnostics {
  source: AiToolSelectionSource;
  focusedApp: string | null;
  routeApp: string | null;
  agentApp: string | null;
  apps: string[];
  /** True only when the selector fell back to the full catalogue with no app context. */
  ambiguous: boolean;
  projectScoped: boolean;
  locationScoped: boolean;
  branchScope: string | null;
  agentScoped: boolean;
  included: AiToolGroupCount[];
  excluded: AiToolGroupCount[];
  catalogueToolCount: number;
  catalogueSchemaTokens: number;
  toolCount: number;
  schemaTokens: number;
  /** Rounded percentage of schema tokens removed, 0–100. */
  reductionPct: number;
}

export interface AiToolSelection {
  tools: OpenAiTool[];
  diagnostics: AiToolSelectionDiagnostics;
}

function usableApp(app: AppKey | null | undefined, enabledApps: readonly AppKey[] | null | undefined): AppKey | null {
  if (!app) return null;
  if (enabledApps && !enabledApps.includes(app)) return null;
  return app;
}

function appForGroup(group: ToolGroup): AppKey | null {
  return group.includes(":") ? (group.split(":")[0] as AppKey) : null;
}

function appsForGroups(groups: readonly ToolGroup[]): AppKey[] {
  const apps = new Set<AppKey>();
  for (const group of groups) {
    const app = appForGroup(group);
    if (app) apps.add(app);
  }
  return [...apps];
}

function dependencyUnmet(dependency: AiToolDependency, input: AiToolSelectionContext): boolean {
  switch (dependency) {
    case "workspace":
      // Undefined means "not resolved"; only an explicit false removes tools.
      return input.workspaceAvailable === false;
    case "retrieval":
      return input.retrieval === false;
    case "browserNavigation":
      return input.browserNavigation === false;
    case "attachment":
      return input.hasAttachment === false;
    case "branchWide":
      // A branch-scoped member cannot usefully aggregate every branch. The
      // permission map may already refuse it; this keeps the schema out too.
      return input.branchScope != null && input.branchScope !== "all";
    case "aecIndustry":
      // The AEC reads refuse a non-AEC business at execution time; keep the
      // 5k-token group out of its prompt as well. Unknown industry stays open.
      return input.industry != null && input.industry !== "architecture_construction";
    case "externalMcp":
      return false;
    default:
      return false;
  }
}

function groupKeyFor(name: string): string {
  if (PROTOCOL_TOOLS.has(name)) return "protocol";
  const group = toolGroupOf(name);
  if (group) return group;
  if (name.startsWith("mcp_")) return "external_mcp";
  return "unclassified";
}

/**
 * Pure, deterministic selection. No model call, no I/O, no schema construction.
 */
export function selectAiTools(input: AiToolSelectionInput): AiToolSelection {
  const catalogue = input.catalogue;
  const names = catalogue.map((tool) => tool.function.name);

  // Non-dashboard surfaces have their own fixed, mode-scoped catalogues. Tool
  // selection is a tenant-dashboard concern; returning them untouched keeps
  // floor/wizard/platform/proactive behaviour byte-for-byte unchanged.
  if (input.mode && input.mode !== "dashboard") {
    const schemaTokens = estimateTokens(JSON.stringify(catalogue));
    const counts = new Map<string, AiToolGroupCount>();
    for (const name of names) {
      const group = groupKeyFor(name);
      const row = counts.get(group);
      if (row) row.count += 1;
      else counts.set(group, { group, count: 1, reason: "selected" });
    }
    return {
      tools: [...catalogue],
      diagnostics: {
        source: "no_context",
        focusedApp: null,
        routeApp: null,
        agentApp: null,
        apps: [],
        ambiguous: false,
        projectScoped: false,
        locationScoped: false,
        branchScope: null,
        agentScoped: false,
        included: [...counts.values()].sort((a, b) => a.group.localeCompare(b.group)),
        excluded: [],
        catalogueToolCount: catalogue.length,
        catalogueSchemaTokens: schemaTokens,
        toolCount: catalogue.length,
        schemaTokens,
        reductionPct: 0,
      },
    };
  }

  const routeApp = usableApp(input.routeApp ?? null, input.enabledApps);
  const explicitApp = usableApp(input.appFocus ?? null, input.enabledApps);
  const agentApp = usableApp(input.agentApp ?? null, input.enabledApps);

  const messageGroups = [...new Set(groupsMentionedIn(input.message))];
  const taskGroups = groupsForTask(input.task);
  const workspaceGroups: ToolGroup[] = [];
  if (input.workspaceFocus || input.projectScoped) workspaceGroups.push("accounting:workspace");
  if ((input.workspaceFocus || input.projectScoped) && dependencyUnmet("workspace", input) === false) {
    // The AEC section is still filtered by its own dependency below; including
    // it here lets a project turn keep it when the business is really AEC.
    if (!dependencyUnmet("aecIndustry", input)) workspaceGroups.push("accounting:projects");
  }

  const preferredApp = agentApp ?? explicitApp ?? routeApp;
  const signalGroups = [...new Set([...messageGroups, ...taskGroups, ...workspaceGroups])];
  const signalApps = appsForGroups(signalGroups);

  const apps = preferredApp ? [preferredApp] : signalApps.length > 0 ? signalApps : null;

  const routed = routeTools(names, apps, {
    task: input.task ?? null,
    message: input.message ?? null,
    groups: workspaceGroups,
  });
  const selectedNames = new Set(routed ?? names);

  // A project-scoped conversation is cross-cutting: the project Workspace is
  // relevant even when the turn is focused on another app. Adding it after the
  // app route keeps the two contexts together instead of choosing one.
  if ((input.projectScoped || input.workspaceFocus) && input.workspaceAvailable !== false) {
    for (const name of names) {
      const group = toolGroupOf(name);
      if (group === "accounting:workspace") selectedNames.add(name);
      if (group === "accounting:projects" && !dependencyUnmet("aecIndustry", input)) selectedNames.add(name);
    }
  }

  const allowedByAgent = input.agentAllowedTools && input.agentAllowedTools.length > 0
    ? new Set(input.agentAllowedTools)
    : null;

  const included: OpenAiTool[] = [];
  const includedCounts = new Map<string, AiToolGroupCount>();
  const excludedCounts = new Map<string, AiToolGroupCount>();

  const countInto = (
    bucket: Map<string, AiToolGroupCount>,
    group: string,
    reason: AiToolInclusionReason | AiToolExclusionReason,
  ) => {
    const key = `${group}|${reason}`;
    const row = bucket.get(key);
    if (row) row.count += 1;
    else bucket.set(key, { group, count: 1, reason });
  };

  for (const tool of catalogue) {
    const name = tool.function.name;
    const metadata = toolMetadata(name);
    const group = groupKeyFor(name);
    const protocol = PROTOCOL_TOOLS.has(name);

    let exclusion: AiToolExclusionReason | null = null;
    if (!selectedNames.has(name)) exclusion = "not_selected";
    else if (metadata.app && input.enabledApps && !input.enabledApps.includes(metadata.app)) {
      exclusion = "app_disabled";
    } else if (
      metadata.features.length > 0 &&
      input.enabledFeatures &&
      !metadata.features.some((feature) => input.enabledFeatures?.[feature] === true)
    ) {
      exclusion = "feature_disabled";
    } else if (metadata.dependencies.some((dependency) => dependencyUnmet(dependency, input))) {
      exclusion = "dependency_unmet";
    } else if (!protocol && allowedByAgent && !allowedByAgent.has(name)) {
      exclusion = "agent_allowlist";
    } else if (!protocol && input.permissions && !canUseAiTool(name, input.permissions)) {
      exclusion = "permission";
    }

    if (exclusion) {
      countInto(excludedCounts, group, exclusion);
      continue;
    }

    included.push(tool);
    const reason: AiToolInclusionReason = protocol
      ? "protocol"
      : isAlwaysOnTool(name)
        ? "always_on"
        : group === "shared"
          ? "shared"
          : !toolGroupOf(name)
            ? "unclassified"
            : "selected";
    countInto(includedCounts, group, reason);
  }

  const catalogueSchemaTokens = estimateTokens(JSON.stringify(catalogue));
  const schemaTokens = estimateTokens(JSON.stringify(included));
  const reductionPct = catalogueSchemaTokens > 0
    ? Math.max(0, Math.round((1 - schemaTokens / catalogueSchemaTokens) * 1000) / 10)
    : 0;

  const source: AiToolSelectionSource = agentApp
    ? "agent_focus"
    : explicitApp
      ? "explicit_focus"
      : input.workspaceFocus
        ? "workspace_focus"
        : routeApp
          ? "route_hint"
          : messageGroups.length > 0
            ? "message"
            : taskGroups.length > 0
              ? "task"
              : "no_context";

  return {
    tools: included,
    diagnostics: {
      source,
      focusedApp: explicitApp,
      routeApp,
      agentApp,
      apps: apps ?? [],
      ambiguous: routed === null && !preferredApp,
      projectScoped: input.projectScoped === true,
      locationScoped: input.locationScoped === true,
      branchScope: input.branchScope ?? null,
      agentScoped: Boolean(allowedByAgent),
      included: [...includedCounts.values()].sort((a, b) => a.group.localeCompare(b.group) || a.reason.localeCompare(b.reason)),
      excluded: [...excludedCounts.values()].sort((a, b) => a.group.localeCompare(b.group) || a.reason.localeCompare(b.reason)),
      catalogueToolCount: catalogue.length,
      catalogueSchemaTokens,
      toolCount: included.length,
      schemaTokens,
      reductionPct,
    },
  };
}

