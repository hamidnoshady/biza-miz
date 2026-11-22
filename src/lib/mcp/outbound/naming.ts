/**
 * The names a discovered external tool is exposed under.
 *
 * Kept apart from `service.ts` so it can be tested without a database connection:
 * a tool name is the one thing that travels from a tenant's registered server
 * into a model's function call and back into the dispatcher, and a mistake here
 * either hides a tool or routes a call to the wrong one.
 *
 * Shape: `mcp_<serverSlug>__<tool>`.
 *
 *  - The `mcp_` prefix is the dispatcher's routing key (see `runReadTool`), which
 *    is why `canUseAiTool` can recognise an external tool without a static
 *    registry entry.
 *  - `__` separates the two because a single `_` occurs inside both halves.
 *  - OpenAI caps a function name at 64 characters and allows `[a-zA-Z0-9_-]`;
 *    the remote tool name is reduced to `[a-z0-9_]` and truncated to fit.
 */

export const MCP_EXTERNAL_TOOL_PREFIX = "mcp_";
export const MCP_EXTERNAL_NAME_SEPARATOR = "__";
export const MAX_SERVER_SLUG = 24;
export const SERVER_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;

const MAX_FUNCTION_NAME = 64;

export function externalToolName(slug: string, remoteName: string): string {
  const budget =
    MAX_FUNCTION_NAME - MCP_EXTERNAL_TOOL_PREFIX.length - slug.length - MCP_EXTERNAL_NAME_SEPARATOR.length;
  const tool = remoteName
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, Math.max(1, budget));
  return `${MCP_EXTERNAL_TOOL_PREFIX}${slug}${MCP_EXTERNAL_NAME_SEPARATOR}${tool || "tool"}`;
}

export function isExternalMcpToolName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.startsWith(MCP_EXTERNAL_TOOL_PREFIX) &&
    name.includes(MCP_EXTERNAL_NAME_SEPARATOR)
  );
}

/**
 * `mcp_acme__find_pages` → `{ slug: "acme", tool: "find_pages" }`.
 *
 * The tool half is the **sanitized** remote name, not the server's original
 * string: a remote tool called `find pages` is exposed as `find_pages`, and the
 * dispatcher matches it against the discovered list by recomputing the exposed
 * name rather than by reversing this function.
 */
export function parseExternalToolName(name: string): { slug: string; tool: string } | null {
  if (!isExternalMcpToolName(name)) return null;
  const body = name.slice(MCP_EXTERNAL_TOOL_PREFIX.length);
  const index = body.indexOf(MCP_EXTERNAL_NAME_SEPARATOR);
  if (index <= 0) return null;
  const slug = body.slice(0, index);
  const tool = body.slice(index + MCP_EXTERNAL_NAME_SEPARATOR.length);
  if (!SERVER_SLUG_RE.test(slug) || !tool) return null;
  return { slug, tool };
}
