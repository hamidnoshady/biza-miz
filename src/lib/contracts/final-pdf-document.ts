import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  conditionMatches,
  contractScheduleDates,
  tokenizeTemplate,
  type ContractBlock,
  type ContractDocumentContent,
} from "./blocks";

export interface FinalPdfSignature {
  fullName: string;
  signedAt: string;
  drawnImage: string | null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function richText(value: string, values: Record<string, string>): string {
  return tokenizeTemplate(value, values)
    .map((segment) =>
      escapeHtml(
        segment.kind === "text" ? segment.text : (segment.value ?? ""),
      ),
    )
    .join("");
}

function signatureImage(value: string | null): string | null {
  if (!value || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))
    return null;
  return value;
}

function renderBlock(
  block: ContractBlock,
  values: Record<string, string>,
  signed: Record<string, FinalPdfSignature>,
): string {
  switch (block.type) {
    case "heading":
      return `<h2 class="mt-6 mb-2 text-[15px] font-semibold text-foreground first:mt-0">${richText(block.text, values)}</h2>`;
    case "paragraph":
      return `<p class="mb-3 text-[13px] leading-7 text-foreground/90">${richText(block.text, values)}</p>`;
    case "conditional":
      return conditionMatches(block.condition, values)
        ? `<p class="mb-3 text-[13px] leading-7 text-foreground/90">${richText(block.text, values)}</p>`
        : "";
    case "schedule": {
      const dates = contractScheduleDates(
        block.startDate,
        block.count,
        block.intervalMonths,
      );
      const caption = block.caption
        ? `<figcaption class="mb-1 text-[12px] font-medium text-muted-foreground">${richText(block.caption, values)}</figcaption>`
        : "";
      const rows = dates
        .map(
          (date, index) => `<tr>
        <td class="border border-border px-2 py-1.5 text-foreground/90">${toPersianDigits(index + 1)}</td>
        <td class="border border-border px-2 py-1.5 text-foreground/90">${escapeHtml(formatJalali(date, { withMonthName: true }))}</td>
        <td class="border border-border px-2 py-1.5 text-foreground/90">${richText(block.amountText, values)}</td>
      </tr>`,
        )
        .join("");
      return `<figure class="mb-4">${caption}<table class="w-full border-collapse text-[12px]"><thead><tr>
        ${["قسط", "سررسید", "مبلغ"].map((heading) => `<th class="border border-border bg-muted/60 px-2 py-1.5 text-start font-medium text-foreground">${heading}</th>`).join("")}
      </tr></thead><tbody>${rows}</tbody></table></figure>`;
    }
    case "article":
      return `<section class="mb-3"><h3 class="mb-1 text-[13px] font-semibold text-foreground">${richText(block.title, values)}</h3>${block.text ? `<p class="text-[13px] leading-7 text-foreground/90">${richText(block.text, values)}</p>` : ""}</section>`;
    case "bullets":
    case "numbered": {
      const tag = block.type === "bullets" ? "ul" : "ol";
      const listClass = block.type === "bullets" ? "list-disc" : "list-decimal";
      const items = block.items
        .map((item) => `<li>${richText(item, values)}</li>`)
        .join("");
      return `<${tag} class="mb-3 space-y-1 ps-5 text-[13px] leading-7 text-foreground/90 ${listClass}">${items}</${tag}>`;
    }
    case "table": {
      const caption = block.caption
        ? `<figcaption class="mb-1 text-[12px] font-medium text-muted-foreground">${richText(block.caption, values)}</figcaption>`
        : "";
      const headers = block.columns
        .map(
          (column) =>
            `<th class="border border-border bg-muted/60 px-2 py-1.5 text-start font-medium text-foreground">${richText(column, values)}</th>`,
        )
        .join("");
      const rows = block.rows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td class="border border-border px-2 py-1.5 text-start text-foreground/90">${richText(cell, values)}</td>`).join("")}</tr>`,
        )
        .join("");
      return `<figure class="mb-4 overflow-x-auto">${caption}<table class="w-full border-collapse text-[12px]"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></figure>`;
    }
    case "divider":
      return `<hr class="my-5 border-border"/>`;
    case "page_break":
      return `<div class="my-6 border-t border-dashed border-border print:break-after-page" aria-hidden="true"></div>`;
    case "signature": {
      const signature = signed[block.slotId];
      const image = signatureImage(signature?.drawnImage ?? null);
      const signedContent = signature
        ? `<div class="space-y-1">${image ? `<img src="${image}" alt="امضای ${escapeHtml(signature.fullName)}" class="h-16 w-auto"/>` : ""}<p class="text-[12px] font-semibold text-foreground">${escapeHtml(signature.fullName)}</p><p class="text-[11px] text-muted-foreground">${escapeHtml(signature.signedAt)}</p></div>`
        : `<div class="h-16 rounded-lg border-b border-dashed border-border"></div>`;
      return `<div class="mt-6 mb-4 grid gap-3 sm:grid-cols-2"><div class="rounded-xl border border-border bg-card p-3"><p class="mb-2 text-[12px] font-medium text-foreground">${richText(block.label, values)}</p>${signedContent}<p class="mt-2 text-[11px] text-muted-foreground">${richText(block.caption, values)}</p></div></div>`;
    }
  }
  return "";
}

/**
 * Serializes a frozen contract to the same block structure as the shared
 * preview, without using ReactDOMServer inside a Next.js route bundle.
 * Every tenant-controlled value is escaped as text or an attribute.
 */
export function renderFinalPdfContractDocument(
  content: ContractDocumentContent,
  signed: Record<string, FinalPdfSignature>,
): string {
  const values = content.values ?? {};
  const header = content.headerText
    ? `<p class="mb-6 border-b border-border pb-3 text-[12px] text-muted-foreground">${richText(content.headerText, values)}</p>`
    : "";
  const title = richText(content.title || "—", values);
  const body = content.blocks
    .map((block) => renderBlock(block, values, signed))
    .join("");
  const footer = content.footerText
    ? `<footer class="mt-8 border-t border-border pt-3 text-[11px] text-muted-foreground">${richText(content.footerText, values)}</footer>`
    : "";
  return `<article dir="rtl" class="rounded-2xl border border-border/80 bg-card shadow-[0_1px_2px_rgb(41_37_36/0.035)] mx-auto w-full max-w-[210mm] px-6 py-8 text-foreground sm:px-10" aria-label="${escapeHtml(content.title)}">${header}<header class="mb-6 text-center"><h1 class="mt-1 text-lg font-semibold text-foreground">${title}</h1></header>${body}${footer}</article>`;
}
