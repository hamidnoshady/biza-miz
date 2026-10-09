/**
 * Pure helpers for the "attach a receipt photo" flow: the prompt, its parser,
 * and the image's shape limits. Nothing here touches the database or the object
 * store, which is what lets both AI receipt channels share one definition.
 *
 * ## Where the image goes (issue #832 §14 — the documented decision)
 *
 * The two channels are deliberately different, and both are honest about it:
 *
 *   - **AI Chat's `draft_expense_from_receipt`** (`ai-service.ts`): the data URL
 *     is used for exactly one provider call and is never written anywhere. No
 *     row, no object, no lifecycle question.
 *   - **Accounting's `POST /api/ai/receipt-ocr`**: the photo becomes a real
 *     Media Library asset *before* the expense is recorded, and **stays there if
 *     the person abandons the form** — option 1 of the three the audit named.
 *     It is a user upload by a member holding `finance.expenses_manage`, into
 *     their own library, deduplicated by the tenant-scoped SHA-256 the manual
 *     upload path uses, owned by `media_assets` and browsable in `/media`; there
 *     is no second file store and no temporary bucket to leak into.
 *
 * Why not "temporary until confirmed": that would need a promotion step, a
 * sweeper for whatever is never promoted, and — worst — it would throw away both
 * the asset and the metered provider call that read it when the only thing that
 * went wrong was that somebody got interrupted mid-form. An abandoned upload costs
 * storage and is deletable in the library; a receipt that vanishes from behind an
 * expense that still points at it is the failure mode this avoids, which is also
 * why 0177's `receipt_asset_id` is `ON DELETE SET NULL` and why 0211 snapshots the
 * file name beside it.
 *
 * The provider is the platform's single OpenAI-compatible connection (Phase 18's
 * `platform_ai_config`, vision-capable on both defaults), not a second OCR
 * vendor.
 */

/** ~5MB of original file bytes: generous for a phone photo of a receipt. */
export const MAX_RECEIPT_IMAGE_BYTES = 5 * 1024 * 1024;

/** Base64 inflates by ~4/3; cap the encoded string a bit above that ratio. */
const MAX_RECEIPT_DATA_URL_BASE64_LENGTH = Math.ceil((MAX_RECEIPT_IMAGE_BYTES * 4) / 3) + 1024;

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/;

export interface ParsedReceiptImage {
  mimeType: string;
  dataUrl: string;
}

/**
 * Validates a client-supplied `data:image/...;base64,...` string without
 * decoding it — format, an allowed image type, and a size ceiling. Returns
 * null for anything else so the caller can refuse the turn with a clear
 * error instead of forwarding an oversized or unsupported payload.
 */
export function parseReceiptImageDataUrl(value: unknown): ParsedReceiptImage | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = DATA_URL_RE.exec(trimmed);
  if (!match) return null;
  const [, mimeType, base64] = match;
  if (!ALLOWED_MIME_TYPES.has(mimeType)) return null;
  if (base64.length === 0 || base64.length > MAX_RECEIPT_DATA_URL_BASE64_LENGTH) return null;
  return { mimeType, dataUrl: trimmed };
}

export interface ReceiptDraftFields {
  vendor: string | null;
  /** ISO date (YYYY-MM-DD), best-effort. */
  expenseDate: string | null;
  /** Integer Rial, best-effort — the *gross* total on the receipt. */
  amount: number | null;
  /**
   * The VAT part of `amount`, when the receipt shows one (issue #832 §11). A
   * suggestion only: the person can see and change it before anything posts.
   */
  vatAmount: number | null;
  memo: string;
  /**
   * A code from the *caller's* list of this business's own expense accounts
   * (issue #832 §13) — never a code invented from a fixed table, and `null`
   * when the list was empty or the model named something outside it.
   */
  suggestedAccountCode: string | null;
}

const DEFAULT_MEMO = "هزینهٔ استخراج‌شده از تصویر پیوست — پیش از تأیید بررسی شود";
const FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
// Any numeric chart code — 4-digit, 5-digit, a business that numbers its accounts
// differently. What *narrows* it to a real account is `allowedAccountCodes`
// below, never a pattern.
const ACCOUNT_CODE_RE = /^\d{3,10}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses the receipt-extraction provider reply into structured fields.
 * Tolerates a ```json fence around the object (some models add one despite
 * being asked for raw JSON) and never throws — an unparseable or
 * wrong-shaped reply returns null so the caller can tell the user extraction
 * failed instead of proposing an expense with made-up numbers.
 *
 * `allowedAccountCodes` is the tenant's own expense accounts. When it is given,
 * a suggestion outside it becomes `null`: the model proposes, this narrows, and
 * the chart still decides at write time. When it is absent the shape check above
 * is all there is — the caller is expected to validate before anything posts.
 */
export function parseReceiptExtractionReply(
  raw: string,
  allowedAccountCodes?: readonly string[],
): ReceiptDraftFields | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const unfenced = FENCE_RE.exec(trimmed)?.[1]?.trim() ?? trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const amount = Number(obj.amount);
  const vat = Number(obj.vatAmount);
  const expenseDate = typeof obj.expenseDate === "string" ? obj.expenseDate.slice(0, 10) : "";
  const suggested = typeof obj.suggestedAccountCode === "string" ? obj.suggestedAccountCode.trim() : "";
  const suggestedOk =
    ACCOUNT_CODE_RE.test(suggested) &&
    (allowedAccountCodes === undefined || allowedAccountCodes.includes(suggested));

  return {
    vendor: typeof obj.vendor === "string" && obj.vendor.trim() ? obj.vendor.trim().slice(0, 200) : null,
    expenseDate: ISO_DATE_RE.test(expenseDate) ? expenseDate : null,
    amount: Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null,
    // Never more than the gross it belongs to: a receipt whose VAT line was
    // misread as bigger than its total must not become an impossible expense.
    vatAmount: Number.isFinite(vat) && vat > 0 && (amount === null || Math.round(vat) < Math.round(amount))
      ? Math.round(vat)
      : null,
    memo: typeof obj.memo === "string" && obj.memo.trim() ? obj.memo.trim().slice(0, 300) : DEFAULT_MEMO,
    suggestedAccountCode: suggestedOk ? suggested : null,
  };
}

/** One entry of the tenant's expense-account list handed to the model. */
export interface ReceiptAccountCandidate {
  code: string;
  name: string;
}

/**
 * The extraction prompt, built from *this business's* expense accounts.
 *
 * It used to name a fixed list of codes («5100 بهای تمام‌شده مواد، 5300 اجاره…»)
 * that only exists in the default F&B chart: a customised chart, another
 * industry, or a business that added a «تعمیرات» subaccount could not be
 * categorised by the assistant at all, and the model was invited to answer with
 * a code the tenant does not own (issue #832 §13). The chart is now the
 * vocabulary, so the suggestion is a code the server can genuinely validate.
 */
export function buildReceiptExtractionPrompt(accounts: readonly ReceiptAccountCandidate[]): string {
  const list = accounts
    .slice(0, 60)
    .map((account) => `${account.code} ${account.name}`)
    .join(" | ");
  const accountInstruction = list
    ? ` "suggestedAccountCode": string|null (یکی از این کدهای حسابِ هزینهٔ *همین کسب‌وکار* در صورت تناسب: ${list}. اگر هیچ‌کدام متناسب نیست، null بگذار و کد دیگری نساز.)`
    : ' "suggestedAccountCode": null (این کسب‌وکار فهرست حساب هزینهٔ قابل استفاده ندارد؛ هر کدی نساز.)';
  return (
    "تو یک استخراج‌کنندهٔ اطلاعات فاکتور/رسید هستی. فقط یک شیء JSON معتبر و خام برگردان، بدون توضیح یا متن اضافه:" +
    ' {"vendor": string|null, "expenseDate": string|null (YYYY-MM-DD میلادی), "amount": number|null (مبلغ کل به ریال، عدد صحیح),' +
    ' "vatAmount": number|null (مالیات بر ارزش افزودهٔ همین فاکتور به ریال، عدد صحیح؛ اگر در فاکتور قید نشده null),' +
    ' "memo": string (توضیح کوتاه فارسی),' +
    `${accountInstruction}. ` +
    "اگر مقداری از تصویر قابل تشخیص نیست، null بگذار؛ هرگز عدد یا تاریخ حدسی جعل نکن."
  );
}

/**
 * The prompt when no chart was supplied — kept for callers that extract without
 * an expense-account list. `buildReceiptExtractionPrompt([])` says the same
 * thing, and it is one definition rather than a second, drift-prone copy.
 */
export const RECEIPT_EXTRACTION_SYSTEM_PROMPT = buildReceiptExtractionPrompt([]);

/** User-facing instruction paired with the image content part. */
export const RECEIPT_EXTRACTION_USER_PROMPT =
  "اطلاعات این فاکتور/رسید را دقیقاً به‌صورت همان قالب JSON که در دستورالعمل سیستم آمده استخراج کن.";
