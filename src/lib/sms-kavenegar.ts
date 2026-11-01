import { SmsProvider } from "./sms";

/**
 * Kavenegar's `verify/lookup` status codes, in Persian.
 *
 * Phase 24 Wave 2 left this as an explicit build-time TODO — the phase doc says
 * so outright: "The `return.status` code table must be read from
 * kavenegar.com/rest.html at implementation time and mapped to Persian user
 * messages; it was returning 503 while this phase was written, so guessing it
 * here would be worse than leaving it as a build-time task." This is that task
 * closed.
 *
 * The distinction that matters is *whose problem it is*. A wrong receptor (411)
 * is the user's, and they can fix it by re-entering their number; an exhausted
 * credit balance (418), a bad API key (403) or a missing template (424) are the
 * operator's, and no amount of the user retrying will help. Both get a Persian
 * sentence, but only the first kind asks the user to do something — see
 * `isOperatorFault` below, which is what stops the login screen telling an
 * Owner to check a number that was never the problem.
 *
 * Unmapped codes fall back to a generic message plus the raw code, so a code
 * Kavenegar adds later is still diagnosable from a screenshot without shipping
 * the carrier's English at a Persian-speaking café owner.
 */
export const KAVENEGAR_STATUS_MESSAGES: Record<number, string> = {
  200: "ارسال شد.",
  400: "پارامترهای درخواست ناقص است.",
  401: "حساب کاربری سرویس پیامک غیرفعال شده است.",
  402: "عملیات ناموفق بود.",
  403: "کلید API سرویس پیامک معتبر نیست.",
  404: "متد درخواستی در سرویس پیامک یافت نشد.",
  405: "روش فراخوانی سرویس پیامک نادرست است.",
  406: "پارامترهای اجباری سرویس پیامک خالی ارسال شده است.",
  407: "دسترسی به اطلاعات درخواست‌شده ممکن نیست.",
  409: "سرور سرویس پیامک پاسخ‌گو نیست؛ کمی بعد دوباره تلاش کنید.",
  411: "شمارهٔ گیرنده نامعتبر است.",
  412: "شمارهٔ فرستنده نامعتبر است.",
  413: "متن پیامک خالی است یا از حد مجاز بلندتر است.",
  414: "حجم درخواست بیش از حد مجاز است.",
  415: "ایندکس درخواست‌شده خارج از محدوده است.",
  416: "آی‌پی سرور با تنظیمات حساب پیامک هم‌خوانی ندارد.",
  417: "تاریخ ارسال نامعتبر است.",
  418: "اعتبار حساب پیامک کافی نیست.",
  419: "تعداد گیرندگان و پیام‌ها یکسان نیست.",
  420: "استفاده از لینک در متن پیامک مجاز نیست.",
  422: "متن پیامک شامل نویسه‌های غیرمجاز است.",
  424: "الگوی (template) پیامک یافت نشد.",
  426: "استفاده از این سرویس نیازمند ارتقای حساب پیامک است.",
  427: "برای ارسال تبلیغاتی باید از لینک کوتاه‌شدهٔ کاوه‌نگار استفاده شود.",
  428: "ارسال کد پستی در این سرویس ممکن نیست.",
  429: "آی‌پی سرور برای ارسال محدود شده است.",
  431: "ساختار کد ارسالی نادرست است.",
  432: "پارامتر کد در متن پیامک وجود ندارد.",
  451: "به‌دلیل فراخوانی بیش از حد، دسترسی موقتاً محدود شده است.",
  501: "ارسال فقط به‌صورت آزمایشی انجام شد.",
};

/**
 * Codes that describe a misconfigured or unfunded *platform* account rather
 * than anything the person at the keyboard did.
 *
 * A user told "شمارهٔ گیرنده نامعتبر است" will retype their number; a user told
 * the same thing when the real cause is an empty credit balance will retype it
 * twenty times and then phone support. Callers use this to decide whether to
 * show the specific message or a neutral "ارسال پیامک ممکن نشد" while the
 * detail goes to the server log for the operator.
 */
export function isOperatorFault(status: number): boolean {
  return [401, 403, 404, 405, 406, 407, 412, 414, 416, 418, 424, 426, 429, 451].includes(status);
}

export function kavenegarStatusMessage(status: number | undefined): string {
  if (status === undefined || Number.isNaN(status)) {
    return "پاسخ سرویس پیامک قابل تفسیر نبود.";
  }
  return (
    KAVENEGAR_STATUS_MESSAGES[status] ??
    `ارسال پیامک ناموفق بود (کد ${status}).`
  );
}

/**
 * A failed send, carrying the carrier's numeric status so callers can branch on
 * it — and a Persian `message` safe to show a user.
 *
 * Deliberately never carries the request URL: the API key sits in the path
 * (see `redactKavenegarUrl`), and an error object that gets logged, serialised
 * into a response, or attached to a monitoring event is precisely how a key
 * escapes. The redacted URL goes to `console.error` at the throw site and
 * nowhere else.
 */
export class KavenegarError extends Error {
  readonly status: number | undefined;
  readonly operatorFault: boolean;

  constructor(status: number | undefined, message?: string) {
    super(message ?? kavenegarStatusMessage(status));
    this.name = "KavenegarError";
    this.status = status;
    this.operatorFault = status !== undefined && isOperatorFault(status);
  }
}

export class KavenegarProvider implements SmsProvider {
  readonly name = "kavenegar" as const;

  constructor(private apiKey: string, private template: string) {}

  async sendOtp(phoneE164: string, otp: string): Promise<void> {
    // Normalise to Iranian local format if it has +98
    let receptor = phoneE164;
    if (receptor.startsWith("+98")) {
      receptor = "0" + receptor.slice(3);
    } else if (receptor.startsWith("98") && receptor.length === 12) {
      receptor = "0" + receptor.slice(2);
    }

    const url = `https://api.kavenegar.com/v1/${this.apiKey}/verify/lookup.json?receptor=${encodeURIComponent(
      receptor
    )}&token=${encodeURIComponent(otp)}&template=${encodeURIComponent(this.template)}`;

    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      // `err` may be a fetch TypeError whose `cause` carries the URL; only the
      // message is interpolated, never the error object or the URL itself.
      throw new KavenegarError(undefined, `ارتباط با سرویس پیامک برقرار نشد: ${(err as Error)?.message ?? "unknown"}`);
    }

    // Kavenegar answers its own status codes over HTTP status codes of the
    // same number, so a non-2xx response is read through the same table rather
    // than reported as an opaque "HTTP 418".
    if (!res.ok) {
      console.error(
        `Kavenegar HTTP ${res.status} for ${redactKavenegarUrl(url)}`,
      );
      throw new KavenegarError(res.status);
    }

    let data: { return?: { status?: number; message?: string } };
    try {
      data = await res.json();
    } catch {
      console.error(`Kavenegar returned unparsable body for ${redactKavenegarUrl(url)}`);
      throw new KavenegarError(undefined);
    }

    const status = data.return?.status;
    if (status !== 200) {
      // The carrier's own English message goes to the log for the operator;
      // the user sees the Persian mapping. Never the other way round.
      console.error(
        `Kavenegar verify/lookup status ${status} (${data.return?.message ?? "no message"}) for ${redactKavenegarUrl(url)}`,
      );
      throw new KavenegarError(status);
    }
  }

  /**
   * Plain-text delivery, used by the contract-signing invitation (issue #908).
   *
   * Kavenegar needs a SENDER LINE for `sms/send`, and an install may not have
   * one — in which case this refuses up front rather than sending a request the
   * gateway will reject with a numeric code nobody can act on. The caller turns
   * the refusal into «ارسال پیامک تنظیم نشده» and hands the sender the link.
   *
   * The key sits in the URL path here too, so a failure logs the redacted URL
   * and the error carries only the carrier's status code.
   */
  async sendText(phoneE164: string, message: string): Promise<void> {
    const sender = process.env.KAVENEGAR_SENDER?.trim();
    if (!sender) throw new KavenegarError(413, "ارسال پیامک متنی تنظیم نشده است.");

    let receptor = phoneE164;
    if (receptor.startsWith("+98")) {
      receptor = "0" + receptor.slice(3);
    } else if (receptor.startsWith("98") && receptor.length === 12) {
      receptor = "0" + receptor.slice(2);
    }

    const url = `https://api.kavenegar.com/v1/${this.apiKey}/sms/send.json?receptor=${encodeURIComponent(
      receptor,
    )}&sender=${encodeURIComponent(sender)}&message=${encodeURIComponent(message)}`;

    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      throw new KavenegarError(
        undefined,
        `ارتباط با سرویس پیامک برقرار نشد: ${(err as Error)?.message ?? "unknown"}`,
      );
    }
    if (!res.ok) {
      console.error(`Kavenegar HTTP ${res.status} for ${redactKavenegarUrl(url)}`);
      throw new KavenegarError(res.status);
    }
    let data: { return?: { status?: number; message?: string } };
    try {
      data = await res.json();
    } catch {
      console.error(`Kavenegar returned unparsable body for ${redactKavenegarUrl(url)}`);
      throw new KavenegarError(undefined);
    }
    const status = data.return?.status;
    if (status !== 200) {
      console.error(
        `Kavenegar sms/send status ${status} (${data.return?.message ?? "no message"}) for ${redactKavenegarUrl(url)}`,
      );
      throw new KavenegarError(status);
    }
  }
}

export function redactKavenegarUrl(url: string): string {
  return url
    .replace(/\/v1\/[^/]+\//, "/v1/REDACTED/")
    .replace(/([?&]token=)[^&]*/, "$1REDACTED");
}
