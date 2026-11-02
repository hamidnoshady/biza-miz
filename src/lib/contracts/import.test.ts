/**
 * Issue #908 — the contract importer, against files built byte by byte.
 *
 * Both readers are exercised on fixtures constructed here rather than on
 * checked-in binaries: a `.docx` is a ZIP of XML and a PDF's text is a content
 * stream, so the fixture can state exactly what the parser is supposed to see —
 * a heading style, a bulleted list whose numbering definition says `bullet`, a
 * table whose first row is the header, a page break, and a PDF whose glyph
 * codes only mean anything through its `ToUnicode` CMap. A recorded sample
 * would prove the parser reads *that* file; these prove it reads the format.
 *
 * The refusals are tested just as deliberately. A scanned PDF, a `.docx` that
 * is not one, and an oversized upload each have to fail with their own code,
 * because "import produced nothing" must never look like success — the sender
 * would then freeze and send a blank contract.
 */
import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_IMPORT_MAX_BYTES,
  importContractDocument,
  type ContractImportResult,
} from "./import";

/* ---------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------ */

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF_MIME = "application/pdf";

function paragraph(text: string, properties = ""): string {
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function listParagraph(text: string, numId: number, level = 0): string {
  return paragraph(text, `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`);
}

function cell(text: string): string {
  return `<w:tc>${paragraph(text)}</w:tc>`;
}

async function buildDocx(options: {
  body: string;
  numbering?: string;
  coreTitle?: string;
  documentPath?: string;
}): Promise<Uint8Array> {
  const zip = new JSZip();
  const body =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${options.body}</w:body></w:document>`;
  zip.file(options.documentPath ?? "word/document.xml", body);
  if (options.numbering) zip.file("word/numbering.xml", options.numbering);
  if (options.coreTitle !== undefined) {
    zip.file(
      "docProps/core.xml",
      `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/">` +
        `<dc:title>${options.coreTitle}</dc:title></cp:coreProperties>`,
    );
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  return new Uint8Array(buffer);
}

const NUMBERING = `<?xml version="1.0" encoding="UTF-8"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

/** One PDF page whose text can only be read through its `ToUnicode` CMap. */
function buildPdf(options: {
  cmap?: string;
  text: string;
  compress?: boolean;
}): Uint8Array {
  const content = options.compress ? deflateSync(Buffer.from(options.text, "latin1")) : Buffer.from(options.text, "latin1");
  const cmap = options.cmap ?? "";
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: Buffer | string) => {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
    parts.push(buffer);
    length += buffer.length;
  };
  const object = (number: number, body: Buffer | string) => {
    offsets[number] = length;
    push(`${number} 0 obj\n`);
    push(body);
    push("\nendobj\n");
  };

  push("%PDF-1.7\n");
  object(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  object(2, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
  object(
    3,
    `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>`,
  );
  object(
    4,
    `<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /ToUnicode 5 0 R >>`,
  );
  if (cmap) {
    object(5, `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
  } else {
    object(5, `null`);
  }
  object(
    6,
    options.compress
      ? Buffer.concat([
          Buffer.from(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
          content,
          Buffer.from("\nendstream", "latin1"),
        ])
      : `<< /Length ${content.length} >>\nstream\n${content.toString("latin1")}\nendstream`,
  );

  const xrefAt = length;
  push("xref\n0 7\n0000000000 65535 f \n");
  for (let index = 1; index <= 6; index += 1) {
    push(`${String(offsets[index] ?? 0).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(parts));
}

/** A CMap where code 1 is «م», 2 is «ت», 3 is «ن». */
const PERSIAN_CMAP = `/CIDInit /ProcSet findresource begin
12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
3 beginbfchar
<0001> <0645>
<0002> <062A>
<0003> <0646>
endbfchar
endcmap end end`;

function expectOk(result: ContractImportResult): Extract<ContractImportResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected an import, got ${result.error}: ${result.detail}`);
  return result;
}

/* ---------------------------------------------------------------------------
 * DOCX
 * ------------------------------------------------------------------------ */

describe("importing a Word document", () => {
  async function sample(): Promise<ContractImportResult> {
    const body = [
      paragraph("قرارداد پیمانکاری ساختمان", `<w:pStyle w:val="Heading1"/>`),
      paragraph("مادهٔ ۱ — موضوع قرارداد", `<w:pStyle w:val="Heading2"/>`),
      paragraph("این قرارداد میان کارفرما &amp; پیمان‌کار بسته می‌شود."),
      listParagraph("شرط نخست", 1),
      listParagraph("شرط دوم", 1),
      listParagraph("مرحلهٔ نخست", 2),
      listParagraph("مرحلهٔ دوم", 2),
      `<w:tbl>`,
      `<w:tr>${cell("شرح")}${cell("مبلغ (ریال)")}</w:tr>`,
      `<w:tr>${cell("اسکلت")}${cell("۱۲۵۰۰۰۰۰۰۰")}</w:tr>`,
      `<w:tr>${cell("نازک‌کاری")}${cell("۴۵۰۰۰۰۰۰۰")}</w:tr>`,
      `</w:tbl>`,
      paragraph("", `<w:rPr><w:br w:type="page"/></w:rPr>`).replace("<w:pPr>", "").replace("</w:pPr>", ""),
      paragraph("شرح خدمات در پیوست آمده است."),
    ].join("");
    return importContractDocument({
      bytes: await buildDocx({ body, numbering: NUMBERING, coreTitle: "پیمان اسکلت" }),
      fileName: "contract.docx",
      mimeType: DOCX_MIME,
    });
  }

  it("names the document after its first heading, which is what the page says", async () => {
    const result = expectOk(await sample());
    expect(result.source.format).toBe("docx");
    // Not `dc:title` — that says «پیمان اسکلت» and metadata is routinely stale.
    expect(result.content.title).toBe("قرارداد پیمانکاری ساختمان");
    expect(result.source.fileName).toBe("contract.docx");
    expect(result.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to the file's own title property when it has no heading", async () => {
    const result = expectOk(
      await importContractDocument({
        bytes: await buildDocx({
          body: paragraph("بدون عنوان مشخص در متن."),
          coreTitle: "پیمان اسکلت",
        }),
        fileName: "contract.docx",
      }),
    );
    expect(result.content.title).toBe("پیمان اسکلت");
  });

  it("falls back to the file name when there is neither", async () => {
    const result = expectOk(
      await importContractDocument({
        bytes: await buildDocx({ body: paragraph("متن بدون عنوان.") }),
        fileName: "قرارداد-نمونه.docx",
      }),
    );
    expect(result.content.title).toBe("قرارداد نمونه");
  });

  it("reads headings, paragraphs, both kinds of list, a table and a page break", async () => {
    const { content } = expectOk(await sample());
    expect(content.blocks.map((block) => block.type)).toEqual([
      "heading", // «مادهٔ ۱ — موضوع قرارداد»
      "paragraph",
      "bullets",
      "numbered",
      "table",
      "page_break",
      "paragraph",
    ]);
    // The first heading became the title instead of a duplicated block.
    const heading = content.blocks[0];
    expect(heading.type === "heading" && heading.text).toBe("مادهٔ ۱ — موضوع قرارداد");
  });

  it("keeps a bulleted list bulleted, because numbering.xml says so", async () => {
    const { content } = expectOk(await sample());
    const bullets = content.blocks.find((block) => block.type === "bullets");
    const numbered = content.blocks.find((block) => block.type === "numbered");
    expect(bullets?.type === "bullets" && bullets.items).toEqual(["شرط نخست", "شرط دوم"]);
    expect(numbered?.type === "numbered" && numbered.items).toEqual(["مرحلهٔ نخست", "مرحلهٔ دوم"]);
  });

  it("reads a table's first row as its header and keeps the rest as rows", async () => {
    const { content } = expectOk(await sample());
    const table = content.blocks.find((block) => block.type === "table");
    expect(table?.type === "table" && table.columns).toEqual(["شرح", "مبلغ (ریال)"]);
    expect(table?.type === "table" && table.rows).toEqual([
      ["اسکلت", "۱۲۵۰۰۰۰۰۰۰"],
      ["نازک‌کاری", "۴۵۰۰۰۰۰۰۰"],
    ]);
  });

  it("decodes XML entities instead of printing them", async () => {
    const { content } = expectOk(await sample());
    const body = content.blocks.find((block) => block.type === "paragraph");
    expect(body?.type === "paragraph" && body.text).toBe(
      "این قرارداد میان کارفرما & پیمان‌کار بسته می‌شود.",
    );
  });

  it("says what it could not carry over, rather than implying a perfect copy", async () => {
    const result = expectOk(await sample());
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    expect(result.warnings.join(" ")).toMatch(/ضخیم/);
    expect(result.warnings.join(" ")).toMatch(/جای امضا/);
    expect(result.stats.characters).toBeGreaterThan(0);
    expect(result.stats.tables).toBe(1);
    expect(result.stats.lists).toBe(2);
  });

  it("invents no variables: Word cannot say which words were meant to be filled", async () => {
    const { content } = expectOk(await sample());
    expect(content.fields).toEqual([]);
  });

  it("refuses a ZIP that is not a Word document", async () => {
    const zip = new JSZip();
    zip.file("readme.txt", "not a contract");
    const bytes = new Uint8Array(await zip.generateAsync({ type: "nodebuffer" }));
    const result = await importContractDocument({
      bytes,
      fileName: "archive.docx",
      mimeType: DOCX_MIME,
    });
    expect(result).toMatchObject({ ok: false, error: "docx_unreadable" });
  });
});

/* ---------------------------------------------------------------------------
 * PDF
 * ------------------------------------------------------------------------ */

describe("importing a PDF", () => {
  it("reads Persian text through the font's ToUnicode CMap", async () => {
    const result = await importContractDocument({
      bytes: buildPdf({
        cmap: PERSIAN_CMAP,
        text: "BT /F1 12 Tf <000100020003> Tj ET",
        compress: true,
      }),
      fileName: "contract.pdf",
      mimeType: PDF_MIME,
    });
    const { content } = expectOk(result);
    expect(content.blocks).toHaveLength(1);
    expect(content.blocks[0].type === "paragraph" && content.blocks[0].text).toBe("متن");
  });

  it("trusts the bytes over a declared type that disagrees, and says so", async () => {
    const result = await importContractDocument({
      bytes: buildPdf({ text: "BT /F1 12 Tf (Payment terms) Tj ET", compress: true }),
      fileName: "renamed.docx",
      // A `.docx` name and a Word MIME over PDF bytes: the parser follows the
      // magic bytes and the sender is told the file was mislabelled.
      mimeType: DOCX_MIME,
    });
    const { content, warnings } = expectOk(result);
    expect(content.blocks[0].type === "paragraph" && content.blocks[0].text).toBe("Payment terms");
    expect(warnings.join(" ")).toContain("یکی نیست");
  });

  it("reads an uncompressed content stream too", async () => {
    const result = await importContractDocument({
      bytes: buildPdf({ cmap: PERSIAN_CMAP, text: "BT /F1 10 Tf <00010002> Tj ET" }),
      fileName: "plain.pdf",
    });
    const { content } = expectOk(result);
    expect(content.blocks[0].type === "paragraph" && content.blocks[0].text).toBe("مت");
  });

  it("reads Latin text that needs no CMap", async () => {
    const result = await importContractDocument({
      bytes: buildPdf({ text: "BT /F1 12 Tf (Payment terms: 30 days) Tj ET", compress: true }),
      fileName: "latin.pdf",
    });
    const { content } = expectOk(result);
    expect(content.blocks[0].type === "paragraph" && content.blocks[0].text).toBe(
      "Payment terms: 30 days",
    );
  });

  it("turns separate text runs into separate paragraphs", async () => {
    const result = await importContractDocument({
      bytes: buildPdf({
        text: "BT /F1 12 Tf (Clause one.) Tj ET\nBT /F1 12 Tf (Clause two.) Tj ET",
      }),
      fileName: "two.pdf",
    });
    const { content } = expectOk(result);
    expect(content.blocks).toHaveLength(2);
  });

  it("refuses a scanned page instead of returning an empty contract", async () => {
    // No BT/Tj operators at all: this is an image, not text.
    const result = await importContractDocument({
      bytes: buildPdf({ text: "q 600 0 0 800 0 0 cm /Im0 Do Q" }),
      fileName: "scan.pdf",
      mimeType: PDF_MIME,
    });
    expect(result).toMatchObject({ ok: false, error: "pdf_no_text_layer" });
    if (!result.ok) expect(result.detail).toMatch(/اسکن/);
  });

  it("refuses text that decoded into garbage rather than importing noise", async () => {
    // Glyph codes with no CMap: the bytes are not characters, and a document of
    // `\u0001\u0002` is not a contract.
    const result = await importContractDocument({
      bytes: buildPdf({ text: "BT /F1 12 Tf <0001000200030004> Tj ET" }),
      fileName: "identity.pdf",
    });
    expect(result).toMatchObject({ ok: false, error: "pdf_no_text_layer" });
  });
});

/* ---------------------------------------------------------------------------
 * Refusals shared by both formats
 * ------------------------------------------------------------------------ */

describe("what the importer refuses before it parses", () => {
  it("refuses an upload over the size cap", async () => {
    const result = await importContractDocument({
      bytes: new Uint8Array(CONTRACT_IMPORT_MAX_BYTES + 1),
      fileName: "huge.pdf",
    });
    expect(result).toMatchObject({ ok: false, error: "file_too_large" });
  });

  it("refuses a format it cannot read, naming what is accepted", async () => {
    const result = await importContractDocument({
      bytes: new TextEncoder().encode("سلام"),
      fileName: "notes.txt",
      mimeType: "text/plain",
    });
    expect(result).toMatchObject({ ok: false, error: "unsupported_format" });
    if (!result.ok) expect(result.detail).toMatch(/\.docx/);
  });

  it("trusts the bytes, not the declared MIME type", async () => {
    // A PDF announced as a Word document is still read as a PDF.
    const result = expectOk(
      await importContractDocument({
        bytes: buildPdf({ text: "BT /F1 12 Tf (Signed by both parties) Tj ET" }),
        fileName: "disguised.docx",
        mimeType: DOCX_MIME,
      }),
    );
    expect(result.source.format).toBe("pdf");
  });

  it("refuses an empty document rather than saving nothing over a draft", async () => {
    const body = paragraph("   ");
    const result = await importContractDocument({
      bytes: await buildDocx({ body }),
      fileName: "blank.docx",
    });
    expect(result).toMatchObject({ ok: false, error: "empty_document" });
  });

  it("refuses a zero-byte upload", async () => {
    const result = await importContractDocument({ bytes: new Uint8Array(0), fileName: "empty.docx" });
    expect(result).toMatchObject({ ok: false });
  });
});
