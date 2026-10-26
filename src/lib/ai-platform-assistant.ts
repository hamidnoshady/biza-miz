/**
 * Issue #1140 §A6 — the Superadmin assistant's tool surface.
 *
 * A separate realm from the tenant assistant: the catalogue is the platform
 * health tools in `ai-platform-tools.ts` and nothing else, every tool names the
 * platform capability it needs, and the executor re-checks that capability for
 * the signed-in administrator on every call (a model naming a tool the admin
 * could not call is refused, not trusted). No tool writes.
 */
import type { OpenAiTool } from "./ai";
import type { ToolResult } from "./ai-tools";
import { PLATFORM_READ_TOOL_NAMES, runPlatformReadTool } from "./ai-platform-tools";
import { platformCan, type PlatformAdminRole, type PlatformCapability } from "./platform-admin";

/** Which capability each platform tool needs. Missing entry = tool not offered. */
export const PLATFORM_TOOL_CAPABILITIES: Record<string, PlatformCapability> = {
  get_client_update_status: "system.read",
  get_backup_health: "backup.read",
};

export const PLATFORM_ASSISTANT_MAX_TOOL_ROUNDS = 3;
const MAX_TOOL_RESULT_CHARS = 12_000;

/** The declared platform tools, narrowed to what this administrator may call. */
export function platformToolsForRole(role: PlatformAdminRole, declared: readonly OpenAiTool[]): OpenAiTool[] {
  return declared.filter((tool) => {
    const name = tool.function.name;
    const capability = PLATFORM_TOOL_CAPABILITIES[name];
    return PLATFORM_READ_TOOL_NAMES.has(name) && !!capability && platformCan(role, capability);
  });
}

/** Parse model-supplied arguments; anything that is not a JSON object is empty. */
function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface PlatformToolOutcome {
  name: string;
  allowed: boolean;
  content: string;
}

/**
 * Runs one model-requested tool call. The capability is checked here against
 * the administrator's role, independent of which tools were offered.
 */
export async function runPlatformAssistantTool(
  role: PlatformAdminRole,
  name: string,
  rawArguments: unknown,
  run: (name: string, args: Record<string, unknown>) => Promise<ToolResult> = runPlatformReadTool,
): Promise<PlatformToolOutcome> {
  const capability = PLATFORM_TOOL_CAPABILITIES[name];
  if (!PLATFORM_READ_TOOL_NAMES.has(name) || !capability || !platformCan(role, capability)) {
    return { name, allowed: false, content: JSON.stringify({ error: "tool_not_permitted" }) };
  }
  let result: ToolResult;
  try {
    result = await run(name, parseArguments(rawArguments));
  } catch {
    return { name, allowed: true, content: JSON.stringify({ error: "tool_failed" }) };
  }
  const content = JSON.stringify(result.data ?? null);
  return {
    name,
    allowed: true,
    content: content.length > MAX_TOOL_RESULT_CHARS
      ? JSON.stringify({ truncated: true, preview: content.slice(0, MAX_TOOL_RESULT_CHARS) })
      : content,
  };
}
