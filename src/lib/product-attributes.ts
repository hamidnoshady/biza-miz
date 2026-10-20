/**
 * Shared product-attribute rules for the attribute master, draft editor and
 * product-create API. This module is intentionally DB/framework-free so the
 * browser and server use the same Persian-aware normalization policy.
 */
export const ATTRIBUTE_NAME_MAX_LENGTH = 100;
export const ATTRIBUTE_OPTION_MAX_LENGTH = 200;
export const ATTRIBUTE_OPTIONS_MAX_COUNT = 50;
export const ATTRIBUTE_REQUEST_MAX_BYTES = 16 * 1024;
// Enough for the parser's bounded 100 × 20 variant-attribute envelope while
// still preventing unbounded JSON allocation at the shared product endpoint.
export const PRODUCT_CREATE_REQUEST_MAX_BYTES = 4 * 1024 * 1024;

export interface AttributeValidationIssue {
  code: string;
  field: string;
  message: string;
}

export interface AttributeDefinitionInput {
  name?: string;
  options?: string[];
  isActive?: boolean;
  version?: number;
}

export type AttributeDefinitionParseResult =
  | { ok: true; data: AttributeDefinitionInput; issues: [] }
  | { ok: false; data: null; issues: AttributeValidationIssue[] };

export type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; error: "bad_request" | "payload_too_large" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

/**
 * Canonical display form used for newly-authored definitions and controlled
 * option values. It preserves historical variant snapshots, which are never
 * passed through this helper after they have been stored.
 */
export function normalizeAttributeText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[\u0640]/g, "") // Arabic tatweel
    .replace(/[\u0643]/g, "ک") // Arabic kaf -> Persian kaf
    .replace(/[\u064A\u0649]/g, "ی") // Arabic yeh/alef maksura -> Persian yeh
    .replace(/[\u200B\u2060\uFEFF]/g, "")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/[\t\n\r\f\v ]+/g, " ")
    .trim();
}

/** A comparison key for duplicates, independent of Arabic/Persian glyph forms. */
export function attributeComparisonKey(value: string): string {
  return normalizeAttributeText(value)
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/\u200C/g, " ") // treat ZWNJ and a word boundary consistently
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("fa-IR");
}

/** Read JSON with a hard byte bound, including requests without Content-Length. */
export async function readBoundedJson(
  request: Request,
  maxBytes = ATTRIBUTE_REQUEST_MAX_BYTES,
): Promise<BoundedJsonResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return { ok: false, error: "bad_request" };
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    return { ok: false, error: "payload_too_large" };
  }
  if (!request.body) return { ok: false, error: "bad_request" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, error: "payload_too_large" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "bad_request" };
  } finally {
    reader.releaseLock();
  }
}

/** Strict create/patch schema for untrusted JSON from /api/products/attributes. */
export function parseAttributeDefinitionInput(
  raw: unknown,
  mode: "create" | "patch",
): AttributeDefinitionParseResult {
  const issues: AttributeValidationIssue[] = [];
  if (!isRecord(raw)) {
    return {
      ok: false,
      data: null,
      issues: [{ code: "invalid_object", field: "form", message: "ساختار درخواست معتبر نیست." }],
    };
  }

  const allowed = new Set(mode === "create" ? ["name", "options", "isActive"] : ["name", "options", "isActive", "version"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      issues.push({ code: "unknown_field", field: key, message: "یکی از فیلدهای درخواست پشتیبانی نمی‌شود." });
    }
  }

  const data: AttributeDefinitionInput = {};
  if (mode === "create" || Object.hasOwn(raw, "name")) {
    if (typeof raw.name !== "string") {
      issues.push({ code: "invalid_name", field: "name", message: "عنوان ویژگی باید متن باشد." });
    } else {
      const name = normalizeAttributeText(raw.name);
      if (!name) issues.push({ code: "name_required", field: "name", message: "عنوان ویژگی الزامی است." });
      else if (characterCount(name) > ATTRIBUTE_NAME_MAX_LENGTH) {
        issues.push({ code: "name_too_long", field: "name", message: `عنوان ویژگی حداکثر ${ATTRIBUTE_NAME_MAX_LENGTH} نویسه است.` });
      } else data.name = name;
    }
  }

  if (Object.hasOwn(raw, "options")) {
    if (!Array.isArray(raw.options)) {
      issues.push({ code: "invalid_options", field: "options", message: "مقادیر ویژگی باید فهرستی از متن باشند." });
    } else if (raw.options.length > ATTRIBUTE_OPTIONS_MAX_COUNT) {
      issues.push({
        code: "too_many_options",
        field: "options",
        message: `هر ویژگی حداکثر ${ATTRIBUTE_OPTIONS_MAX_COUNT} مقدار می‌پذیرد.`,
      });
    } else {
      const normalized: string[] = [];
      const keys = new Set<string>();
      raw.options.forEach((option, index) => {
        const field = `options.${index}`;
        if (typeof option !== "string") {
          issues.push({ code: "invalid_option", field, message: "مقدار ویژگی باید متن باشد." });
          return;
        }
        const value = normalizeAttributeText(option);
        if (!value) {
          issues.push({ code: "empty_option", field, message: "مقدار ویژگی نباید خالی باشد." });
          return;
        }
        if (characterCount(value) > ATTRIBUTE_OPTION_MAX_LENGTH) {
          issues.push({ code: "option_too_long", field, message: `هر مقدار حداکثر ${ATTRIBUTE_OPTION_MAX_LENGTH} نویسه است.` });
          return;
        }
        const key = attributeComparisonKey(value);
        if (keys.has(key)) {
          issues.push({ code: "duplicate_option", field, message: `مقدار «${value}» تکراری است.` });
          return;
        }
        keys.add(key);
        normalized.push(value);
      });
      data.options = normalized;
    }
  }

  if (Object.hasOwn(raw, "isActive")) {
    if (typeof raw.isActive !== "boolean") {
      issues.push({ code: "invalid_status", field: "isActive", message: "وضعیت ویژگی باید فعال یا غیرفعال باشد." });
    } else data.isActive = raw.isActive;
  } else if (mode === "create") {
    data.isActive = true;
  }

  if (mode === "patch") {
    if (!Object.hasOwn(raw, "version") || !Number.isSafeInteger(raw.version) || Number(raw.version) < 1) {
      issues.push({ code: "version_required", field: "version", message: "نسخهٔ ویژگی برای ذخیرهٔ ایمن الزامی است." });
    } else {
      data.version = raw.version as number;
    }
    if (!Object.hasOwn(raw, "name") && !Object.hasOwn(raw, "options") && !Object.hasOwn(raw, "isActive")) {
      issues.push({ code: "empty_patch", field: "form", message: "حداقل یک تغییر لازم است." });
    }
  }

  return issues.length > 0 ? { ok: false, data: null, issues } : { ok: true, data, issues: [] };
}

/** A strict UUID shape check shared with product-input without importing DB code. */
export function isAttributeDefinitionId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
