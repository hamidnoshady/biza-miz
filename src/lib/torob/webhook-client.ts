/**
 * Issue #894 Wave 5b — the one HTTP call this slice makes.
 *
 * `POST /update/webhook/v1/` with a bearer token, a body of at most 100 page
 * pairs, and an answer of `{"message": "success"}`. Small on purpose: every rule
 * about *what* to send lives in `webhook.ts`, and every rule about *when* lives in
 * `webhook-service.ts`. This file only turns a batch into a request and a response
 * into one of a closed set of failures.
 *
 * Two details are worth their lines:
 *
 *   - **The token is never in the URL.** A query string ends up in access logs,
 *     proxies and stack traces; the documented header exists for this.
 *   - **A 400 naming the host is `domain_mismatch`, not a generic refusal.** Torob's
 *     own message for a mixed-domain batch is «All page_urls must have the same
 *     host», and mapping that to its own code is what lets the screen say the one
 *     sentence that is actually actionable instead of «درخواست نامعتبر بود».
 */
import { isWebhookAccepted, type TorobWebhookBody, type TorobWebhookError } from "./webhook";

export class TorobWebhookClientError extends Error {
  constructor(
    public readonly code: TorobWebhookError,
    /** The provider's own words, for the log — never rendered to a merchant. */
    public readonly detail?: string,
  ) {
    super(code);
    this.name = "TorobWebhookClientError";
  }
}

export function torobWebhookUrl(env: Record<string, string | undefined> = process.env): string {
  const configured = env.TOROB_WEBHOOK_URL?.trim();
  return configured ? configured : "https://api.torob.com/update/webhook/v1/";
}

export interface TorobWebhookRequest {
  token: string;
  body: TorobWebhookBody;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Send one batch, or throw with the reason it did not land.
 *
 * Returns normally only when Torob accepted the batch **into its queue**. There is
 * no return value that means "probably fine": a 200 with an unexpected body is
 * `provider_error`, because claiming an acceptance Torob did not give is exactly
 * the fabrication this feature exists to avoid.
 */
export async function sendTorobWebhook(request: TorobWebhookRequest): Promise<void> {
  const token = request.token.trim();
  if (!token) throw new TorobWebhookClientError("not_configured", "no token");
  if (request.body.items.length === 0) {
    throw new TorobWebhookClientError("invalid_request", "empty batch");
  }

  const fetchImpl = request.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(torobWebhookUrl(request.env), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(request.timeoutMs ?? 10_000),
    });
  } catch (error) {
    const timedOut = (error as { name?: string }).name === "TimeoutError";
    throw new TorobWebhookClientError(timedOut ? "timeout" : "provider_error", String(error));
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (isWebhookAccepted(response.status, parsed)) return;

  const row = (parsed ?? {}) as Record<string, unknown>;
  const message = typeof row.error === "string" ? row.error : typeof row.message === "string" ? row.message : "";
  throw new TorobWebhookClientError(toFailureCode(response.status, message), message || `HTTP ${response.status}`);
}

function toFailureCode(status: number, message: string): TorobWebhookError {
  if (status === 401) return "unauthorized";
  if (status === 403) {
    // Two different 403s, and the document spells both out: a host that does not
    // match the credentials, and a shop Torob does not consider active.
    return /domain/i.test(message) ? "domain_mismatch" : "shop_not_active";
  }
  if (status === 400) return /host|domain/i.test(message) ? "domain_mismatch" : "invalid_request";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_error";
  return "provider_error";
}
