import { describe, expect, it } from "vitest";
import { buildVariantDraftSeeds, parseAxisValues } from "./variant-matrix-draft";

const SIZE = "11111111-1111-4111-8111-111111111111";
const COLOR = "22222222-2222-4222-8222-222222222222";

describe("buildVariantDraftSeeds — size × colour grid for the product form (#1567)", () => {
  it("expands two axes into every combination, keyed by definition ID", () => {
    const result = buildVariantDraftSeeds({
      axisA: { definitionId: SIZE, values: ["M", "L"] },
      axisB: { definitionId: COLOR, values: ["مشکی", "سرمه‌ای"] },
      existing: [],
      maxTotal: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seeds).toHaveLength(4);
    expect(result.seeds.map((seed) => seed.values)).toEqual([
      { [SIZE]: "M", [COLOR]: "مشکی" },
      { [SIZE]: "M", [COLOR]: "سرمه‌ای" },
      { [SIZE]: "L", [COLOR]: "مشکی" },
      { [SIZE]: "L", [COLOR]: "سرمه‌ای" },
    ]);
    expect(result.duplicates).toBe(0);
    expect(result.truncated).toBe(0);
  });

  it("builds a one-axis product when the second axis is absent", () => {
    const result = buildVariantDraftSeeds({
      axisA: { definitionId: SIZE, values: ["36", "37"] },
      existing: [],
      maxTotal: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seeds).toEqual([{ values: { [SIZE]: "36" } }, { values: { [SIZE]: "37" } }]);
  });

  it("never regenerates a combination the form already holds", () => {
    const result = buildVariantDraftSeeds({
      axisA: { definitionId: SIZE, values: ["M", "L"] },
      axisB: { definitionId: COLOR, values: ["مشکی"] },
      existing: [{ values: { [SIZE]: "M", [COLOR]: "مشکی" } }],
      maxTotal: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seeds).toEqual([{ values: { [SIZE]: "L", [COLOR]: "مشکی" } }]);
    expect(result.duplicates).toBe(1);
  });

  it("treats equivalent spellings as the same cell (normalised comparison)", () => {
    const result = buildVariantDraftSeeds({
      axisA: { definitionId: SIZE, values: [" M ", "m"] },
      existing: [],
      maxTotal: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Trimmed and case-folded duplicate collapse to one row.
    expect(result.seeds).toHaveLength(1);
  });

  it("stops at the form ceiling instead of overrunning it", () => {
    const result = buildVariantDraftSeeds({
      axisA: { definitionId: SIZE, values: ["S", "M", "L"] },
      existing: [{ values: { [SIZE]: "S" } }, { values: { [SIZE]: "M" } }],
      maxTotal: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seeds).toEqual([{ values: { [SIZE]: "L" } }]);
    expect(result.truncated).toBe(0);
    // Ceiling counts existing rows: nothing more fits past maxTotal.
    const blocked = buildVariantDraftSeeds({
      axisA: { definitionId: SIZE, values: ["XL"] },
      existing: [{ values: { [SIZE]: "S" } }, { values: { [SIZE]: "M" } }, { values: { [SIZE]: "L" } }],
      maxTotal: 3,
    });
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    expect(blocked.seeds).toHaveLength(0);
    expect(blocked.truncated).toBe(1);
  });

  it("refuses a second axis that repeats the first, or a half-filled one", () => {
    const sameAxis = buildVariantDraftSeeds({
      axisA: { definitionId: SIZE, values: ["M"] },
      axisB: { definitionId: SIZE, values: ["L"] },
      existing: [],
      maxTotal: 100,
    });
    expect(sameAxis).toEqual({ ok: false, error: "نام دو محور تنوع نمی‌تواند یکسان باشد." });

    const halfFilled = buildVariantDraftSeeds({
      axisA: { definitionId: SIZE, values: ["M"] },
      axisB: { definitionId: COLOR, values: [] },
      existing: [],
      maxTotal: 100,
    });
    expect(halfFilled).toEqual({
      ok: false,
      error: "محور دوم باید حداقل یک مقدار داشته باشد، یا کاملاً خالی گذاشته شود.",
    });
  });

  it("refuses an axis with no definition or no values", () => {
    expect(
      buildVariantDraftSeeds({ axisA: { definitionId: " ", values: ["M"] }, existing: [], maxTotal: 100 }),
    ).toEqual({ ok: false, error: "محور اول باید یک ویژگی فعال انتخاب کند." });
    expect(
      buildVariantDraftSeeds({ axisA: { definitionId: SIZE, values: ["", " "] }, existing: [], maxTotal: 100 }),
    ).toEqual({ ok: false, error: "محور اول (مثلاً سایز یا رنگ) باید حداقل یک مقدار داشته باشد." });
  });
});

describe("parseAxisValues", () => {
  it("splits on newlines and Persian/Latin commas and drops empties", () => {
    expect(parseAxisValues("M\nL، XL ,\n\n")).toEqual(["M", "L", "XL"]);
  });
});
