/**
 * Phase 37 Wave 3 — Kavenegar SMS, the *pure* half (build requests, parse and
 * classify responses). Network lives in kavenegar-client.ts. Splitting them is
 * what lets the adapter be unit-tested against recorded fixtures with no live
 * provider and no `fetch` — the same split plugin-link.ts uses.
 *
 * Kavenegar's REST shape:
 *   POST https://api.kavenegar.com/v1/{APIKEY}/sms/send.json
 *   body:  receptor=<number>&message=<text>&sender=<linenumber>
 *   body:  https://api.kavenegar.com/v1/{APIKEY}/sms/sendarray.json ...
 *   reply: { "return": { "status": 200, "message": "..." },
 *            "entries": [{ "messageid": 1, "message": "...", "status": 5,
 *                          "statustext": "...", "sender": "...",
 *                          "receptor": "...", "cost": 900 }] }
 *
 * `entries` is a TOP-LEVEL sibling of `return` in the provider's documented
 * send reply (kavenegar.com/rest.html), not a child of it. The Phase 37 parser
 * read `return.entries`, which always yielded an empty list — the message id
 * fell back to a timestamp and the per-message `cost` was discarded. Both
 * shapes are accepted now so recorded fixtures from either era replay, and the
 * cost is carried through as `costRial` for wholesale reconciliation.
 *
 * The `return.status` is the API result: 200 means accepted; 400/401/403/406/…
 * are rejections, many of which (invalid number, blocked word, exhausted panel
 * credit) must never be retried. A per-entry `status` reflects later delivery
 * and is the input to fetchStatus.
 */

export const KAVENEGAR_BASE_URL = "https://api.kavenegar.com/v1";

export interface KavenegarSendRequest {
  url: string;
  params: Record<string, string>;
}

export function buildKavenegarSendRequest(input: {
  apiKey: string;
  sender: string;
  receptor: string;
  message: string;
}): KavenegarSendRequest {
  return {
    url: `${KAVENEGAR_BASE_URL}/${encodeURIComponent(input.apiKey)}/sms/send.json`,
    params: {
      receptor: input.receptor,
      message: input.message,
      ...(input.sender ? { sender: input.sender } : {}),
    },
  };
}

export interface KavenegarSendEntry {
  messageid: string;
  receptor: string;
  status: number;
  /** Provider-reported wholesale cost in Rial, when the reply carries one. */
  costRial: number | null;
}

export interface KavenegarApiResponse {
  status: number;
  message: string;
  entries: KavenegarSendEntry[];
}

/** Parse a Kavenegar HTTP JSON reply body. Throws only on malformed JSON. */
export function parseKavenegarResponse(body: string): KavenegarApiResponse | null {
  const parsed = JSON.parse(body) as {
    return?: { status?: unknown; message?: unknown; entries?: unknown };
    entries?: unknown;
  };
  const inner = parsed.return;
  if (!inner || typeof inner !== "object") return null;
  const status = Number(inner.status ?? 0);
  // Documented shape first (top-level `entries`), legacy nesting second.
  const rawEntries = Array.isArray(parsed.entries)
    ? parsed.entries
    : Array.isArray(inner.entries)
      ? inner.entries
      : [];
  return {
    status,
    message: String(inner.message ?? ""),
    entries: rawEntries.map((e: Record<string, unknown>) => {
      const cost = Number(e.cost);
      return {
        messageid: String(e.messageid ?? ""),
        receptor: String(e.receptor ?? ""),
        status: Number(e.status ?? 0),
        costRial: Number.isFinite(cost) && cost >= 0 ? cost : null,
      };
    }),
  };
}

/**
 * Which Kavenegar statuses mean "never try this again" (an address or message
 * the panel will keep rejecting) versus "transient".
 */
export const KAVENEGAR_PERMANENT_STATUSES: ReadonlySet<number> = new Set([
  400, // خطا در ارسال
  401, // کلید نامعتبر
  402, // درگاه غیر فعال یا اعتبار پنل تمام شده
  403, // ... (permanent account rejection)
  404, // شماره گیرنده نامعتبر
  406, // متن پیام شامل کلمه ممنوعه
  407, // ... 
  409, // ارسال تکراری
  411, // خطا در اعتبار سنجی
  412, // خطا در دریافت شماره / گیرنده نامعتبر
  413, // پنل غیرفعال
  414, // شماره فرستنده نامعتبر
]);

/** Map a Kavenegar API `status` (its `return.status`) onto a SendResult. */
export function kavenegarApiStatusToResult(api: KavenegarApiResponse): {
  ok: boolean;
  retryable: boolean;
  code: string;
  providerMessageId?: string;
} {
  const ok = api.status === 200;
  if (!ok) {
    const permanent = KAVENEGAR_PERMANENT_STATUSES.has(api.status);
    return {
      ok: false,
      retryable: !permanent,
      code: permanent ? mapPermanentCode(api.status) : "provider_unavailable",
      providerMessageId: api.entries[0]?.messageid,
    };
  }
  return {
    ok: true,
    retryable: false,
    code: "ok",
    providerMessageId: api.entries[0]?.messageid,
  };
}

function mapPermanentCode(status: number): string {
  switch (status) {
    case 404:
    case 412:
      return "invalid_number";
    case 406:
      return "blocked_word";
    case 402:
      return "credit_exhausted";
    case 414:
      return "invalid_number";
    default:
      return "provider_rejected";
  }
}
