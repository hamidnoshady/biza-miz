/**
 * The assistant/action → paid-service identity, as a PURE module.
 *
 * Issue #1110 needs both `ai.ts` (framework-free, bundled into client
 * components) and `ai-service-activation.ts` (DB-backed) to answer "does this
 * action belong to My Workspace?". Keeping the mapping here — with no `db` and
 * no `next` import — lets both import one table instead of copying the rule.
 *
 * `appForApiPath` is the canonical module registry; Workspace is deliberately
 * not an app there, so it is named explicitly.
 */
import { appForApiPath } from "./app-availability";

export type AiActionServiceKind = "app" | "workspace";

export interface AiActionServiceIdentity {
  kind: AiActionServiceKind;
  key: string;
}

/** Resolve the paid service owning an action's canonical endpoint, or null. */
export function aiActionServiceForEndpoint(endpoint: string): AiActionServiceIdentity | null {
  const pathname = endpoint.split(/[?#]/, 1)[0];
  const app = appForApiPath(pathname);
  if (app) return { kind: "app", key: app };
  if (
    pathname === "/api/workspace" ||
    pathname.startsWith("/api/workspace/") ||
    pathname === "/api/aec" ||
    pathname.startsWith("/api/aec/")
  ) {
    return {
      kind: "workspace",
      key: /(?:^|\/)documents(?:\/|$)/.test(pathname) ? "documents" : "projects",
    };
  }
  return null;
}

/**
 * Read tools whose subject is a My Workspace record.
 *
 * This list must cover `WORKSPACE_TOOL_NAMES` (the four assistant reads), the
 * AEC reads that answer from project registers, and the extra MCP-only
 * workspace reads. `workspace-ai-tools.test.ts` fails if the named arrays gain
 * a tool this list does not carry.
 */
export const WORKSPACE_SCOPED_READ_TOOL_NAMES = [
  // The four assistant reads (workspace-shared.ts WORKSPACE_TOOL_NAMES).
  "get_workspace_project_status",
  "list_workspace_tasks",
  "list_expiring_contracts",
  "list_workspace_approvals",
  // MCP / wider catalogue reads that answer from projects, tasks, documents,
  // contracts, templates, calendar, comments or approvals.
  "list_workspace_projects",
  "get_workspace_dashboard",
  "get_workspace_insights",
  "get_workspace_project_report",
  "list_workspace_templates",
  "list_workspace_calendar",
  "list_workspace_comments",
  "list_workspace_documents",
  "get_workspace_document",
  "get_workspace_contract",
  // The AEC reads (aec.ts AEC_AI_TOOL_NAMES).
  "get_aec_project_financial_health",
  "list_delayed_project_activities",
  "get_boq_variance",
  "get_latest_drawing_revision",
  "list_pending_rfis",
  "list_pending_submittals",
  "list_site_issues",
  "list_change_orders",
  "list_payment_certificates",
  "list_project_commercial_risks",
  "list_procurement_delays",
  "list_upcoming_milestones",
] as const;

const WORKSPACE_SCOPED_READ_TOOL_SET = new Set<string>(WORKSPACE_SCOPED_READ_TOOL_NAMES);

/** Is this read tool's subject the My Workspace domain? */
export function isWorkspaceScopedReadTool(name: string): boolean {
  return WORKSPACE_SCOPED_READ_TOOL_SET.has(name);
}

/** Does this action type write into My Workspace (project, task, document…)? */
export function isWorkspaceAiActionEndpoint(endpoint: string): boolean {
  return aiActionServiceForEndpoint(endpoint)?.kind === "workspace";
}
