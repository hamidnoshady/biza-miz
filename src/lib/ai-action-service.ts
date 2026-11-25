/**
 * The assistant/action → My Workspace identity, as a PURE, dependency-free
 * module.
 *
 * Issue #1110 needs both `ai.ts` (framework-free, bundled into client
 * components) and `ai-service-activation.ts` (DB-backed) to answer "does this
 * action belong to My Workspace?". Keeping the Workspace prefix and the read
 * tool list here — with no `db`, `next` or app-registry import — lets both
 * import one table without dragging the industry/app registry into the client
 * bundle. The app-service mapping stays in `ai-service-activation.ts`.
 */

export type AiActionServiceKind = "app" | "workspace";

export interface AiActionServiceIdentity {
  kind: AiActionServiceKind;
  key: string;
}

/** Is this endpoint a My Workspace (or AEC project-register) endpoint? */
export function isWorkspaceAiActionEndpoint(endpoint: string): boolean {
  const pathname = endpoint.split(/[?#]/, 1)[0];
  return (
    pathname === "/api/workspace" ||
    pathname.startsWith("/api/workspace/") ||
    pathname === "/api/aec" ||
    pathname.startsWith("/api/aec/")
  );
}

/**
 * Resolve a Workspace endpoint's priced capability. The app half of the
 * mapping is supplied by `ai-service-activation.ts`, which is the only caller
 * that needs it.
 */
export function workspaceActionServiceForEndpoint(
  endpoint: string,
): AiActionServiceIdentity | null {
  if (!isWorkspaceAiActionEndpoint(endpoint)) return null;
  const pathname = endpoint.split(/[?#]/, 1)[0];
  return {
    kind: "workspace",
    key: /(?:^|\/)documents(?:\/|$)/.test(pathname) ? "documents" : "projects",
  };
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
