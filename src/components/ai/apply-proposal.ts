/**
 * The one way a proposal is applied from the browser: resolve its endpoint from
 * the catalogue, fetch it with the signed-in user's own session cookie, and let
 * the already-role-guarded route decide. Shared by the chat widget and the AI
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
): Promise<ApplyProposalOutcome> {
  const meta = ACTION_CATALOG[proposal.type];
  if (!meta) return { ok: false, error: "unknown_action", detail: "نوع این پیشنهاد شناخته‌شده نیست." };

  // New proposals use the server-owned audit row as the idempotency key. The
  // server claims it before calling the business endpoint, so reloads and
  // double clicks cannot execute a non-idempotent action twice.
  if (auditId) {
    const response = await fetch("/api/ai/proposals/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auditId }),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      return {
        ok: false,
        error: "request_failed",
        detail: typeof data.message === "string" ? data.message : "این پیشنهاد قبلاً اجرا شده یا دیگر قابل اجرا نیست.",
      };
    }
    return {
      ok: true,
      endpoint: typeof data.endpoint === "string" ? data.endpoint : meta.endpoint,
      method: meta.method,
      status: response.status,
    };
  }

  const endpoint = resolveActionEndpoint(meta, proposal.payload);
  if (!endpoint) {
    return { ok: false, error: "missing_param", detail: "شناسهٔ لازم برای اجرای این پیشنهاد در آن موجود نیست." };
  }

  const response = await fetch(endpoint, {
    method: meta.method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proposal.payload),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = Array.isArray(data.messages)
      ? data.messages.join(" ")
      : typeof data.error === "string"
        ? data.error
        : "";
    return { ok: false, endpoint, method: meta.method, error: "request_failed", detail };
  }
  return { ok: true, endpoint, method: meta.method, status: response.status };
}
