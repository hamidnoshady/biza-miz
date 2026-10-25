import { describe, expect, it } from "vitest";
import PDFDocument from "pdfkit";
import {
  attachmentContextBlock,
  extractPdfText,
  parseChatAttachments,
  parsePdfDataUrl,
  parseTextDataUrl,
  prepareAttachments,
  withAttachmentContext,
} from "./ai-attachment";
import { MAX_ATTACHMENTS, MAX_PDF_TEXT_CHARS } from "./ai-attachment-limits";

const IMAGE_DATA_URL = "data:image/png;base64,AAAA";
const PDF_PREFIX = "data:application/pdf;base64,";

/** A tiny real PDF with a known text layer, built on the fly. */
async function buildPdf(text: string): Promise<string> {
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.font("Helvetica").fontSize(12).text(text);
    doc.end();
  });
  return PDF_PREFIX + buffer.toString("base64");
}

describe("parsePdfDataUrl", () => {
  it("accepts a base64 PDF data URL", () => {
    expect(parsePdfDataUrl(`${PDF_PREFIX}${Buffer.from("x").toString("base64")}`)).not.toBeNull();
  });

  it("rejects other mime types and non-data URLs", () => {
    expect(parsePdfDataUrl(IMAGE_DATA_URL)).toBeNull();
    expect(parsePdfDataUrl("https://example.com/a.pdf")).toBeNull();
    expect(parsePdfDataUrl("data:application/pdf;base64,!!!")).toBeNull();
  });

  it("rejects a PDF beyond the encoded length ceiling", () => {
    expect(parsePdfDataUrl(`${PDF_PREFIX}${"A".repeat(20 * 1024 * 1024)}`)).toBeNull();
  });
});

describe("parseChatAttachments", () => {
  it("returns an empty list for non-dashboard modes without an error", () => {
    for (const mode of ["wizard", "floor", "platform", "proactive", "autopilot"] as const) {
      const parsed = parseChatAttachments(mode, [{ dataUrl: IMAGE_DATA_URL }]);
      expect(parsed).toEqual({ attachments: [], error: false });
    }
  });

  it("accepts the legacy single-object shape", () => {
    const parsed = parseChatAttachments("dashboard", { dataUrl: IMAGE_DATA_URL });
    expect(parsed.error).toBe(false);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({ kind: "image", dataUrl: IMAGE_DATA_URL });
  });

  it("accepts a mixed image + PDF list and keeps the file name", async () => {
    const pdf = await buildPdf("invoice");
    const parsed = parseChatAttachments("dashboard", [
      { dataUrl: IMAGE_DATA_URL, name: "receipt.png" },
      { dataUrl: pdf, name: "invoice.pdf" },
    ]);
    expect(parsed.error).toBe(false);
    expect(parsed.attachments.map((a) => a.kind)).toEqual(["image", "pdf"]);
    expect(parsed.attachments[0].name).toBe("receipt.png");
  });

  it("rejects more than the attachment ceiling", () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({ dataUrl: IMAGE_DATA_URL }));
    expect(parseChatAttachments("dashboard", many).error).toBe(true);
  });

  it("rejects any invalid entry rather than dropping it silently", () => {
    expect(
      parseChatAttachments("dashboard", [
        { dataUrl: IMAGE_DATA_URL },
        { dataUrl: "data:text/plain;base64,AAAA" },
      ]).error,
    ).toBe(true);
    expect(parseChatAttachments("dashboard", [{ dataUrl: 42 }]).error).toBe(true);
    expect(parseChatAttachments("dashboard", "nonsense").error).toBe(true);
  });

  it("truncates an absurdly long file name", () => {
    const parsed = parseChatAttachments("dashboard", {
      dataUrl: IMAGE_DATA_URL,
      name: "x".repeat(500),
    });
    expect(parsed.error).toBe(false);
    expect(parsed.attachments[0].name).toHaveLength(120);
  });
});

describe("UTF-8/CSV attachment handling", () => {
  const data = (text: string, mime = "text/plain") =>
    `data:${mime};base64,${Buffer.from(text, "utf8").toString("base64")}`;

  it("decodes a bounded UTF-8 CSV and includes it for the model", async () => {
    const csv = data("name,total\\nکافه,8900", "text/csv");
    const parsed = parseChatAttachments("dashboard", [{ dataUrl: csv, name: "sales.csv" }]);
    expect(parsed.error).toBe(false);
    expect(parsed.attachments[0].kind).toBe("text");
    const prepared = await prepareAttachments(parsed.attachments);
    expect(prepared[0].extractedText).toContain("کافه");
    expect(attachmentContextBlock(prepared)).toContain("8900");
  });

  it("rejects binary, malformed UTF-8, non-whitelisted MIME and over-limit text", () => {
    expect(parseTextDataUrl(data(String.fromCharCode(0, 1)))).toBeNull();
    expect(parseTextDataUrl("data:text/plain;base64," + Buffer.from([0xff, 0xfe]).toString("base64"))).toBeNull();
    expect(parseTextDataUrl(data("payload", "application/vnd.ms-excel"))).toBeNull();
    expect(parseTextDataUrl(data("a".repeat(1024 * 1024 + 1)))).toBeNull();
  });
});

describe("extractPdfText", () => {
  it("extracts the text layer of a real PDF", async () => {
    const pdf = await buildPdf("Total 450000 Rial invoice");
    const extracted = await extractPdfText(pdf);
    expect(extracted).not.toBeNull();
    expect(extracted!.text).toContain("450000");
    expect(extracted!.truncated).toBe(false);
  });

  it("returns null for garbage bytes instead of throwing", async () => {
    const garbage = `${PDF_PREFIX}${Buffer.from("this is not a pdf at all").toString("base64")}`;
    await expect(extractPdfText(garbage)).resolves.toBeNull();
  });

  it("flags truncation when the text exceeds the ceiling", async () => {
    const pdf = await buildPdf("word ".repeat(MAX_PDF_TEXT_CHARS / 5 + 10));
    const extracted = await extractPdfText(pdf);
    expect(extracted).not.toBeNull();
    expect(extracted!.truncated).toBe(true);
    expect(extracted!.text.length).toBeLessThanOrEqual(MAX_PDF_TEXT_CHARS);
  }, 30_000);
});

describe("prepareAttachments", () => {
  it("passes images through and fills PDFs with extracted text", async () => {
    const pdf = await buildPdf("the amount is 123000");
    const prepared = await prepareAttachments([
      { kind: "image", dataUrl: IMAGE_DATA_URL },
      { kind: "pdf", dataUrl: pdf },
    ]);
    expect(prepared[0]).toEqual({ kind: "image", dataUrl: IMAGE_DATA_URL });
    expect(prepared[1].extractedText).toContain("123000");
  });

  it("marks unreadable PDFs with null text instead of failing the turn", async () => {
    const prepared = await prepareAttachments([
      { kind: "pdf", dataUrl: `${PDF_PREFIX}${Buffer.from("nope").toString("base64")}` },
    ]);
    expect(prepared[0].extractedText).toBeNull();
  });
});

describe("attachmentContextBlock / withAttachmentContext", () => {
  it("mentions images by one line and carries PDF text inline", async () => {
    const pdf = await buildPdf("grand total 98000");
    const prepared = await prepareAttachments([
      { kind: "image", dataUrl: IMAGE_DATA_URL, name: "faks.png" },
      { kind: "pdf", dataUrl: pdf, name: "bill.pdf" },
    ]);
    const block = attachmentContextBlock(prepared);
    expect(block).toContain("«faks.png»");
    expect(block).toContain("draft_expense_from_receipt");
    expect(block).toContain("«bill.pdf»");
    expect(block).toContain("grand total 98000");
  });

  it("explains an unreadable PDF instead of leaving the model guessing", () => {
    const block = attachmentContextBlock([
      { kind: "pdf", extractedText: null, name: "scan.pdf" },
    ]);
    expect(block).toContain("متن قابل استخراج نداشت");
  });

  it("appends the block only to the latest user message", () => {
    const messages = [
      { role: "user" as const, content: "q1" },
      { role: "assistant" as const, content: "a1" },
      { role: "user" as const, content: "q2" },
    ];
    const attachments = [{ kind: "pdf" as const, extractedText: "text", name: "a.pdf" }];
    const out = withAttachmentContext(messages, attachments);
    expect(out).toHaveLength(3);
    expect(out[0].content).toBe("q1");
    expect(out[1].content).toBe("a1");
    expect(out[2].content).toContain("q2");
    expect(out[2].content).toContain("text");
  });

  it("leaves messages untouched when nothing is attached or the list is empty", () => {
    const messages = [{ role: "user" as const, content: "q" }];
    expect(withAttachmentContext(messages, [])).toEqual(messages);
    expect(withAttachmentContext([], [{ kind: "pdf" as const, extractedText: "t" }])).toEqual([]);
  });
});
