/**
 * Issue #908 (phase A) — the contract DOCUMENT model: blocks, fields, their
 * validation and the variable substitution the editor, the preview, the print
 * view and the signer's page all share.
 *
 * This module is deliberately framework-free and dependency-free (no `next`,
 * no React, no `node:crypto`, no database) because the same file has to run in
 * three places that must not disagree:
 *
 *   - the server, when a draft is saved or a version is frozen;
 *   - the editor (a `"use client"` component), which renders the A4 preview
 *     live as the user types;
 *   - the public signer page, which renders the frozen snapshot it was handed.
 *
 * The rule that keeps those three honest: **the document is data, never HTML**.
 * A client sends blocks, the server normalises them through
 * `normalizeContractContent` (which drops anything it does not recognise, caps
 * every length and refuses an out-of-vocabulary value), and every renderer walks
 * the normalised tree. No user string is ever concatenated into markup, which is
 * what makes the XSS question on the public signer endpoint a non-question.
 *
 * Money stays integer Rial like every other money value in the product; the
 * only place it becomes a display string is `formatFieldValue`, which takes the
 * business's display unit as an argument rather than guessing one.
 */

/** What a block can be. Keeping this list closed is what makes validation total. */
export const CONTRACT_BLOCK_TYPES = [
  "heading",
  "paragraph",
  "article",
  "bullets",
  "numbered",
  "table",
  "divider",
  "page_break",
  "signature",
] as const;

export type ContractBlockType = (typeof CONTRACT_BLOCK_TYPES)[number];

/** Persian labels for the block library — the editor derives its palette from this. */
export const CONTRACT_BLOCK_LABELS: Record<ContractBlockType, string> = {
  heading: "عنوان",
  paragraph: "بند متنی",
  article: "مادهٔ قانونی",
  bullets: "فهرست نقطه‌ای",
  numbered: "فهرست شماره‌دار",
  table: "جدول",
  divider: "خط جداکننده",
  page_break: "شکستن صفحه",
  signature: "جای امضا",
};

/** One short sentence per block type, shown beside the label in the library. */
export const CONTRACT_BLOCK_HINTS: Record<ContractBlockType, string> = {
  heading: "عنوان بخش یا سرصفحهٔ داخلی سند",
  paragraph: "یک پاراگراف آزاد؛ متغیرها را با {{نام}} در آن جای می‌دهید",
  article: "«مادهٔ ۱ — موضوع قرارداد» با متن زیرش",
  bullets: "فهرست بدون ترتیب برای شرایط و ضمائم",
  numbered: "فهرست شماره‌دار برای تعهدات و مراحل",
  table: "جدول اقساط، اقلام یا مشخصات؛ سلول‌ها متغیر می‌پذیرند",
  divider: "خط نازک برای جدا کردن بخش‌ها",
  page_break: "شروع صفحهٔ بعد در چاپ و PDF",
  signature: "محل امضای یک طرف؛ در پاکت امضا به یک امضاکننده تخصیص می‌یابد",
};

export interface ContractBlockBase {
  /** Stable client-generated id; also the React key and the reorder handle. */
  id: string;
}

export interface ContractTextBlock extends ContractBlockBase {
  type: "heading" | "paragraph";
  text: string;
}

export interface ContractArticleBlock extends ContractBlockBase {
  type: "article";
  /** «مادهٔ ۱ — موضوع قرارداد». */
  title: string;
  text: string;
}

export interface ContractListBlock extends ContractBlockBase {
  type: "bullets" | "numbered";
  items: string[];
}

export interface ContractTableBlock extends ContractBlockBase {
  type: "table";
  caption: string;
  columns: string[];
  rows: string[][];
}

export interface ContractRuleBlock extends ContractBlockBase {
  type: "divider" | "page_break";
}

export interface ContractSignatureBlock extends ContractBlockBase {
  type: "signature";
  /** Referenced by `contract_signers.slot_id`; unique within the document. */
  slotId: string;
  /** «امضای کارفرما» — printed above the signature line. */
  label: string;
  /** «نام و نام خانوادگی، تاریخ» — the hint printed under the line. */
  caption: string;
}

export type ContractBlock =
  | ContractTextBlock
  | ContractArticleBlock
  | ContractListBlock
  | ContractTableBlock
  | ContractRuleBlock
  | ContractSignatureBlock;

/**
 * Where a field's value comes from.
 *
 * `source` names the record, `path` names the property on it. The catalogue of
 * permitted pairs lives in `bindings.ts` and is the ONLY thing the editor offers
 * — a free-text path would let one tenant's editor read a property another
 * tenant's contract never agreed to publish.
 */
export const CONTRACT_BINDING_SOURCES = ["contract", "project", "party", "business"] as const;
export type ContractBindingSource = (typeof CONTRACT_BINDING_SOURCES)[number];

export interface ContractFieldBinding {
  source: ContractBindingSource;
  path: string;
}

export const CONTRACT_FIELD_TYPES = [
  "text",
  "multiline",
  "number",
  "money",
  "date",
  "select",
  "checkbox",
] as const;
export type ContractFieldType = (typeof CONTRACT_FIELD_TYPES)[number];

export const CONTRACT_FIELD_TYPE_LABELS: Record<ContractFieldType, string> = {
  text: "متن کوتاه",
  multiline: "متن بلند",
  number: "عدد",
  money: "مبلغ (ریال)",
  date: "تاریخ",
  select: "انتخابی",
  checkbox: "بله/خیر",
};

export interface ContractField {
  /** Placeholder name, `{{key}}`. Latin identifier — it is a wire contract. */
  key: string;
  label: string;
  type: ContractFieldType;
  required: boolean;
  /** `null` = the value is typed by the sender (a literal). */
  binding: ContractFieldBinding | null;
  /** Choices for `select`; ignored for every other type. */
  options: string[];
  /** The literal value when there is no binding, or the manual override of one. */
  value: string;
}

export interface ContractDocumentContent {
  /** Model version. A future shape bumps it rather than guessing. */
  version: 1;
  title: string;
  headerText: string;
  footerText: string;
  blocks: ContractBlock[];
  fields: ContractField[];
  /**
   * Resolved `key → display string` for a FROZEN version. Absent on a draft:
   * a draft resolves its bindings at read time so a changed project date shows
   * up immediately, while a frozen version has already stopped moving.
   */
  values?: Record<string, string>;
}

export const CONTRACT_LIMITS = {
  titleMax: 200,
  headerMax: 2000,
  footerMax: 2000,
  blocksMax: 200,
  fieldsMax: 80,
  textMax: 8000,
  listItemsMax: 40,
  itemMax: 2000,
  tableColumnsMax: 8,
  tableRowsMax: 100,
  cellMax: 500,
  fieldValueMax: 4000,
  fieldLabelMax: 120,
  fieldKeyMax: 40,
  optionMax: 120,
  optionsMax: 20,
  slotIdMax: 40,
  signatureLabelMax: 120,
  captionMax: 200,
  signersMax: 10,
} as const;

const BLOCK_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;
/** `{{key}}` — the only substitution syntax, matched anywhere in a text value. */
const TOKEN = /\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function bool(value: unknown): boolean {
  return value === true;
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => text(item, maxLength));
}

/** Blocks the editor will not create but a stored document may contain. */
function blockId(value: unknown, index: number): string {
  const candidate = typeof value === "string" ? value : "";
  return BLOCK_ID.test(candidate) ? candidate : `b${index + 1}`;
}

function normalizeBlock(raw: unknown, index: number): ContractBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = blockId(r.id, index);
  switch (r.type) {
    case "heading":
    case "paragraph":
      return { id, type: r.type, text: text(r.text, CONTRACT_LIMITS.textMax) };
    case "article":
      return {
        id,
        type: "article",
        title: text(r.title, CONTRACT_LIMITS.textMax),
        text: text(r.text, CONTRACT_LIMITS.textMax),
      };
    case "bullets":
    case "numbered":
      return {
        id,
        type: r.type,
        items: stringList(r.items, CONTRACT_LIMITS.listItemsMax, CONTRACT_LIMITS.itemMax),
      };
    case "table": {
      const columns = stringList(
        r.columns,
        CONTRACT_LIMITS.tableColumnsMax,
        CONTRACT_LIMITS.cellMax,
      );
      const rows = Array.isArray(r.rows)
        ? r.rows
            .slice(0, CONTRACT_LIMITS.tableRowsMax)
            .map((row) => stringList(row, CONTRACT_LIMITS.tableColumnsMax, CONTRACT_LIMITS.cellMax))
        : [];
      return {
        id,
        type: "table",
        caption: text(r.caption, CONTRACT_LIMITS.captionMax),
        columns,
        // Ragged rows are padded/trimmed here rather than at render time, so
        // every consumer sees a rectangle.
        rows: rows.map((row) => columns.map((_, column) => row[column] ?? "")),
      };
    }
    case "divider":
    case "page_break":
      return { id, type: r.type };
    case "signature": {
      const slotId = text(r.slotId, CONTRACT_LIMITS.slotIdMax).trim();
      return {
        id,
        type: "signature",
        slotId: BLOCK_ID.test(slotId) ? slotId : `sig_${index + 1}`,
        label: text(r.label, CONTRACT_LIMITS.signatureLabelMax),
        caption: text(r.caption, CONTRACT_LIMITS.captionMax),
      };
    }
    default:
      return null;
  }
}

function normalizeField(raw: unknown): ContractField | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const key = text(r.key, CONTRACT_LIMITS.fieldKeyMax).trim().toLowerCase();
  if (!FIELD_KEY.test(key)) return null;
  const type = (CONTRACT_FIELD_TYPES as readonly string[]).includes(String(r.type))
    ? (r.type as ContractFieldType)
    : "text";
  const bindingRaw = r.binding as Record<string, unknown> | null | undefined;
  const source = bindingRaw?.source;
  const path = bindingRaw?.path;
  const binding =
    bindingRaw &&
    typeof source === "string" &&
    typeof path === "string" &&
    (CONTRACT_BINDING_SOURCES as readonly string[]).includes(source) &&
    path.length > 0
      ? { source: source as ContractBindingSource, path: path.slice(0, 80) }
      : null;
  return {
    key,
    label: text(r.label, CONTRACT_LIMITS.fieldLabelMax).trim() || key,
    type,
    required: bool(r.required),
    binding,
    options: type === "select" ? stringList(r.options, CONTRACT_LIMITS.optionsMax, CONTRACT_LIMITS.optionMax) : [],
    value: text(r.value, CONTRACT_LIMITS.fieldValueMax),
  };
}

/**
 * The single entry point for anything that arrives from the wire.
 *
 * Unknown block types are dropped, unknown field types degrade to `text`,
 * lengths are capped and duplicate keys are folded onto the first definition.
 * It never throws: a document that cannot be read is an empty document, which
 * the validation below then reports as «سند خالی است» rather than a 500.
 */
export function normalizeContractContent(input: unknown): ContractDocumentContent {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const seenKeys = new Set<string>();
  const seenSlots = new Set<string>();
  const fields: ContractField[] = [];
  for (const candidate of Array.isArray(raw.fields) ? raw.fields : []) {
    const field = normalizeField(candidate);
    if (!field || seenKeys.has(field.key) || fields.length >= CONTRACT_LIMITS.fieldsMax) continue;
    seenKeys.add(field.key);
    fields.push(field);
  }
  const blocks: ContractBlock[] = [];
  for (const candidate of Array.isArray(raw.blocks) ? raw.blocks : []) {
    if (blocks.length >= CONTRACT_LIMITS.blocksMax) break;
    const block = normalizeBlock(candidate, blocks.length);
    if (!block) continue;
    if (block.type === "signature") {
      // A duplicated placement would make "which signature goes here"
      // unanswerable, so the second one is renumbered instead of dropped —
      // dropping a placement silently loses a party's signature line.
      let slot = block.slotId;
      let n = 2;
      while (seenSlots.has(slot)) slot = `${block.slotId}_${n++}`;
      seenSlots.add(slot);
      blocks.push({ ...block, slotId: slot });
      continue;
    }
    blocks.push(block);
  }
  const values: Record<string, string> = {};
  const rawValues = raw.values && typeof raw.values === "object" ? (raw.values as Record<string, unknown>) : null;
  if (rawValues) {
    for (const field of fields) {
      const value = rawValues[field.key];
      if (typeof value === "string") values[field.key] = value.slice(0, CONTRACT_LIMITS.fieldValueMax);
    }
  }
  return {
    version: 1,
    title: text(raw.title, CONTRACT_LIMITS.titleMax),
    headerText: text(raw.headerText, CONTRACT_LIMITS.headerMax),
    footerText: text(raw.footerText, CONTRACT_LIMITS.footerMax),
    blocks,
    fields,
    ...(rawValues ? { values } : {}),
  };
}

/** Every `{{key}}` a text value references, in order, without duplicates. */
export function tokensIn(value: string): string[] {
  const found: string[] = [];
  for (const match of value.matchAll(TOKEN)) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

/** The plain strings a document contains — used for search, tokens and hashing. */
export function blockTexts(block: ContractBlock): string[] {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return [block.text];
    case "article":
      return [block.title, block.text];
    case "bullets":
    case "numbered":
      return block.items;
    case "table":
      return [block.caption, ...block.columns, ...block.rows.flat()];
    case "signature":
      return [block.label, block.caption];
    default:
      return [];
  }
}

/** Every field key the document body actually uses. */
export function referencedTokens(content: ContractDocumentContent): string[] {
  const out: string[] = [];
  for (const block of content.blocks) {
    for (const value of blockTexts(block)) {
      for (const token of tokensIn(value)) if (!out.includes(token)) out.push(token);
    }
  }
  return out;
}

export interface ContractSignatureSlot {
  slotId: string;
  label: string;
  caption: string;
  blockId: string;
}

/** The signature placements a signing envelope must fill, in document order. */
export function signatureSlots(content: ContractDocumentContent): ContractSignatureSlot[] {
  return content.blocks
    .filter((block): block is ContractSignatureBlock => block.type === "signature")
    .map((block) => ({
      slotId: block.slotId,
      label: block.label,
      caption: block.caption,
      blockId: block.id,
    }));
}

/**
 * One validation finding.
 *
 * `code` is stable and machine-readable (the API maps it to a Persian message
 * and a 400/409), `message` is what a sender reads, and `blockId`/`fieldKey`
 * let the editor put the message next to the thing that caused it rather than
 * in a banner at the top — issue #907 F09.
 */
export interface ContractIssue {
  code: string;
  message: string;
  blockId?: string;
  fieldKey?: string;
}

export const CONTRACT_ISSUE_MESSAGES: Record<string, string> = {
  document_empty: "سند هیچ بلوکی ندارد؛ دست‌کم یک بند یا ماده اضافه کنید.",
  document_title_required: "عنوان سند را وارد کنید.",
  signature_slot_missing: "دست‌کم یک جای امضا لازم است تا سند قابل ارسال شود.",
  field_undefined: "متغیری در متن سند هست که تعریف نشده است.",
  field_required: "مقدار این متغیر الزامی است و خالی مانده است.",
  field_select_invalid: "مقدار انتخابی این متغیر در فهرست گزینه‌ها نیست.",
  field_binding_unsupported: "منبع انتخاب‌شده برای این متغیر پشتیبانی نمی‌شود.",
  text_empty: "این بلوک خالی است؛ متن یا حذفش کنید.",
  table_empty: "جدول بدون ستون یا سطر قابل چاپ نیست.",
  field_key_duplicate: "کلید متغیر تکراری است.",
  field_key_invalid: "کلید متغیر باید با حرف لاتین شروع شود و فقط حرف کوچک، رقم و _ داشته باشد.",
};

/**
 * Everything that must be true before a draft may be frozen and sent.
 *
 * `values` is the resolved map for this save — the caller resolves bindings
 * first (see `bindings.ts`), because resolving needs the project/party records
 * and this module must stay database-free. Passing `undefined` means "only
 * check the document's structure", which is what the autosave path uses: an
 * incomplete draft is a normal state and must save, it just cannot be sent.
 */
/** Builds a finding with its Persian message already attached. */
function issue(code: string, extra: { blockId?: string; fieldKey?: string } = {}): ContractIssue {
  return { code, message: CONTRACT_ISSUE_MESSAGES[code] ?? code, ...extra };
}

export function validateContractContent(
  content: ContractDocumentContent,
  values?: Record<string, string>,
): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (!content.title.trim()) issues.push(issue("document_title_required", { fieldKey: "title" }));
  if (content.blocks.length === 0) issues.push(issue("document_empty"));

  const defined = new Set(content.fields.map((field) => field.key));
  for (const token of referencedTokens(content)) {
    if (!defined.has(token)) {
      issues.push(issue("field_undefined", { fieldKey: token }));
    }
  }

  for (const block of content.blocks) {
    const emptyText = block.type === "heading" || block.type === "paragraph" || block.type === "article";
    const hasText = "text" in block ? block.text.trim().length > 0 : true;
    if (emptyText && !hasText && !("title" in block && block.title.trim())) {
      issues.push(issue("text_empty", { blockId: block.id }));
    }
    if (block.type === "bullets" || block.type === "numbered") {
      if (!block.items.some((item) => item.trim())) issues.push(issue("text_empty", { blockId: block.id }));
    }
    if (block.type === "table" && (block.columns.length === 0 || block.rows.length === 0)) {
      issues.push(issue("table_empty", { blockId: block.id }));
    }
  }

  if (values) {
    for (const field of content.fields) {
      const value = values[field.key] ?? "";
      if (field.required && !value.trim()) {
        issues.push(issue("field_required", { fieldKey: field.key }));
        continue;
      }
      if (field.type === "select" && value && field.options.length > 0 && !field.options.includes(value)) {
        issues.push(issue("field_select_invalid", { fieldKey: field.key }));
      }
    }
    if (signatureSlots(content).length === 0) issues.push(issue("signature_slot_missing"));
  }

  return issues;
}

/**
 * Replace `{{key}}` with its resolved value.
 *
 * An unresolved token is left as an empty string rather than printed raw: a
 * signed document that shows «{{party_name}}» is worse than one with a gap, and
 * validation has already refused to freeze the former. The one place the raw
 * token is shown is the editor, where `tokenizeTemplate` hands the renderer the
 * segments so it can mark them.
 */
export function renderTemplate(value: string, values: Readonly<Record<string, string>>): string {
  return value.replace(TOKEN, (_, key: string) => values[key] ?? "");
}

export type TemplateSegment =
  | { kind: "text"; text: string }
  | { kind: "token"; key: string; raw: string; value: string | null };

/**
 * Split a text value into literal runs and variable references.
 *
 * The editor and the signer page both render from this, so a variable can be
 * marked as unresolved while every visible character stays a React text node.
 */
export function tokenizeTemplate(
  value: string,
  values: Readonly<Record<string, string>> = {},
): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let last = 0;
  for (const match of value.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ kind: "text", text: value.slice(last, index) });
    const key = match[1];
    segments.push({ kind: "token", key, raw: match[0], value: values[key] ?? null });
    last = index + match[0].length;
  }
  if (last < value.length) segments.push({ kind: "text", text: value.slice(last) });
  return segments;
}

/**
 * The value a frozen version stores for one field, formatted for display.
 *
 * Money arrives in integer Rial and leaves as the business's display unit;
 * a date arrives as an ISO calendar day and leaves as a Shamsi date. Both
 * conversions are injected (`formatMoney`, `formatDate`) rather than imported,
 * so this module stays usable on the client where the money context lives.
 */
export function formatFieldValue(
  field: ContractField,
  rawValue: string,
  formatters: {
    formatMoney?: (rial: string) => string;
    formatDate?: (iso: string) => string;
  } = {},
): string {
  const value = rawValue.trim();
  if (!value) return "";
  if (field.type === "checkbox") return value === "true" || value === "1" ? "بله" : "خیر";
  if (field.type === "money" && formatters.formatMoney && /^-?\d+$/.test(value)) {
    return formatters.formatMoney(value);
  }
  if (field.type === "date" && formatters.formatDate) {
    const formatted = formatters.formatDate(value);
    if (formatted) return formatted;
  }
  return value;
}

/** A short, human summary of a document for lists and the evidence trail. */
export function documentSummary(content: ContractDocumentContent): string {
  const heading = content.blocks.find((block) => block.type === "heading");
  const firstText =
    (heading && "text" in heading ? heading.text : "") ||
    content.blocks
      .map((block) => blockTexts(block)[0] ?? "")
      .find((value) => value.trim().length > 0) ||
    content.title;
  return firstText.replace(TOKEN, "").trim().slice(0, 120);
}
