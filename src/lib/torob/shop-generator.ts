/**
 * Issue #894 Wave 3 — the **Shop Generator** client.
 *
 * Torob gives a platform two ways to operate a merchant's shop: the merchant
 * pastes their own Shop API token (manual mode, already implemented in Wave 1), or
 * the platform is a registered *shop generator* and asks Torob for a **connection**
 * the merchant approves once in their Torob panel. This file is the second way,
 * transcribed from `torob/Torob-Sync` → `shop_generator_connection.md`.
 *
 * The flow the document describes, and the reason each part is shaped this way:
 *
 *   1. `POST /connections/` with the shop's domain and a `return_url` — the answer
 *      carries a `connection_id` and an `approve_url`.
 *   2. The **merchant's own browser** is sent to `approve_url`. They log into Torob
 *      and approve.
 *   3. Torob redirects that browser back to `return_url` with a one-time `code`.
 *   4. `POST /connections/{id}/confirm/` with that code makes the connection
 *      `active`.
 *
 * Two constraints from the document are load-bearing rather than decorative:
 *
 *   - **The whole flow must finish within 15 minutes**, and a `return_url` request
 *     restarts the clock. So the deadline is stored with the request, not inferred
 *     from when the row last changed.
 *   - **The code arrives through the browser, not through an API response.** The
 *     document spells out why: "*check that the `connection_id` in the callback is
 *     the one it stored for that browser session. Otherwise, a user of the platform
 *     could add another shop's domain and get the real owner to approve it.*" That
 *     check belongs to the caller (`authorization-service.ts`), and this file never
 *     decides which shop a connection is for.
 *
 * The partner token is a deployment secret (`TOROB_PARTNER_TOKEN`), restricted by
 * Torob to registered IP addresses. Its absence is not an error to hide: the
 * channel says so and manual mode stays available.
 */

/** Torob's documented base URL. Overridable so tests never reach the network. */
export const TOROB_SHOP_GENERATOR_URL = "https://api.torob.com/shop-generator/v1/";

/**
 * The connection lifecycle, in Torob's words.
 *
 * `approved` means the merchant said yes and the platform has not confirmed yet —
 * not that the shop is connected. Conflating those two is how a screen says
 * «متصل شد» while the connection is still `pending`.
 */
export const TOROB_CONNECTION_STATUSES = ["pending", "approved", "active", "revoked", "expired"] as const;
export type TorobConnectionStatus = (typeof TOROB_CONNECTION_STATUSES)[number];

export interface TorobConnection {
  connectionId: string;
  shopDomain: string;
  status: TorobConnectionStatus;
  /** Present only while `pending`; the merchant's browser goes here. */
  approveUrl: string | null;
}

/**
 * Why a Shop Generator call did not produce a connection.
 *
 * Closed vocabulary, because each of these is a different next step for the
 * merchant: not configured is ours to fix, `unauthorized` is a token/IP problem,
 * `no_such_shop` means Torob has never seen the domain, and `code_invalid` means
 * the approval expired or was already used.
 */
export type TorobPartnerFailure =
  | "not_configured"
  | "unauthorized"
  | "not_a_generator"
  | "no_such_shop"
  | "connection_not_found"
  | "code_invalid"
  | "invalid_request"
  | "provider_error"
  | "timeout";

export class TorobPartnerError extends Error {
  constructor(
    public readonly code: TorobPartnerFailure,
    /** The provider's own words, for the log — never rendered to a merchant. */
    public readonly detail?: string,
  ) {
    super(code);
    this.name = "TorobPartnerError";
  }
}

/** The partner token, or null when this deployment has no generator application. */
export function torobPartnerToken(env: Record<string, string | undefined> = process.env): string | null {
  const token = env.TOROB_PARTNER_TOKEN?.trim();
  return token ? token : null;
}

export function torobGeneratorBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const configured = env.TOROB_SHOP_GENERATOR_BASE_URL?.trim();
  if (!configured) return TOROB_SHOP_GENERATOR_URL;
  return configured.endsWith("/") ? configured : `${configured}/`;
}

/**
 * Whether Torob will accept this `return_url`.
 *
 * The document: "Must be `https`; `http` is accepted only for `localhost` and
 * `127.0.0.1`." Checked here so a local development install gets a sentence
 * instead of a 400 with `invalid request body`.
 */
export function isAcceptableReturnUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function toConnection(body: unknown): TorobConnection {
  const row = (body ?? {}) as Record<string, unknown>;
  const connectionId = String(row.connection_id ?? "");
  const status = String(row.status ?? "");
  if (!connectionId || !(TOROB_CONNECTION_STATUSES as readonly string[]).includes(status)) {
    throw new TorobPartnerError("provider_error", "connection object is not the documented shape");
  }
  const approveUrl = typeof row.approve_url === "string" && row.approve_url ? row.approve_url : null;
  return { connectionId, shopDomain: String(row.shop_domain ?? ""), status: status as TorobConnectionStatus, approveUrl };
}

/** The provider's failure, mapped from its status and message. */
function toFailure(status: number, body: unknown): TorobPartnerError {
  const row = (body ?? {}) as Record<string, unknown>;
  const error = typeof row.error === "string" ? row.error : "";
  const detail = typeof row.detail === "string" ? row.detail : error;
  if (status === 401) return new TorobPartnerError("unauthorized", detail);
  if (status === 403) return new TorobPartnerError("not_a_generator", detail);
  if (status === 404) {
    return new TorobPartnerError(
      /no shop has this domain/i.test(error) ? "no_such_shop" : "connection_not_found",
      detail,
    );
  }
  if (status === 400) {
    return new TorobPartnerError(/code is invalid/i.test(error) ? "code_invalid" : "invalid_request", detail);
  }
  return new TorobPartnerError("provider_error", `HTTP ${status}`);
}

interface CallOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

async function call(options: CallOptions): Promise<unknown> {
  const env = options.env ?? process.env;
  const token = torobPartnerToken(env);
  // Refused before the network: a request with no credential would come back 401
  // and read like Torob's fault.
  if (!token) throw new TorobPartnerError("not_configured");

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${torobGeneratorBaseUrl(env)}${options.path}`, {
      method: options.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const timedOut = (error as { name?: string }).name === "TimeoutError";
    throw new TorobPartnerError(timedOut ? "timeout" : "provider_error", String(error));
  }

  if (response.status === 204) return null;

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) throw toFailure(response.status, parsed);
  return parsed;
}

/**
 * Ask Torob for a connection to a shop and get the page the merchant approves on.
 *
 * Requesting again while a connection is not active reuses the same
 * `connection_id`, replaces the `return_url` and restarts the 15-minute clock —
 * which is exactly what a merchant who let the first window lapse needs.
 */
export async function requestTorobConnection(input: {
  shopDomain: string;
  returnUrl: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<TorobConnection> {
  const domain = input.shopDomain.trim().toLowerCase();
  if (!domain) throw new TorobPartnerError("invalid_request", "shop domain is empty");
  if (!isAcceptableReturnUrl(input.returnUrl)) {
    throw new TorobPartnerError("invalid_request", "return_url must be https (http only for localhost)");
  }
  const body = await call({
    method: "POST",
    path: "connections/",
    body: { shop_domain: domain, return_url: input.returnUrl },
    env: input.env,
    fetchImpl: input.fetchImpl,
  });
  return toConnection(body);
}

/** Read a connection's current status. */
export async function getTorobConnection(input: {
  connectionId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<TorobConnection> {
  const body = await call({
    method: "GET",
    path: `connections/${encodeURIComponent(input.connectionId)}/`,
    env: input.env,
    fetchImpl: input.fetchImpl,
  });
  return toConnection(body);
}

/**
 * Confirm the merchant's approval with the one-time code their browser carried
 * back, which is the step that makes the connection `active`.
 *
 * The code is single-use: a replay answers `code_invalid`, which is reported as
 * such rather than retried.
 */
export async function confirmTorobConnection(input: {
  connectionId: string;
  code: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<TorobConnection> {
  const code = input.code.trim();
  if (!code) throw new TorobPartnerError("invalid_request", "code is empty");
  const body = await call({
    method: "POST",
    path: `connections/${encodeURIComponent(input.connectionId)}/confirm/`,
    body: { code },
    env: input.env,
    fetchImpl: input.fetchImpl,
  });
  return toConnection(body);
}

/**
 * Disconnect on Torob's side: an active connection is revoked, a pending request
 * is cancelled, and Shop API calls for that shop start returning 403.
 *
 * Idempotent by the document's own definition (repeating it answers 204), which is
 * what makes it safe to call while turning a channel off.
 */
export async function disconnectTorobConnection(input: {
  connectionId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  await call({
    method: "DELETE",
    path: `connections/${encodeURIComponent(input.connectionId)}/`,
    env: input.env,
    fetchImpl: input.fetchImpl,
  });
}

/** What a merchant reads for each failure. */
export const TOROB_PARTNER_FAILURE_COPY: Readonly<Record<TorobPartnerFailure, string>> = {
  not_configured: "اتصال خودکار به ترب برای این نصب فعال نیست؛ از توکن دستی ترب استفاده کنید.",
  unauthorized: "ترب درخواست را نپذیرفت؛ توکن یا نشانی IP این سرور در ترب ثبت نشده است.",
  not_a_generator: "توکن این نصب، توکن سازندهٔ فروشگاه در ترب نیست.",
  no_such_shop: "ترب فروشگاهی با این دامنه نمی‌شناسد؛ ابتدا فروشگاه را در ترب ثبت کنید.",
  connection_not_found: "این اتصال در ترب پیدا نشد.",
  code_invalid: "تأیید منقضی شده یا پیش‌تر استفاده شده است؛ درخواست تازه بفرستید.",
  invalid_request: "درخواست برای ترب معتبر نبود.",
  provider_error: "پاسخ ترب خوانده نشد؛ کمی بعد دوباره تلاش کنید.",
  timeout: "پاسخ ترب در زمان مجاز نرسید.",
};
