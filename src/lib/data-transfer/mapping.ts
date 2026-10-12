/**
 * Column mapping and the validation engine.
 *
 * Pure: no database, no framework. Given an entity definition, a parsed sheet
 * and a mapping, this file answers "what would each row become, and what is
 * wrong with it" — which is exactly what the preview screen shows and what the
 * worker later performs.
 *
 * Two properties are deliberate:
 *
 *  1. **Suggestion is never silent.** `suggestMapping` proposes; the operator
 *     confirms. A wrong auto-mapping that nobody was shown is how three
 *     thousand phone numbers end up in the name column.
 *  2. **Coercion is total.** Every cell either produces a value or produces a
 *     message. There is no third outcome where a malformed number quietly
 *     becomes `NaN` and reaches the database.
 */

import { normaliseHeader, westernDigits } from "./codecs";
import { isValidIsoDate, jalaliToIsoDate } from "../jalali";
import { isWholeRial } from "../money";
import type {
  ColumnMapping,
  EntityDefinition,
  EntityField,
  ImportMapping,
  ImportOptions,
  ParsedSheet,
  RowMessage,
  TransformRule,
  ValidatedRow,
} from "./types";

/** Every header spelling that should match a field. */
export function fieldAliases(field: EntityField): string[] {
  const out = [field.key, field.label, ...(field.aliases ?? [])];
  // `unit_price` should also answer to `unit price`; normaliseHeader folds the
  // separators, so this only needs the raw spellings.
  return out.filter((value, index) => out.indexOf(value) === index);
}

/**
 * Propose a mapping for a freshly uploaded sheet.
 *
 * Three passes, strongest first, and a column is claimed at most once:
 *
 *  1. exact match of a normalised alias,
 *  2. a column that *contains* an alias (or vice versa) when that alias is
 *     long enough for the containment to mean something — «شمارهٔ تماس مشتری»
 *     should find `phone`, but a two-letter alias must not match everything,
 *  3. nothing: the field is left unmapped rather than guessed at.
 */
export function suggestMapping(entity: EntityDefinition, sheet: ParsedSheet): ImportMapping {
  const importable = entity.fields.filter((field) => !field.readOnly);
  const normalisedColumns = sheet.columns.map(normaliseHeader);
  const claimed = new Set<number>();
  const columns: ColumnMapping[] = [];

  const claim = (field: EntityField, index: number) => {
    claimed.add(index);
    columns.push({ field: field.key, column: index, transform: "none" });
  };

  const pending: EntityField[] = [];
  for (const field of importable) {
    const aliases = fieldAliases(field).map(normaliseHeader);
    const index = normalisedColumns.findIndex(
      (column, i) => !claimed.has(i) && column.length > 0 && aliases.includes(column),
    );
    if (index >= 0) claim(field, index);
    else pending.push(field);
  }

  // Pass two is scored, not first-come. Registry order would otherwise decide
  // a contest it knows nothing about: «شماره تماس مشتری» contains both
  // «مشتری» (an alias of `name`) and «شماره تماس» (an alias of `phone`), and
  // `name` is declared first — so an ordered scan hands the phone column to
  // the name field. The longer the matched alias, the more of the header it
  // explains, so the longest match wins.
  const candidates: { field: EntityField; index: number; score: number }[] = [];
  for (const field of pending) {
    const aliases = fieldAliases(field)
      .map(normaliseHeader)
      .filter((alias) => alias.length >= 3);
    if (aliases.length === 0) continue;
    normalisedColumns.forEach((column, index) => {
      if (claimed.has(index) || column.length < 3) return;
      let best = 0;
      for (const alias of aliases) {
        if (column.includes(alias) || alias.includes(column)) {
          best = Math.max(best, Math.min(alias.length, column.length));
        }
      }
      if (best > 0) candidates.push({ field, index, score: best });
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  const taken = new Set<string>();
  for (const candidate of candidates) {
    if (claimed.has(candidate.index) || taken.has(candidate.field.key)) continue;
    taken.add(candidate.field.key);
    claim(candidate.field, candidate.index);
  }

  return { columns };
}

/** Source columns no mapping claimed. */
export function unmappedColumns(sheet: ParsedSheet, mapping: ImportMapping): string[] {
  const claimed = new Set(mapping.columns.map((column) => column.column));
  return sheet.columns.filter((_, index) => !claimed.has(index));
}

/** Required fields the mapping does not fill. The import cannot proceed. */
export function missingRequiredFields(
  entity: EntityDefinition,
  mapping: ImportMapping,
): string[] {
  const filled = new Set(
    mapping.columns
      .filter((column) => column.column >= 0 || (column.constant ?? "").trim() !== "")
      .map((column) => column.field),
  );
  return entity.fields
    .filter((field) => field.required && !field.readOnly && !filled.has(field.key))
    .map((field) => field.label);
}

/** Apply a mapping's transformation to one cell's text. */
export function applyTransform(value: string, rule: TransformRule | undefined): string {
  switch (rule) {
    case "trim":
      return value.trim();
    case "upper":
      return value.toUpperCase();
    case "lower":
      return value.toLowerCase();
    case "digits":
      return westernDigits(value);
    case "persian_digits":
      return toPersianDigitString(westernDigits(value));
    case "strip_spaces":
      return value.replace(/[\s\u200C]+/g, "");
    case "toman_to_rial": {
      const n = parseNumeric(value);
      return n === null ? value : String(Math.round(n * 10));
    }
    case "rial_to_toman": {
      const n = parseNumeric(value);
      return n === null ? value : String(Math.round(n / 10));
    }
    case "percent_to_fraction": {
      const n = parseNumeric(value.replace(/[%٪]/g, ""));
      return n === null ? value : String(n / 100);
    }
    case "boolean_yes_no":
      return parseBooleanText(value) ? "true" : "false";
    case "none":
    case undefined:
    default:
      return value;
  }
}

function toPersianDigitString(value: string): string {
  return value.replace(/[0-9]/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]);
}

/**
 * A number from human text: Persian digits, thousands separators (`,` `٬` `.`
 * as a group mark in some locales), a trailing currency word, a leading minus.
 *
 * Returns null rather than NaN, so the caller has to decide what a
 * non-number means instead of writing one to the database.
 */
export function parseNumeric(input: string): number | null {
  const text = westernDigits(String(input ?? ""))
    .replace(/[\u066B]/g, ".")
    .replace(/[,\u066C\u2009\s]/g, "")
    .replace(/[^\d.+-]/g, "")
    .trim();
  if (text === "" || text === "-" || text === "+" || text === ".") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

const TRUE_WORDS = new Set(["true", "1", "yes", "y", "بله", "آری", "دارد", "فعال", "درست", "بلی"]);
const FALSE_WORDS = new Set(["false", "0", "no", "n", "خیر", "ندارد", "غیرفعال", "نادرست", "نه"]);

export function parseBooleanText(input: string): boolean | null {
  const text = normaliseHeader(String(input ?? ""));
  if (text === "") return null;
  if (TRUE_WORDS.has(text)) return true;
  if (FALSE_WORDS.has(text)) return false;
  return null;
}

/**
 * A date from human text, as ISO `YYYY-MM-DD`.
 *
 * Shamsi first, because that is what an Iranian business's spreadsheet holds:
 * «۱۴۰۳/۰۵/۱۲» and `1403-05-12` are both read as Jalali and converted.
 * A four-digit year ≥ 1700 is treated as Gregorian, which is the only
 * unambiguous discriminator (no Jalali year reaches 1700 for another three
 * centuries, and no Gregorian date a business types is before 1700).
 */
export function parseDateText(input: string): string | null {
  const text = westernDigits(String(input ?? "")).trim().replace(/[.\\]/g, "/");
  if (!text) return null;

  const ymd = /^(\d{3,4})[/-](\d{1,2})[/-](\d{1,2})/.exec(text);
  if (ymd) {
    const year = Number(ymd[1]);
    const month = Number(ymd[2]);
    const day = Number(ymd[3]);
    if (year >= 1700) {
      const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      return isValidIsoDate(iso) ? iso : null;
    }
    try {
      return jalaliToIsoDate(year, month, day);
    } catch {
      return null;
    }
  }

  // An ISO timestamp, or anything else Date can read. Deliberately last: it
  // would happily read «1403/05/12» as a Gregorian date in the year 1403.
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

/** The cell text a mapping produces for one field of one row. */
export function cellFor(
  row: readonly string[],
  column: ColumnMapping,
): string {
  const raw = column.column >= 0 ? (row[column.column] ?? "") : (column.constant ?? "");
  return applyTransform(raw, column.transform);
}

/**
 * Coerce one cell into the field's type, or explain why it cannot be.
 *
 * `null` value + no message means "empty, and that is allowed"; the required
 * check is applied by the caller so that it reads the same for a missing
 * column and an empty cell.
 */
export function coerceValue(
  field: EntityField,
  text: string,
  options: ImportOptions,
): { value: unknown; message: RowMessage | null } {
  const trimmed = text.trim();
  if (trimmed === "") return { value: null, message: null };

  const error = (message: string): { value: unknown; message: RowMessage } => ({
    value: null,
    message: { field: field.key, severity: "error", message },
  });

  switch (field.type) {
    case "text":
    case "longtext":
      return { value: trimmed, message: null };

    case "email": {
      const value = westernDigits(trimmed).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return error(`«${field.label}» یک ایمیل معتبر نیست.`);
      }
      return { value, message: null };
    }

    case "phone": {
      const value = westernDigits(trimmed).replace(/[\s()-]/g, "");
      if (!/^\+?\d{6,15}$/.test(value)) {
        return error(`«${field.label}» یک شمارهٔ تماس معتبر نیست.`);
      }
      return { value, message: null };
    }

    case "integer": {
      const value = parseNumeric(trimmed);
      if (value === null) return error(`«${field.label}» باید عدد باشد.`);
      if (!Number.isInteger(value)) return error(`«${field.label}» باید عدد صحیح باشد.`);
      return { value, message: null };
    }

    case "number": {
      const value = parseNumeric(trimmed);
      if (value === null) return error(`«${field.label}» باید عدد باشد.`);
      return { value, message: null };
    }

    case "money": {
      const value = parseNumeric(trimmed);
      if (value === null) return error(`«${field.label}» باید مبلغ باشد.`);
      if (value < 0) return error(`«${field.label}» نمی‌تواند منفی باشد.`);
      // Storage is always integer Rial. A file denominated in Toman is
      // multiplied here, once, rather than at each call site — the 10× price
      // error is the single most expensive import bug there is.
      const rial = options.moneyUnit === "rial" ? value : value * 10;
      // `isWholeRial` absorbs the float artefact of ×10 (۱۵/۷ تومان is
      // 1507.0000000000002, which is a whole Rial); a field that stores exact
      // Rial asks for more than that and gets an error naming its column, never
      // a rounded figure the operator never wrote.
      if (field.validation?.integral && !isWholeRial(rial)) {
        return error(`«${field.label}» باید عدد صحیح ریال باشد؛ مبلغ کسری در دفتر پذیرفته نمی‌شود.`);
      }
      return { value: Math.round(rial), message: null };
    }

    case "boolean": {
      const value = parseBooleanText(trimmed);
      if (value === null) return error(`«${field.label}» باید بله یا خیر باشد.`);
      return { value, message: null };
    }

    case "date":
    case "datetime": {
      const value = parseDateText(trimmed);
      if (value === null) return error(`«${field.label}» یک تاریخ معتبر نیست.`);
      return { value, message: null };
    }

    case "enum": {
      const options_ = field.options ?? [];
      const needle = normaliseHeader(trimmed);
      const hit = options_.find(
        (option) =>
          normaliseHeader(option.value) === needle || normaliseHeader(option.label) === needle,
      );
      if (!hit) {
        const allowed = options_.map((option) => option.label).join("، ");
        return error(`«${field.label}» باید یکی از این مقادیر باشد: ${allowed}`);
      }
      return { value: hit.value, message: null };
    }

    case "tags": {
      const parts = trimmed
        .split(/[,،;|]/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      return { value: parts, message: null };
    }

    case "reference":
      // The text is kept as-is; resolving it to an id needs the database and
      // happens in the service, which is also where the create/skip/warn
      // strategy is applied.
      return { value: trimmed, message: null };

    default:
      return { value: trimmed, message: null };
  }
}

/** The field's own `validation` block, applied to an already-coerced value. */
export function validateValue(field: EntityField, value: unknown): RowMessage[] {
  const rules = field.validation;
  if (!rules || value === null || value === undefined) return [];
  const messages: RowMessage[] = [];
  const error = (message: string) =>
    messages.push({ field: field.key, severity: "error", message });

  if (typeof value === "number") {
    if (rules.min !== undefined && value < rules.min) {
      error(`«${field.label}» نباید کمتر از ${rules.min} باشد.`);
    }
    if (rules.max !== undefined && value > rules.max) {
      error(`«${field.label}» نباید بیشتر از ${rules.max} باشد.`);
    }
  }

  if (typeof value === "string") {
    if (rules.minLength !== undefined && value.length < rules.minLength) {
      error(`«${field.label}» باید حداقل ${rules.minLength} نویسه باشد.`);
    }
    if (rules.maxLength !== undefined && value.length > rules.maxLength) {
      error(`«${field.label}» نباید بیشتر از ${rules.maxLength} نویسه باشد.`);
    }
    if (rules.pattern) {
      let ok = true;
      try {
        ok = new RegExp(rules.pattern).test(value);
      } catch {
        // A malformed pattern in a definition is a bug in the definition, not
        // in the operator's file: never fail their row for it.
        ok = true;
      }
      if (!ok) error(rules.patternMessage ?? `«${field.label}» قالب درستی ندارد.`);
    }
  }

  return messages;
}

/**
 * Map, coerce and validate every row of a sheet.
 *
 * In-file duplicates are detected here too, against the entity's duplicate
 * rules: a spreadsheet listing the same person twice would otherwise create
 * them twice, and the second one is invisible until somebody notices the
 * directory has grown oddly. The second occurrence is an ERROR rather than a
 * warning, because there is no defensible way to merge two rows of one file.
 */
export function validateSheet(
  entity: EntityDefinition,
  sheet: ParsedSheet,
  mapping: ImportMapping,
  options: ImportOptions = {},
): ValidatedRow[] {
  const byKey = new Map(entity.fields.map((field) => [field.key, field]));
  const active = mapping.columns.filter((column) => {
    const field = byKey.get(column.field);
    if (!field || field.readOnly) return false;
    return column.column >= 0 || (column.constant ?? "").trim() !== "";
  });

  const rule =
    entity.duplicateRules?.find((candidate) => candidate.key === options.duplicateRule) ??
    entity.duplicateRules?.[0] ??
    null;
  const seen = new Map<string, number>();

  return sheet.rows.map((cells, index) => {
    // +2: 1-based, plus the header, so the number matches the spreadsheet's
    // own row numbering and the operator can scroll straight to it.
    const rowNumber = index + 2;
    const raw: Record<string, string> = {};
    sheet.columns.forEach((column, columnIndex) => {
      raw[column || `ستون ${columnIndex + 1}`] = cells[columnIndex] ?? "";
    });

    const values: Record<string, unknown> = {};
    const messages: RowMessage[] = [];

    for (const column of active) {
      const field = byKey.get(column.field)!;
      const text = cellFor(cells, column);
      const { value, message } = coerceValue(field, text, options);
      if (message) {
        messages.push(message);
        continue;
      }
      if (value !== null) {
        values[field.key] = value;
        messages.push(...validateValue(field, value));
      }
    }

    for (const field of entity.fields) {
      if (!field.required || field.readOnly) continue;
      const value = values[field.key];
      const empty =
        value === null ||
        value === undefined ||
        value === "" ||
        (Array.isArray(value) && value.length === 0);
      if (empty && !messages.some((m) => m.field === field.key)) {
        messages.push({
          field: field.key,
          severity: "error",
          message: `«${field.label}» الزامی است و خالی مانده.`,
        });
      }
    }

    if (rule) {
      const parts = rule.fields.map((key) => normaliseHeader(String(values[key] ?? "")));
      if (parts.every((part) => part !== "")) {
        const signature = `${rule.key}\u0000${parts.join("\u0000")}`;
        const previous = seen.get(signature);
        if (previous !== undefined) {
          messages.push({
            field: rule.fields[0] ?? null,
            severity: "error",
            message: `همین ${rule.label} در سطر ${previous} همین فایل هم آمده است.`,
          });
        } else {
          seen.set(signature, rowNumber);
        }
      }
    }

    return {
      rowNumber,
      raw,
      values,
      messages,
      valid: !messages.some((message) => message.severity === "error"),
    };
  });
}

/** Header/body split, with short rows padded to the header's width. */
export function sheetFromRows(rows: string[][]): ParsedSheet {
  if (rows.length === 0) return { columns: [], rows: [] };
  const columns = (rows[0] ?? []).map((column) => column.trim());
  const width = columns.length;
  const body = rows.slice(1).map((row) => {
    const padded = row.slice(0, width);
    while (padded.length < width) padded.push("");
    return padded;
  });
  return { columns, rows: body };
}
