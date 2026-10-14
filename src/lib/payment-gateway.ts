/**
 * Iranian payment-gateway adapter.
 *
 * Zarinpal is the shipped gateway (REST v4, https://payment.zarinpal.com).
 * The adapter is deliberately thin: it knows how to *request* a payment
 * (authority + redirect URL) and *verify* one (RefID on success), and nothing
 * about wallets or ledgers — that orchestration lives in wallet-service.ts so
 * the two can be tested independently.
 *
 * Three modes, selected by the platform payment config:
 *
 *  - `manual`  — no online gateway. Payments are created as `pending` and a
 *                super-admin approves them after an out-of-band transfer.
 *  - `zarinpal` + `sandbox: true` — talks to sandbox.zarinpal.com (Zarinpal's
 *                documented test environment; the merchant id is the demo
 *                `00000000-0000-0000-0000-000000000000` unless one is set).
 *  - `zarinpal` + `sandbox: false` — live payments on payment.zarinpal.com.
 *
 * Zarinpal v4 request:
 *   POST {base}/pg/v4/payment/request.json
 *   { merchant_id, amount, callback_url, description, metadata:{…} }
 *   → { data: { authority, code, fee, … } }
 * Zarinpal v4 verify:
 *   POST {base}/pg/v4/payment/verify.json
 *   { merchant_id, amount, authority }
 *   → { data: { ref_id, code, … } }  (code 100 = verified, 101 = already verified)
 *
 * Amounts are sent in Rial when `currency` is IRR (Zarinpal v4 expects Rial).
 */

export type GatewayKind = "manual" | "zarinpal";

export interface PaymentGatewayConfig {
  gateway: GatewayKind;
  merchantId: string;
  sandbox: boolean;
  callbackUrl: string;
  currency: "IRR" | "IRT";
}

export interface GatewayRequestInput {
  amountRial: number;
  description: string;
  /** Payment row id — embedded in the callback so verify can find the row. */
  paymentId: string;
  email?: string | null;
  mobile?: string | null;
}

export interface GatewayRequestResult {
  authority: string;
  /** Where the browser must be redirected to complete payment. */
  redirectUrl: string;
}

export interface GatewayVerifyResult {
  verified: boolean;
  refId?: string;
  code?: number | string;
  /** True when Zarinpal says it was already verified in a previous attempt. */
  alreadyVerified?: boolean;
}

export const ZARINPAL_DEMO_MERCHANT = "00000000-0000-0000-0000-000000000000";

function zarinpalBase(sandbox: boolean): string {
  return sandbox
    ? "https://sandbox.zarinpal.com"
    : "https://payment.zarinpal.com";
}

/** The browser-facing payment page for an authority. */
export function zarinpalPaymentUrl(authority: string, sandbox: boolean): string {
  const base = sandbox
    ? "https://sandbox.zarinpal.com"
    : "https://payment.zarinpal.com";
  return `${base}/pg/StartPay/${authority}`;
}

function zarinpalCodeIsSuccess(code: number | string | undefined): boolean {
  // 100 = success, 101 = already verified — both mean the money settled.
  return code === 100 || code === 101 || code === "100" || code === "101";
}

async function postJson(url: string, body: Record<string, unknown>): Promise<{
  data?: Record<string, unknown>;
  errors?: unknown;
  status: number;
}> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  let json: { data?: Record<string, unknown>; errors?: unknown } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    // Non-JSON response (gateway down / HTML error page) — caller treats as failure.
  }
  return { ...json, status: res.status };
}

/**
 * Ask the gateway for an authority token. Throws GatewayError with a Persian
 * message key when the gateway refuses or cannot be reached.
 */
export async function zarinpalRequest(
  config: PaymentGatewayConfig,
  input: GatewayRequestInput,
): Promise<GatewayRequestResult> {
  const base = zarinpalBase(config.sandbox);
  const merchantId = config.merchantId?.trim() || ZARINPAL_DEMO_MERCHANT;
  const callback = config.callbackUrl?.trim();
  if (!callback) {
    throw new GatewayError("callback_not_configured");
  }
  const callbackUrl = `${callback.replace(/\/+$/, "")}?payment=${input.paymentId}`;

  const { data, errors, status } = await postJson(`${base}/pg/v4/payment/request.json`, {
    merchant_id: merchantId,
    amount: input.amountRial,
    callback_url: callbackUrl,
    description: input.description,
    metadata: {
      ...(input.mobile ? { mobile: input.mobile } : {}),
      ...(input.email ? { email: input.email } : {}),
    },
  });

  const authority = typeof data?.authority === "string" ? data.authority : "";
  const code = (data?.code ?? undefined) as number | string | undefined;
  if (!authority || !zarinpalCodeIsSuccess(code)) {
    throw new GatewayError(
      "gateway_request_failed",
      zarinpalErrorMessage(errors) ?? (code ? `code ${code}` : `http ${status}`),
    );
  }
  return { authority, redirectUrl: zarinpalPaymentUrl(authority, config.sandbox) };
}

/**
 * Verify a returning payment. Never throws for a "not paid" outcome — that is
 * a normal `{ verified: false }`; throws only when the gateway is unreachable
 * in a way that deserves a retry.
 */
export async function zarinpalVerify(
  config: PaymentGatewayConfig,
  input: { amountRial: number; authority: string },
): Promise<GatewayVerifyResult> {
  const base = zarinpalBase(config.sandbox);
  const merchantId = config.merchantId?.trim() || ZARINPAL_DEMO_MERCHANT;

  const { data, errors, status } = await postJson(`${base}/pg/v4/payment/verify.json`, {
    merchant_id: merchantId,
    amount: input.amountRial,
    authority: input.authority,
  });

  const code = (data?.code ?? undefined) as number | string | undefined;
  if (zarinpalCodeIsSuccess(code)) {
    return {
      verified: true,
      refId: typeof data?.ref_id === "number" ? String(data.ref_id) : (data?.ref_id as string | undefined),
      code,
      alreadyVerified: code === 101 || code === "101",
    };
  }
  // -54 is Zarinpal's "archive"/expired authority (user never paid). Any other
  // refusal is simply unpaid; the caller marks the payment failed.
  if (status >= 500) {
    throw new GatewayError("gateway_unreachable", zarinpalErrorMessage(errors) ?? `http ${status}`);
  }
  return { verified: false, code };
}

function zarinpalErrorMessage(errors: unknown): string | null {
  if (!errors) return null;
  if (typeof errors === "object") {
    const obj = errors as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    const first = Object.values(obj)[0];
    if (Array.isArray(first) && typeof first[0] === "string") return first[0];
    if (typeof first === "string") return first;
  }
  return typeof errors === "string" ? errors : null;
}

export class GatewayError extends Error {
  constructor(
    public code: string,
    public detail?: string,
  ) {
    super(code);
  }
}

/** Persian UI messages for gateway failure codes. */
export function gatewayErrorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    callback_not_configured:
      "نشانی بازگشت درگاه پرداخت تنظیم نشده است. مدیر سامانه باید آن را در بخش «پرداخت‌ها» وارد کند.",
    gateway_request_failed: "ثبت درخواست پرداخت در درگاه انجام نشد. کمی بعد دوباره تلاش کنید.",
    gateway_unreachable: "درگاه پرداخت در دسترس نیست. اتصال سرور را بررسی کنید.",
    payment_not_found: "این رسید پرداخت پیدا نشد.",
    payment_not_pending: "این رسید دیگر قابل پیگیری نیست.",
    invalid_payment_gateway: "درگاه پرداخت این رسید با تأیید آنلاین هم‌خوانی ندارد.",
    authority_mismatch: "شناسهٔ پیگیری درگاه با رسید ثبت‌شده مطابقت ندارد.",
    duplicate_gateway_ref: "این شمارهٔ مرجع تراکنش قبلاً برای رسید دیگری ثبت شده است.",
    gateway_ref_mismatch: "شمارهٔ مرجع تراکنش با رسید تأییدشده هم‌خوانی ندارد.",
    amount_mismatch: "مبلغ رسید با مبلع ثبت‌شده هم‌خوانی ندارد.",
    manual_review: "پرداخت دستی در انتظار تأیید مدیر است.",
  };
  return map[code ?? ""] ?? "خطای درگاه پرداخت. دوباره تلاش کنید.";
}
