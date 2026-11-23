/**
 * The recurring-voucher request body, parsed strictly.
 *
 * Kept out of the route and out of the service so the browser preview and both
 * API verbs apply exactly one reading of a body. Amounts are accepted as
 * numbers only — no `Number("۱۲٫۵")` coercion at the boundary — and every
 * field's *meaning* is still decided by `recurringVoucherProblem`.
 */
import { parseLineDimensions } from "./accounting-dimensions";
import type { RecurringTemplateInput } from "./recurring-voucher-service";
import type { RecurringVoucherLine } from "./recurring-voucher";

export type RecurringTemplateBodyResult =
  | { ok: true; value: RecurringTemplateInput }
  | { ok: false; problem: string };

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function parseRecurringTemplateBody(body: unknown): RecurringTemplateBodyResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, problem: "bad_request" };
  }
  const raw = body as Record<string, unknown>;

  const name = text(raw.name);
  const memo = text(raw.memo);
  const frequency = text(raw.frequency);
  const monthEndPolicy = text(raw.monthEndPolicy);
  const startDate = text(raw.startDate);
  if (
    name === null ||
    memo === null ||
    frequency === null ||
    monthEndPolicy === null ||
    startDate === null
  ) {
    return { ok: false, problem: "bad_request" };
  }

  if (!Array.isArray(raw.lines)) return { ok: false, problem: "invalid_line" };
  const lines: RecurringVoucherLine[] = [];
  for (const entry of raw.lines) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, problem: "invalid_line" };
    }
    const line = entry as Record<string, unknown>;
    if (typeof line.accountId !== "string") return { ok: false, problem: "invalid_account_id" };
    if (typeof line.debit !== "number" || typeof line.credit !== "number") {
      return { ok: false, problem: "invalid_amount" };
    }
    if (line.partyId !== undefined && line.partyId !== null && typeof line.partyId !== "string") {
      return { ok: false, problem: "invalid_party_id" };
    }
    const dimensions = parseLineDimensions(line.dimensions);
    if (!dimensions.ok) return { ok: false, problem: "invalid_dimension" };
    lines.push({
      accountId: line.accountId,
      debit: line.debit,
      credit: line.credit,
      partyId: (line.partyId as string | null | undefined) ?? null,
      description: text(line.description),
      dimensions: dimensions.value,
    });
  }

  const endDate = raw.endDate === undefined || raw.endDate === null || raw.endDate === "" ? null : text(raw.endDate);
  if (raw.endDate !== undefined && raw.endDate !== null && raw.endDate !== "" && endDate === null) {
    return { ok: false, problem: "invalid_end_date" };
  }
  const locationId = raw.locationId === undefined || raw.locationId === null || raw.locationId === ""
    ? null
    : text(raw.locationId);
  if (raw.locationId !== undefined && raw.locationId !== null && raw.locationId !== "" && locationId === null) {
    return { ok: false, problem: "invalid_location" };
  }
  const ownerUserId = raw.ownerUserId === undefined || raw.ownerUserId === null || raw.ownerUserId === ""
    ? null
    : text(raw.ownerUserId);

  return {
    ok: true,
    value: {
      name,
      description: text(raw.description),
      memo,
      voucherReference: text(raw.voucherReference),
      frequency,
      monthEndPolicy,
      startDate,
      endDate,
      locationId,
      ownerUserId,
      lines,
    },
  };
}
