/**
 * The size × colour grid for the product form (#1567 P0 2.5) — pure half.
 *
 * `variant-matrix.ts` builds a *server-side* family by attribute name; this
 * module builds the drafts the «افزودن محصول» form holds in state, keyed by
 * attribute-definition ID the way every other draft row is. One cell per
 * combination of the two axes, existing rows never duplicated, and the form's
 * hard 100-variant ceiling enforced before anything is appended.
 */
import { attributeComparisonKey, normalizeAttributeText } from "./product-attributes";

export interface MatrixDraftAxis {
  /** Attribute definition the axis reads its values from. */
  definitionId: string;
  /** Raw axis values as typed (one per line in the form); cleaned here. */
  values: string[];
}

export interface MatrixDraftSeed {
  values: Record<string, string>;
}

export type MatrixDraftBuildResult =
  | {
      ok: true;
      seeds: MatrixDraftSeed[];
      /** Cells already present in the form, left untouched. */
      duplicates: number;
      /** Cells that would push the form past `maxTotal`; not generated. */
      truncated: number;
    }
  | { ok: false; error: string };

/** Trimmed, de-duplicated axis values in input order — empties dropped. */
function cleanValues(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const entry of raw) {
    const value = normalizeAttributeText(entry);
    if (!value) continue;
    const key = attributeComparisonKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  return values;
}

/** Comparison key for a whole attribute-value set, order-independent. */
function valuesKey(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([definitionId, value]) => `${definitionId}:${attributeComparisonKey(value)}`)
    .sort()
    .join("|");
}

/**
 * Expands two axes into cell seeds. The second axis is optional (a one-axis
 * product simply passes nothing). Errors are the same Persian messages the
 * server-side builder gives, so the form can show them without a round trip.
 */
export function buildVariantDraftSeeds(input: {
  axisA: MatrixDraftAxis;
  axisB?: MatrixDraftAxis;
  existing: readonly MatrixDraftSeed[];
  /** The form's hard ceiling on total variant rows. */
  maxTotal: number;
}): MatrixDraftBuildResult {
  const a = { definitionId: input.axisA.definitionId.trim(), values: cleanValues(input.axisA.values) };
  const b = input.axisB
    ? { definitionId: input.axisB.definitionId.trim(), values: cleanValues(input.axisB.values) }
    : null;

  if (!a.definitionId) return { ok: false, error: "محور اول باید یک ویژگی فعال انتخاب کند." };
  if (a.values.length === 0) {
    return { ok: false, error: "محور اول (مثلاً سایز یا رنگ) باید حداقل یک مقدار داشته باشد." };
  }
  if (b && b.definitionId === a.definitionId) {
    return { ok: false, error: "نام دو محور تنوع نمی‌تواند یکسان باشد." };
  }
  // A partially filled second axis is almost always an accidental submission;
  // silently dropping it would make the created rows differ from the preview.
  if (b && b.definitionId && b.values.length === 0) {
    return { ok: false, error: "محور دوم باید حداقل یک مقدار داشته باشد، یا کاملاً خالی گذاشته شود." };
  }

  const existingKeys = new Set(input.existing.map((seed) => valuesKey(seed.values)));
  const total = a.values.length * Math.max(1, b?.values.length ?? 0);
  if (total > 1000) {
    return { ok: false, error: "ماتریس نمی‌تواند بیش از ۱۰۰۰ تنوع بسازد." };
  }

  const seeds: MatrixDraftSeed[] = [];
  let duplicates = 0;
  let truncated = 0;
  for (const aValue of a.values) {
    const rowValues = b?.definitionId && b.values.length > 0 ? b.values : [null];
    for (const bValue of rowValues) {
      const values: Record<string, string> = { [a.definitionId]: aValue };
      if (b?.definitionId && bValue !== null) values[b.definitionId] = bValue;
      const key = valuesKey(values);
      if (existingKeys.has(key) || seeds.some((seed) => valuesKey(seed.values) === key)) {
        duplicates += 1;
        continue;
      }
      if (input.existing.length + seeds.length >= input.maxTotal) {
        truncated += 1;
        continue;
      }
      existingKeys.add(key);
      seeds.push({ values });
    }
  }
  return { ok: true, seeds, duplicates, truncated };
}

/** Splits the textarea shape (one value per line, comma also accepted). */
export function parseAxisValues(text: string): string[] {
  return text
    .split(/\r?\n|،|,/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
