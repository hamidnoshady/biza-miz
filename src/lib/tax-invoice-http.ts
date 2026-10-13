/**
 * Issue #866 — the HTTP half shared by every `/api/ledger/tax-invoices` route:
 * one place that turns a service refusal into a status code, and one place that
 * reads a JSON body without throwing on a malformed one.
 */
import { NextResponse } from "next/server";
import { TaxServiceError } from "./tax-invoice-service";
import { TAX_KINDS, TAX_STATUSES, TAX_VIEWS } from "./tax-invoice";

export function taxErrorResponse(error: unknown): NextResponse {
  if (error instanceof TaxServiceError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof RangeError) {
    return NextResponse.json({ error: "invalid_request", message: error.message }, { status: 400 });
  }
  throw error;
}

export async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    const body = (await request.json()) as unknown;
    return body !== null && typeof body === "object" ? (body as T) : null;
  } catch {
    return null;
  }
}

/** A list of uuid strings from a body field, or null when the field is absent or malformed. */
export function stringArray(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return null;
  if (!value.every((item) => typeof item === "string")) return null;
  return value as string[];
}

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optionalDay(value: string | null): string | undefined {
  if (value === null || value === "") return undefined;
  if (!ISO_DAY_PATTERN.test(value)) throw new RangeError("تاریخ باید به صورت YYYY-MM-DD باشد.");
  return value;
}

function optionalUuid(value: string | null): string | undefined {
  if (value === null || value === "") return undefined;
  if (!UUID_LIKE.test(value)) throw new RangeError("شناسه نامعتبر است.");
  return value;
}

/** The register's filters from a query string. Anything outside the vocabulary is a 400, not ignored. */
export function registerFiltersFromSearch(params: URLSearchParams): import("./tax-invoice-queries").TaxRegisterFilters {
  const view = params.get("view") ?? "all";
  if (view !== "all" && !(TAX_VIEWS as readonly string[]).includes(view)) throw new RangeError("نمای نامعتبر است.");
  const status = params.get("status") ?? "";
  if (status && !(TAX_STATUSES as readonly string[]).includes(status)) throw new RangeError("وضعیت نامعتبر است.");
  const kind = params.get("kind") ?? "";
  if (kind && !(TAX_KINDS as readonly string[]).includes(kind)) throw new RangeError("نوع نامعتبر است.");
  const q = (params.get("q") ?? "").trim();
  if (q.length > 100) throw new RangeError("متن جستجو بیش از حد طولانی است.");
  return {
    view: view as "all" | "unsent" | "sent" | "error",
    status: (status || undefined) as import("./tax-invoice").TaxStatus | undefined,
    kind: (kind || undefined) as import("./tax-invoice").TaxKind | undefined,
    from: optionalDay(params.get("from")),
    to: optionalDay(params.get("to")),
    locationId: optionalUuid(params.get("locationId")),
    customerId: optionalUuid(params.get("customerId")),
    q: q || undefined,
  };
}
