/**
 * Issue #902 §5 — safe variable rendering for approved lookup messages.
 *
 * The provider substitutes `%token` slots with whatever the caller passes, so a
 * template is only as safe as its values. §5 is explicit: "business-supplied
 * name/amount/order info maps to approved variables, not arbitrary backend
 * syntax". That is what this module is — the boundary between a caller's domain
 * data (`{ customer_name: "سارا", amount: 250000 }`) and the three strings that
 * leave the building:
 *
 *   * a template may only use the slots we support (`%token`, `%token2`,
 *     `%token3`), and only as a prefix — a body with `%token2` and no `%token`
 *     is a mistake the provider would reject long after the operator noticed;
 *   * a template declares its variables **in order**, so position is the
 *     mapping: `variables[0]` → `%token`, `variables[1]` → `%token2`. No
 *     template ever interpolates a caller's string into the body itself;
 *   * every variable has one renderer, and a value that fails its renderer is
 *     an error rather than something to truncate quietly into the customer's
 *     inbox. Names lose control characters and `%`, amounts become Persian
 *     grouped digits, dates become Jalali, and a code stays ASCII digits so the
 *     person reading the SMS can type it back;
 *   * the rendered value is capped at `MAX_TOKEN_LENGTH`, because a token lands
 *     inside one segment and an overlong value is a provider rejection the
 *     operator discovers at approval time.
 *
 * Pure functions on purpose: this is the part that must be provable without a
 * database, a provider or a clock.
 */
import { formatPersianNumber, normalizeSecurityDigits, toPersianDigits } from "../digits";
import { toJalali } from "../jalali";

/** A token value is substituted into one segment; keep it short and legible. */
export const MAX_TOKEN_LENGTH = 25;

/** The slots the library may use, in the order they may appear. */
export const TOKEN_SLOTS = ["token", "token2", "token3"] as const;
export type TokenSlot = (typeof TOKEN_SLOTS)[number];

export type TemplateVariable =
  | "code"
  | "customer_name"
  | "store_name"
  | "order_number"
  | "amount"
  | "date";

export type RenderErrorCode =
  | "body_missing_token"
  | "token_slot_unsupported"
  | "token_slot_gap"
  | "variables_mismatch"
  | "variable_not_allowed"
  | "variable_missing"
  | "variable_invalid";

export interface RenderSuccess {
  ok: true;
  /** Positional token values: `tokens[0]` → `%token`, `tokens[1]` → `%token2`. */
  tokens: string[];
  /** What the customer will read, for the console and the tenant's sample. */
  preview: string;
}

export interface RenderFailure {
  ok: false;
  code: RenderErrorCode;
  /** Present when the failure is about one named variable. */
  variable?: string;
}

export type RenderResult = RenderSuccess | RenderFailure;

/** What a caller passes. Values are domain data, not display strings. */
export type TemplateValues = Partial<Record<TemplateVariable, string | number | Date | null | undefined>>;

type Rendered = { ok: true; value: string } | { ok: false };

const fail: Rendered = { ok: false };

/** Collapse whitespace, drop control characters and `%`, then cap the length. */
function plainText(value: unknown, maxLength = MAX_TOKEN_LENGTH): Rendered {
  if (typeof value !== "string" && typeof value !== "number") return fail;
  const cleaned = String(value)
    // Control characters would break the segment; `%` would look like a token
    // to the provider's own substitution pass.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/%/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fail;
  return { ok: true, value: cleaned.slice(0, maxLength).trim() };
}

function integerString(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  // Persian/Arabic digits are what a Persian keyboard produces; the renderer is
  // the last place that may be lenient about them.
  const digits = normalizeSecurityDigits(value);
  return digits ? digits : null;
}

/**
 * One renderer per variable. Every one of them returns either a value that is
 * safe to substitute or a failure — never a guess.
 */
export const TEMPLATE_VARIABLE_RENDERERS: Record<
  TemplateVariable,
  (value: unknown) => Rendered
> = {
  code: (value) => {
    // Kept as ASCII digits: an OTP is typed back by a human, often on a keypad
    // that does not have Persian numerals.
    const digits = typeof value === "number" ? String(value) : typeof value === "string" ? normalizeSecurityDigits(value) : "";
    if (!/^\d{4,8}$/.test(digits)) return fail;
    return { ok: true, value: digits };
  },
  customer_name: (value) => plainText(value),
  store_name: (value) => plainText(value),
  order_number: (value) => {
    const text = plainText(value, 20);
    if (!text.ok) return fail;
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(text.value)) return fail;
    return text;
  },
  amount: (value) => {
    // Rial, the platform's storage unit. The message says «ریال» so the number
    // is never ambiguous; grouping is Persian so nobody miscounts zeros.
    const raw = integerString(value);
    if (!raw || raw.length > 15) return fail;
    return { ok: true, value: formatPersianNumber(BigInt(raw)) };
  },
  date: (value) => {
    const date =
      value instanceof Date
        ? value
        : typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)
          ? new Date(value)
          : null;
    if (!date || Number.isNaN(date.getTime())) return fail;
    const { jy, jm, jd } = toJalali(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    const pad = (n: number) => String(n).padStart(2, "0");
    // Jalali, not Gregorian: a Persian SMS with a 2026 date reads as foreign.
    return { ok: true, value: toPersianDigits(`${jy}/${pad(jm)}/${pad(jd)}`) };
  },
};

export function isTemplateVariable(name: unknown): name is TemplateVariable {
  return typeof name === "string" && Object.hasOwn(TEMPLATE_VARIABLE_RENDERERS, name);
}

/**
 * Which slots a body uses, in order, as `%token` = 0, `%token2` = 1, …
 *
 * Rejects anything the library cannot promise: an unknown `%…` (which the
 * provider would substitute literally or reject), `%token4` and above (the
 * provider's numbering is not positional there, so the variable mapping would
 * become guesswork), a numbered token with no `%token`, and duplicates (a body
 * that says `%token` twice would send one value and leave the other).
 */
export function tokenSlots(body: string): { ok: true; slots: number[] } | RenderFailure {
  const found = [...body.matchAll(/%[A-Za-z0-9_]*/g)].map((m) => m[0]);
  if (!found.length) return { ok: false, code: "body_missing_token" };
  const slots: number[] = [];
  for (const token of found) {
    const slot = TOKEN_SLOTS.indexOf(token.slice(1) as TokenSlot);
    if (slot === -1) return { ok: false, code: "token_slot_unsupported" };
    if (slots.includes(slot)) return { ok: false, code: "token_slot_unsupported" };
    slots.push(slot);
  }
  // Slots are positional, so they must be exactly the prefix 0..n-1.
  const sorted = [...slots].sort((a, b) => a - b);
  if (sorted.some((slot, index) => slot !== index)) {
    return { ok: false, code: "token_slot_gap" };
  }
  return { ok: true, slots: sorted };
}

/**
 * Validate a template's declared variables against its body.
 *
 * Called when the library entry is saved, so a bad mapping is an operator error
 * in the console (fixed in seconds) rather than a runtime failure for every
 * business that instantiated it.
 */
export function validateTemplateVariables(input: {
  body: string;
  variables: readonly string[];
}): { ok: true; variables: TemplateVariable[] } | RenderFailure {
  const slots = tokenSlots(input.body);
  if (!slots.ok) return slots;
  if (slots.slots.length !== input.variables.length) {
    return { ok: false, code: "variables_mismatch" };
  }
  const variables: TemplateVariable[] = [];
  for (const name of input.variables) {
    if (!isTemplateVariable(name)) return { ok: false, code: "variable_not_allowed", variable: name };
    variables.push(name);
  }
  return { ok: true, variables };
}

/**
 * Render a template's tokens from domain values.
 *
 * Returns the positional token strings (ready for `verify/lookup`) plus a
 * preview with the values substituted, which is what the tenant's screen shows
 * as the sample of the message it is about to approve.
 */
export function renderTemplateTokens(input: {
  body: string;
  variables: readonly string[];
  values: TemplateValues;
}): RenderResult {
  const checked = validateTemplateVariables({ body: input.body, variables: input.variables });
  if (!checked.ok) return checked;

  const tokens: string[] = [];
  for (const name of checked.variables) {
    const value = input.values[name];
    if (value === undefined || value === null || value === "") {
      return { ok: false, code: "variable_missing", variable: name };
    }
    const rendered = TEMPLATE_VARIABLE_RENDERERS[name](value);
    if (!rendered.ok) return { ok: false, code: "variable_invalid", variable: name };
    if (rendered.value.length > MAX_TOKEN_LENGTH) {
      return { ok: false, code: "variable_invalid", variable: name };
    }
    tokens.push(rendered.value);
  }

  let preview = input.body;
  checked.variables.forEach((_, index) => {
    preview = preview.replace(`%${TOKEN_SLOTS[index]}`, tokens[index]);
  });
  return { ok: true, tokens, preview };
}

/** Believable sample values, for the library browser and the tenant's preview. */
export const SAMPLE_TEMPLATE_VALUES: Record<TemplateVariable, string | number> = {
  code: "482913",
  customer_name: "سارا محمدی",
  store_name: "فروشگاه نمونه",
  order_number: "1042",
  amount: 250_000,
  date: "2026-10-28",
};

/**
 * A template rendered with sample values, never for sending.
 *
 * A sample that cannot render is itself a library bug, so the fallback is the
 * body with its tokens shown rather than an empty string the console would
 * render as a blank row.
 */
export function renderTemplateSample(input: {
  body: string;
  variables: readonly string[];
  values?: TemplateValues;
}): string {
  const result = renderTemplateTokens({
    body: input.body,
    variables: input.variables,
    values: { ...SAMPLE_TEMPLATE_VALUES, ...input.values },
  });
  return result.ok ? result.preview : input.body;
}
