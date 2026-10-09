import { describe, expect, it } from "vitest";
import {
  buildReceiptExtractionPrompt,
  MAX_RECEIPT_IMAGE_BYTES,
  parseReceiptExtractionReply,
  parseReceiptImageDataUrl,
  RECEIPT_EXTRACTION_SYSTEM_PROMPT,
} from "./ai-receipt";

const SMALL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("parseReceiptImageDataUrl", () => {
  it("accepts a well-formed jpeg/png/webp data URL", () => {
    expect(parseReceiptImageDataUrl(`data:image/png;base64,${SMALL_PNG_BASE64}`)).toEqual({
      mimeType: "image/png",
      dataUrl: `data:image/png;base64,${SMALL_PNG_BASE64}`,
    });
  });

  it("rejects a non-string, malformed, or unsupported-type value", () => {
    expect(parseReceiptImageDataUrl(undefined)).toBeNull();
    expect(parseReceiptImageDataUrl(42)).toBeNull();
    expect(parseReceiptImageDataUrl("not a data url")).toBeNull();
    expect(parseReceiptImageDataUrl(`data:image/gif;base64,${SMALL_PNG_BASE64}`)).toBeNull();
    expect(parseReceiptImageDataUrl("data:image/png;base64,")).toBeNull();
  });

  it("rejects a base64 payload over the size ceiling", () => {
    const huge = "A".repeat(Math.ceil((MAX_RECEIPT_IMAGE_BYTES * 4) / 3) + 2048);
    expect(parseReceiptImageDataUrl(`data:image/jpeg;base64,${huge}`)).toBeNull();
  });
});

describe("parseReceiptExtractionReply", () => {
  it("parses a well-formed JSON reply", () => {
    const reply = JSON.stringify({
      vendor: "سوپرمارکت رضا",
      expenseDate: "2026-07-15",
      amount: 450000,
      memo: "خرید مواد اولیه",
      suggestedAccountCode: "5100",
    });
    expect(parseReceiptExtractionReply(reply)).toEqual({
      vendor: "سوپرمارکت رضا",
      expenseDate: "2026-07-15",
      amount: 450000,
      vatAmount: null,
      memo: "خرید مواد اولیه",
      suggestedAccountCode: "5100",
    });
  });

  it("strips a ```json code fence some models add anyway", () => {
    const reply = "```json\n" + JSON.stringify({ vendor: "الف", amount: 1000, memo: "م" }) + "\n```";
    const parsed = parseReceiptExtractionReply(reply);
    expect(parsed?.vendor).toBe("الف");
    expect(parsed?.amount).toBe(1000);
  });

  it("falls back to defaults/null for missing or invalid fields, never faking a number", () => {
    const reply = JSON.stringify({ amount: "not-a-number", vatAmount: "abc", suggestedAccountCode: "9999" });
    // Without a tenant list the parser can only shape-check, so `9999` survives
    // as a *suggestion* — the caller resolves it against the chart and drops it
    // there (which is what the route, the assistant and the picker all do).
    expect(parseReceiptExtractionReply(reply)).toEqual({
      vendor: null,
      expenseDate: null,
      amount: null,
      vatAmount: null,
      memo: "هزینهٔ استخراج‌شده از تصویر پیوست — پیش از تأیید بررسی شود",
      suggestedAccountCode: "9999",
    });
    expect(parseReceiptExtractionReply(reply, ["5200"])).toMatchObject({ suggestedAccountCode: null });
  });

  it("returns null for unparseable or non-object replies", () => {
    expect(parseReceiptExtractionReply("این یک متن معمولی است، نه JSON")).toBeNull();
    expect(parseReceiptExtractionReply("42")).toBeNull();
    expect(parseReceiptExtractionReply("")).toBeNull();
  });

  it("rejects a negative or zero amount and a malformed date", () => {
    const reply = JSON.stringify({ amount: -500, expenseDate: "not-a-date" });
    const parsed = parseReceiptExtractionReply(reply);
    expect(parsed?.amount).toBeNull();
    expect(parsed?.expenseDate).toBeNull();
  });
});

/*
 * Issue #832 §13 — the extraction may only speak this business's own chart.
 *
 * The prompt used to name a fixed list of F&B codes (5100/5300/5500…) and the
 * parser expected a four-digit `5xxx`, so a customised chart, another industry
 * or a «تعمیرات» subaccount could not be categorised at all, while a code the
 * tenant does not own could still come back and be offered to the accountant as
 * a suggestion. The chart is now the vocabulary and the allowed list is the
 * filter; `null` is the answer whenever the model improvises.
 */

const TENANT_ACCOUNTS = [
  { code: "5200", name: "اجاره" },
  { code: "53100", name: "تعمیرات تجهیزات" },
  { code: "5900", name: "متفرقه" },
];

describe("buildReceiptExtractionPrompt", () => {
  it("names the tenant's own accounts and nothing else", () => {
    const prompt = buildReceiptExtractionPrompt(TENANT_ACCOUNTS);
    for (const account of TENANT_ACCOUNTS) {
      expect(prompt).toContain(`${account.code} ${account.name}`);
    }
    // The F&B table must not leak into a tenant's prompt as a fallback either.
    expect(prompt).not.toContain("5100");
    expect(prompt).not.toContain("بهای تمام‌شده");
  });

  it("tells the model to answer null rather than invent, both with and without a chart", () => {
    expect(buildReceiptExtractionPrompt(TENANT_ACCOUNTS)).toContain("کد دیگری نساز");
    expect(RECEIPT_EXTRACTION_SYSTEM_PROMPT).toContain("هرگز عدد یا تاریخ حدسی جعل نکن");
    // An empty chart is not an error: the field is pinned to null.
    const empty = buildReceiptExtractionPrompt([]);
    expect(empty).toContain('"suggestedAccountCode": null');
    expect(empty).not.toContain("یکی از این کدهای");
  });

  it("keeps the account list bounded, so a huge chart cannot blow the prompt", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ code: `${5000 + i}`, name: `حساب ${i}` }));
    const prompt = buildReceiptExtractionPrompt(many);
    expect(prompt).toContain("5000 حساب 0");
    expect(prompt).not.toContain("5060 حساب 60");
  });

  it("asks for vatAmount as an optional field", () => {
    // §11: a receipt's VAT line is worth extracting, but only as a suggestion.
    expect(buildReceiptExtractionPrompt(TENANT_ACCOUNTS)).toContain('"vatAmount"');
    expect(RECEIPT_EXTRACTION_SYSTEM_PROMPT).toContain("مالیات بر ارزش افزوده");
  });
});

describe("parseReceiptExtractionReply — account vocabulary", () => {
  const reply = (extra: Record<string, unknown>) =>
    JSON.stringify({ vendor: "v", amount: 100000, memo: "m", ...extra });

  it("keeps a suggestion that is in the tenant's list", () => {
    expect(parseReceiptExtractionReply(reply({ suggestedAccountCode: "5200" }), ["5200", "5900"]))
      .toMatchObject({ suggestedAccountCode: "5200" });
  });

  it("drops a suggestion outside it, rather than offering somebody else's account", () => {
    for (const code of ["5100", "9999", "1100", "", "  ", "abc", "5200x"]) {
      expect(parseReceiptExtractionReply(reply({ suggestedAccountCode: code }), ["5200"]), code)
        .toMatchObject({ suggestedAccountCode: null });
    }
  });

  it("accepts a chart that is not four digits, because a chart may be anything", () => {
    expect(parseReceiptExtractionReply(reply({ suggestedAccountCode: "53100" }), ["53100"]))
      .toMatchObject({ suggestedAccountCode: "53100" });
    expect(parseReceiptExtractionReply(reply({ suggestedAccountCode: "05200" }), ["05200"]))
      .toMatchObject({ suggestedAccountCode: "05200" });
  });

  it("still shape-checks a code when the caller has no list to filter by", () => {
    // A bare code is not *validated* without the tenant's list — that is the
    // service's job at write time — but it has to at least be a code.
    expect(parseReceiptExtractionReply(reply({ suggestedAccountCode: "5200" })))
      .toMatchObject({ suggestedAccountCode: "5200" });
    expect(parseReceiptExtractionReply(reply({ suggestedAccountCode: "DROP TABLE" })))
      .toMatchObject({ suggestedAccountCode: null });
  });

  it("tolerates a numeric code, which is what a JSON model tends to emit", () => {
    expect(parseReceiptExtractionReply(reply({ suggestedAccountCode: 5200 }), ["5200"]))
      .toMatchObject({ suggestedAccountCode: null });
    expect(parseReceiptExtractionReply(reply({ suggestedAccountCode: " 5200 " }), ["5200"]))
      .toMatchObject({ suggestedAccountCode: "5200" });
  });
});

describe("parseReceiptExtractionReply — vatAmount", () => {
  it("carries a plausible VAT line through", () => {
    expect(parseReceiptExtractionReply(JSON.stringify({ amount: 1_210_000, vatAmount: 210_000 })))
      .toMatchObject({ vatAmount: 210_000 });
  });

  it("never returns a VAT that is not smaller than the gross it belongs to", () => {
    // The misread-a-total case: the draft must not become an impossible expense
    // (`vat_amount >= amount` is also a CHECK the database would refuse).
    for (const vat of [1_210_000, 5_000_000, -1, 0, "not-a-number", null, undefined]) {
      expect(parseReceiptExtractionReply(JSON.stringify({ amount: 1_210_000, vatAmount: vat })))
        .toMatchObject({ vatAmount: null });
    }
  });

  it("rounds a fractional reading to rial, like the amount", () => {
    // Both numbers are rounded *before* the "VAT must be less than the gross"
    // test, so 100.4/9.6 becomes a legal 100/10 pair rather than a refusal.
    expect(parseReceiptExtractionReply(JSON.stringify({ amount: 100.4, vatAmount: 9.6 })))
      .toMatchObject({ amount: 100, vatAmount: 10 });
    expect(parseReceiptExtractionReply(JSON.stringify({ amount: 100, vatAmount: 1.4 })))
      .toMatchObject({ amount: 100, vatAmount: 1 });
  });
});
