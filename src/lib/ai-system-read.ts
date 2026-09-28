import { runReadTool, type FloorReadScope, type ToolResult } from "./ai-tools";
import { SYSTEM_AI_READ_PERMISSIONS } from "./ai-capabilities";

/**
 * Explicit executor context for trusted background jobs and authenticated MCP
 * connections. These callers have their own tenant/job/scope gates; passing the
 * set here prevents an accidental unscoped `runReadTool` call from becoming an
 * all-access escape hatch.
 */
export function runSystemReadTool(
  name: string,
  args: Record<string, unknown>,
  businessId: string,
  floorScope?: FloorReadScope,
  actorUserId?: string,
): Promise<ToolResult> {
  return runReadTool(name, args, businessId, floorScope, actorUserId, SYSTEM_AI_READ_PERMISSIONS);
}
