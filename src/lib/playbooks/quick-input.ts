/**
 * Typed quick-input validation (issue #1590 §3). Users never provide JSON,
 * rule graphs, credentials, provider models, or arbitrary code. Unknown keys
 * are rejected; values are coerced only within declared bounds; authorized
 * defaults are applied. Money is integer Rial.
 */
import type { PlaybookTemplate, QuickInputField } from "./types";

export interface InputProblem {
  field: string;
  message: string;
}

export interface ValidatedInputs {
  ok: boolean;
  problems: InputProblem[];
  /** Cleaned values keyed by field; defaults applied. */
  values: Record<string, string | number | boolean | null>;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function validateField(field: QuickInputField, raw: unknown): { value: string | number | boolean | null; problem?: string } {
  const missing = raw === undefined || raw === null || raw === "";
  if (missing) {
    if (field.default !== undefined && field.default !== null) return { value: field.default };
    if (field.required) return { value: null, problem: "required" };
    return { value: null };
  }

  switch (field.type) {
    case "boolean": {
      if (typeof raw === "boolean") return { value: raw };
      if (raw === "true") return { value: true };
      if (raw === "false") return { value: false };
      return { value: null, problem: "invalid_boolean" };
    }
    case "number":
    case "money_rial":
    case "duration_days": {
      const n = typeof raw === "string" ? Number(raw.replace(/[,\s]/g, "")) : raw;
      if (!isFiniteNumber(n)) return { value: null, problem: "invalid_number" };
      if (field.type === "money_rial" && !Number.isInteger(n)) return { value: null, problem: "money_must_be_integer_rial" };
      if (field.type === "money_rial" && n < 0) return { value: null, problem: "money_negative" };
      if (field.type === "duration_days" && (!Number.isInteger(n) || n < 0)) return { value: null, problem: "invalid_duration" };
      if (field.min !== undefined && n < field.min) return { value: null, problem: `min:${field.min}` };
      if (field.max !== undefined && n > field.max) return { value: null, problem: `max:${field.max}` };
      return { value: n };
    }
    case "enum":
    case "channel": {
      const s = String(raw);
      // `channel` validates against declared options; canonical channel check re-applied server-side.
      if (field.options && field.options.length > 0 && !field.options.some((o) => o.value === s)) {
        return { value: null, problem: "invalid_enum" };
      }
      if (field.type === "channel" && s !== "sms" && s !== "email") return { value: null, problem: "invalid_channel" };
      return { value: s };
    }
    // ids/strings: trim; never trust for authorization (re-checked server-side on use).
    default: {
      const s = String(raw).trim();
      if (field.type === "text" && s.length > 2000) return { value: null, problem: "too_long" };
      return { value: s };
    }
  }
}

export function validateQuickInputs(template: PlaybookTemplate, raw: unknown): ValidatedInputs {
  const problems: InputProblem[] = [];
  const values: Record<string, string | number | boolean | null> = {};

  if (raw === null || raw === undefined) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, problems: [{ field: "(root)", message: "inputs must be an object" }], values: {} };
  }
  const input = raw as Record<string, unknown>;
  const allowed = new Set(template.quickInputSchema.fields.map((f) => f.key));

  // Reject unknown keys (closed schema).
  for (const k of Object.keys(input)) {
    if (!allowed.has(k)) problems.push({ field: k, message: "unknown_field" });
  }

  for (const field of template.quickInputSchema.fields) {
    const { value, problem } = validateField(field, input[field.key]);
    values[field.key] = value;
    if (problem) problems.push({ field: field.key, message: problem });
  }

  return { ok: problems.length === 0, problems, values };
}
