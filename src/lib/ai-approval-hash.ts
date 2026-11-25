/**
 * GH #1567 F7 — the approval payload binding, kept out of
 * `ai-approval-policy.ts` because the policy is imported by client
 * components (autopilot/coworker panels) and this needs node:crypto.
 */
import { createHash } from "node:crypto";

/**
 * The payload binding. Canonical (key-sorted) JSON over action type + payload,
 * identical to the MCP idempotency hash so the two can never disagree about
 * whether two requests are "the same".
 */
export function aiApprovalPayloadHash(actionType: string, payload: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === "object" && value !== null) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[key] = canonical((value as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify({ actionType, payload: canonical(payload) }))
    .digest("hex");
}
