/**
 * Server-side attachment pipeline for the AI chat (Wave 5 extension —
 * "upload image and PDF").
 *
 * The original receipt flow accepted exactly one validated image data URL
 * that was used for exactly one isolated vision call. This module extends the
 * contract to a small list of attachments — receipt photos *and* PDF documents.
 * Images are persisted best-effort in the tenant Media Library with conversation
 * provenance; PDFs remain one-turn ephemeral after their text is extracted.
 *
 * PDFs are handled differently from images by necessity: the OpenAI-compatible
 * providers in use do not read PDF bytes, so the text layer is extracted
 * server-side (pdf.js via `unpdf`, imported lazily so the rest of the server
 * bundle never pays for it) and handed to the model once, as text, inside the
 * user message. A scanned PDF without a text layer yields a note instead of
 * an error — the turn still answers, and the model is told the document was
 * unreadable rather than being left to guess.
 */

import type { AgentMode } from "./ai";
import {
  MAX_ATTACHMENT_PDF_BYTES,
  MAX_ATTACHMENT_TEXT_BYTES,
  MAX_ATTACHMENTS,
  MAX_PDF_PAGES,
  MAX_PDF_TEXT_CHARS,
} from "./ai-attachment-limits";
import { parseReceiptImageDataUrl } from "./ai-receipt";
import type { ChatAttachment } from "./ai-service";
import { hasMatchingMediaSignature } from "./media";
import { MAX_ATTACHMENT_IMAGE_BYTES } from "./ai-attachment-limits";
import { parseAttachmentSource } from "./ai-attachment-source";

function decodedBase64(value: string, maxBytes: number): Buffer | null {
  const bytes = Buffer.from(value, "base64");
  return bytes.length > 0 && bytes.length <= maxBytes && bytes.toString("base64") === value ? bytes : null;
}

/** Base64 inflates by ~4/3; cap the encoded string a bit above that ratio. */
const MAX_PDF_DATA_URL_BASE64_LENGTH =
  Math.ceil((MAX_ATTACHMENT_PDF_BYTES * 4) / 3) + 1024;

const PDF_DATA_URL_RE = /^data:(application\/pdf);base64,([A-Za-z0-9+/]+=*)$/;

export function parsePdfDataUrl(value: string): { dataUrl: string } | null {
  const trimmed = value.trim();
  const match = PDF_DATA_URL_RE.exec(trimmed);
  if (!match) return null;
  const base64 = match[2];
  if (base64.length === 0 || base64.length > MAX_PDF_DATA_URL_BASE64_LENGTH) {
    return null;
  }
  const bytes = decodedBase64(base64, MAX_ATTACHMENT_PDF_BYTES);
  if (!bytes || !hasMatchingMediaSignature("application/pdf", bytes)) return null;
  return { dataUrl: trimmed };
}

// UTF-8 text and CSV can be analyzed without asking the gateway to accept
// native Office/video binary formats. Invalid encoding, oversized bodies and
// control-character payloads fail before reaching the provider.
const TEXT_DATA_URL_RE = /^data:(text\/plain|text\/csv|text\/markdown);base64,([A-Za-z0-9+/]+=*)$/;
const MAX_TEXT_BASE64 = Math.ceil(MAX_ATTACHMENT_TEXT_BYTES * 4 / 3) + 4;
export function parseTextDataUrl(value: string): { dataUrl: string; text: string; truncated: boolean } | null {
  const match = TEXT_DATA_URL_RE.exec(value.trim());
  if (!match?.[2] || match[2].length > MAX_TEXT_BASE64) return null;
  try {
    const bytes = decodedBase64(match[2], MAX_ATTACHMENT_TEXT_BYTES);
    if (!bytes) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return null;
    const truncated = text.length > MAX_PDF_TEXT_CHARS;
    return { dataUrl: value.trim(), text: text.slice(0, MAX_PDF_TEXT_CHARS), truncated };
  } catch {
    return null;
  }
}

/**
 * Validates the client-supplied attachment list. Accepts the legacy single
 * object (`attachment`) or an array (`attachments`). Non-dashboard modes never
 * accept attachments — same scope as the original receipt flow. Any invalid
 * entry fails the whole request rather than silently dropping one.
 */
export function parseChatAttachments(
  mode: AgentMode,
  raw: unknown,
): { attachments: ChatAttachment[]; error: boolean } {
  if (mode !== "dashboard" || raw === undefined || raw === null) {
    return { attachments: [], error: false };
  }
  if (typeof raw !== "object") return { attachments: [], error: true };

  const list: unknown[] = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) return { attachments: [], error: false };
  if (list.length > MAX_ATTACHMENTS) return { attachments: [], error: true };

  const attachments: ChatAttachment[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") return { attachments: [], error: true };
    const rawSource = (item as { source?: unknown }).source;
    const source = rawSource === undefined ? undefined : parseAttachmentSource(rawSource);
    if (source === null) return { attachments: [], error: true };
    const dataUrl = (item as { dataUrl?: unknown }).dataUrl;
    if (typeof dataUrl !== "string") return { attachments: [], error: true };
    const name =
      typeof (item as { name?: unknown }).name === "string"
        ? (item as { name: string }).name.slice(0, 120)
        : undefined;

    const pdf = parsePdfDataUrl(dataUrl);
    if (pdf) {
      if (source) return { attachments: [], error: true };
      attachments.push({ kind: "pdf", dataUrl: pdf.dataUrl, name });
      continue;
    }
    const text = parseTextDataUrl(dataUrl);
    if (text) {
      if (source) return { attachments: [], error: true };
      attachments.push({ kind: "text", dataUrl: text.dataUrl, name });
      continue;
    }
    const image = parseReceiptImageDataUrl(dataUrl);
    if (image) {
      const bytes = decodedBase64(image.dataUrl.split(",")[1], MAX_ATTACHMENT_IMAGE_BYTES);
      if (!bytes || !hasMatchingMediaSignature(image.mimeType, bytes)) return { attachments: [], error: true };
      attachments.push({ kind: "image", dataUrl: image.dataUrl, name, ...(source ? { source } : {}) });
      continue;
    }
    return { attachments: [], error: true };
  }
  return { attachments, error: false };
}

export interface ExtractedPdf {
  text: string;
  truncated: boolean;
}

// The pdf.js bundle is imported lazily so every other server bundle that
// transitively imports this module (tests included) never loads it.
let unpdfPromise: Promise<typeof import("unpdf")> | null = null;
function loadUnpdf(): Promise<typeof import("unpdf")> {
  unpdfPromise ??= import("unpdf");
  return unpdfPromise;
}

/**
 * Extracts the text layer of a PDF data URL, capped at MAX_PDF_PAGES pages and
 * MAX_PDF_TEXT_CHARS characters. Returns null when the document is unreadable
 * or has no extractable text — never throws.
 */
export async function extractPdfText(dataUrl: string): Promise<ExtractedPdf | null> {
  try {
    const unpdf = await loadUnpdf();
    const base64 = PDF_DATA_URL_RE.exec(dataUrl)?.[2];
    if (!base64) return null;
    const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
    const document = await unpdf.getDocumentProxy(bytes);
    try {
      let text = "";
      let truncated = document.numPages > MAX_PDF_PAGES;
      for (let index = 1; index <= Math.min(document.numPages, MAX_PDF_PAGES); index++) {
        const page = await document.getPage(index);
        try {
          const content = await page.getTextContent();
          const pageText = content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "").join("").trim();
          if (pageText) text += (text ? "\n\n" : "") + pageText;
          if (text.length > MAX_PDF_TEXT_CHARS) { truncated = true; break; }
        } finally { page.cleanup(); }
      }
      return text ? { text: text.slice(0, MAX_PDF_TEXT_CHARS), truncated } : null;
    } finally { await document.loadingTask.destroy(); }
  } catch {
    return null;
  }
}

/** Runs extraction for every PDF in the list; images pass through untouched. */
export async function prepareAttachments(
  attachments: ChatAttachment[],
): Promise<ChatAttachment[]> {
  return Promise.all(
    attachments.map(async (attachment) => {
      if (attachment.kind === "text" && attachment.dataUrl) {
        const text = parseTextDataUrl(attachment.dataUrl);
        return { ...attachment, extractedText: text?.text ?? null, truncated: text?.truncated ?? false };
      }
      if (attachment.kind !== "pdf" || !attachment.dataUrl) return attachment;
      const extracted = await extractPdfText(attachment.dataUrl);
      return { ...attachment, extractedText: extracted ? extracted.text : null, truncated: extracted?.truncated ?? false };
    }),
  );
}

/**
 * The Persian block appended to the latest user message for the provider call
 * so the model knows what the user attached. Images stay a single line — their
 * content is read by the `draft_expense_from_receipt` vision call — while PDF
 * text travels inline, once, so the main conversation loop stays plain text.
 */
export function attachmentContextBlock(attachments: ChatAttachment[]): string {
  if (attachments.length === 0) return "";
  const lines: string[] = ["«پیوست‌های کاربر در همین پیام:»"];
  attachments.forEach((attachment, index) => {
    const label = attachment.name ? ` «${attachment.name}»` : "";
    if (attachment.kind === "image") {
      lines.push(
        `${index + 1}) تصویر فاکتور/رسید${label} — اطلاعاتش با ابزار draft_expense_from_receipt استخراج می‌شود.`,
      );
      return;
    }
    const documentLabel = attachment.kind === "text" ? "فایل متنی" : "سند PDF";
    if (typeof attachment.extractedText === "string" && attachment.extractedText) {
      lines.push(
        `${index + 1}) ${documentLabel}${label} — متن استخراج‌شده:`,
        "«شروع متن سند»",
        attachment.extractedText,
        "«پایان متن سند»",
        attachment.truncated
          ? "متن سند طولانی بود و بخشی از آن حذف شد؛ اگر پاسخ به بخش حذف‌شده نیاز داشت از کاربر بپرس."
          : "",
      );
    } else {
      lines.push(
        `${index + 1}) ${documentLabel}${label} — متن قابل استخراج نداشت. اگر کاربر دربارهٔ محتوایش پرسید همین را صادقانه بگو و از او بخواه فایل خواناتر یا متن را ارسال کند.`,
      );
    }
  });
  return lines.filter(Boolean).join("\n");
}

/** Appends the attachment block to the latest user message for the provider. */
export function withAttachmentContext(
  messages: { role: "user" | "assistant"; content: string }[],
  attachments: ChatAttachment[],
): { role: "user" | "assistant"; content: string }[] {
  const block = attachmentContextBlock(attachments);
  if (!block || messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last.role !== "user") return messages;
  return [...messages.slice(0, -1), { ...last, content: `${last.content}\n\n${block}` }];
}
