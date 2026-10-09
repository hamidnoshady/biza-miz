/**
 * The mark an AI-written row carries, as a pure module.
 *
 * The autopilot and the MCP connector do not have a `created_by_kind` column to
 * set, so a row they wrote says so in its own text — the «ثبت خودکار دستیار — »
 * prefix on an autopilot journal's memo. Screens that want to show *who*
 * proposed a draft therefore read that prefix back, and a screen cannot import
 * `ai-autopilot-executors.ts` to do it: that module opens a database pool, and
 * a client component importing it drags the pool into the browser bundle.
 *
 * So the strings live here, framework-free, and both sides import them. The
 * single definition is the point — a prefix duplicated into a UI file is a
 * prefix that silently stops matching the moment the writer changes it, and the
 * failure mode is an AI-drafted document presented as a person's own.
 */

/** What the autopilot prepends to a memo/note it wrote. */
export const AUTOPILOT_NOTE_PREFIX = "ثبت خودکار دستیار — ";

/** What an MCP connector write prepends (see src/lib/mcp/write-service.ts). */
export const MCP_ACTOR_PREFIX = "اتصال هوش مصنوعی — ";

export type AiProvenance = "autopilot" | "mcp" | null;

/**
 * Who this text came from, read off its prefix.
 *
 * `null` means "no mark", which the caller must treat as *a person's own
 * entry* — never as "unknown AI". Guessing the other way would let a manager's
 * hand-typed journal be discounted by a reviewer as machine-written.
 */
export function provenanceOfMemo(memo: string | null | undefined): AiProvenance {
  const value = (memo ?? "").trimStart();
  if (value.startsWith(AUTOPILOT_NOTE_PREFIX.trimEnd())) return "autopilot";
  if (value.startsWith(MCP_ACTOR_PREFIX.trimEnd())) return "mcp";
  return null;
}

/** The Persian label a screen shows for a provenance, or null when there is none to show. */
export function provenanceLabel(provenance: AiProvenance): string | null {
  if (provenance === "autopilot") return "پیش‌نویس خودکار دستیار";
  if (provenance === "mcp") return "پیش‌نویس از اتصال هوش مصنوعی";
  return null;
}
