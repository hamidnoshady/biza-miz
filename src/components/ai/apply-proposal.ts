/**
 * The one way a proposal is applied from the browser: through
 * `/api/ai/proposals/apply` with the proposal's audit id and the approval hash
 * the card displayed (GH #1567 F7); the server claims the audit row, records
 * the human approval and calls the already-role-guarded business route. Shared by the chat widget and the AI
 * hub's autopilot activity list (Phase 31), which surfaces proposals autopilot
 * held back for confirmation — those take exactly this path, unchanged.
 */
import { ACTION_CATALOG, resolveActionEndpoint, type ProposedAction } from "@/lib/ai";

export type ApplyProposalOutcome =
  | { ok: true; endpoint: string; method: string; status: number }
  | { ok: false; endpoint?: string; method?: string; error: "unknown_action" | "missing_param" | "request_failed"; detail: string };

export async function applyProposalRequest(
  proposal: ProposedAction,
  auditId?: string | null,
  approval?: "session",
  /** GH #1567 F7 — the approval hash of the payload the card showed; required for gated actions. */
  payloadHash?: string | null,
): Promise<ApplyProposalOutcome> {
  const meta = ACTION_CATALOG[proposal.type];
  if (!meta) return { ok: false, error: "unknown_action", detail: "نوع این پیشنهاد شناخته‌شده نیست." };

  // GH #1567 F7 — there is no direct path. A proposal is applied only through
  // the server-owned audit row: the server claims it (so reloads and double
  // clicks cannot run it twice), records the human approval against the hash
  // of the payload this card showed, and only then calls the business route.
  // A card without an audit link (its audit row could not be written) is
  // refused rather than sent straight to the destination, which would bypass
  // the approval record entirely.
  if (!auditId) {
    return {
      ok: false,
      error: "missing_param",
      detail: "این پیشنهاد در گزارش ممیزی ثبت نشده و برای امنیت اجرا نمی‌شود؛ درخواست را دوباره بفرستید.",
    };
  }

  const response = await fetch("/api/ai/proposals/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auditId, ...(approval ? { approval } : {}), ...(payloadHash ? { payloadHash } : {}) }),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    return {
      ok: false,
      error: "request_failed",
      detail: typeof data.message === "string" ? data.message : "این پیشنهاد قبلاً اجرا شده یا دیگر قابل اجرا نیست.",
    };
  }
  const endpoint = typeof data.endpoint === "string" ? data.endpoint : resolveActionEndpoint(meta, proposal.payload) ?? meta.endpoint;
  return { ok: true, endpoint, method: meta.method, status: response.status };
}
