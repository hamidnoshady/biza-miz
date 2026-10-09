import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { MulticurrencyError, postMulticurrencyEntry } from "@/lib/multicurrency-service";
import {
  multicurrencyDocumentProblemMessage,
  parseMulticurrencyEntryPayload,
  type MulticurrencyDocumentProblem,
} from "@/lib/multicurrency";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Foreign-currency documents: «اسناد ارزی».
 *
 * POST posts one document in one transaction currency: lines carry foreign
 * amounts (integer minor units as text), optional booked-base releases (a
 * settlement's control leg), or base-only legs (the FX gain/loss line). The
 * service resolves — or the caller pins — one rate, freezes the full snapshot
 * onto the entry, balances foreign and base exactly under rounding policy v1,
 * and returns the totals. `idempotencyKey` makes a retry return the entry it
 * already created instead of a second one.
 *
 * GET lists foreign-currency entries newest-first, with their currency, frozen
 * rate and rounding delta — the same book «دفتر روزنامه» shows, filtered to
 * the documents this subsystem owns.
 */

const FOREIGN_ENTRY_PAGE = 50;

interface EntryRow extends Record<string, unknown> {
  id: string;
  entry_date: string;
  memo: string | null;
  source_type: string | null;
  currency_code: string;
  base_currency_code: string;
  exchange_rate: string;
  exchange_rate_id: string;
  rounding_version: number | null;
  rounding_delta: string;
  reverses_entry_id: string | null;
  reversed_at: Date | null;
  created_by_name: string | null;
  foreign_total: string;
  total_debit: string;
}

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const limitRaw = Number(params.get("limit"));
  const limit = Number.isSafeInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : FOREIGN_ENTRY_PAGE;
  const currencyParam = params.get("currency");
  if (currencyParam && !/^[A-Za-z]{3}$/.test(currencyParam)) {
    return NextResponse.json({ error: "invalid_currency" }, { status: 400 });
  }
  const cursorDate = params.get("cursorDate");
  const cursorId = params.get("cursorId");
  const hasCursor = cursorDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(cursorDate) && cursorId !== null && isUuid(cursorId);

  const { rows } = await query<EntryRow>(
    `SELECT je.id::text AS id, je.entry_date::text AS entry_date, je.memo, je.source_type,
            je.currency_code, je.base_currency_code,
            je.exchange_rate::text AS exchange_rate, je.exchange_rate_id::text AS exchange_rate_id,
            je.rounding_version, je.rounding_delta::text AS rounding_delta,
            je.reverses_entry_id::text AS reverses_entry_id, je.reversed_at,
            u.full_name AS created_by_name,
            COALESCE(fx.foreign_total, 0)::text AS foreign_total,
            COALESCE(totals.total_debit, 0)::text AS total_debit
       FROM journal_entries je
       LEFT JOIN users u ON u.id = je.created_by
       LEFT JOIN LATERAL (
         SELECT sum(foreign_debit)::bigint AS foreign_total
           FROM journal_lines WHERE entry_id = je.id
       ) fx ON true
       LEFT JOIN LATERAL (
         SELECT sum(debit)::bigint AS total_debit
           FROM journal_lines WHERE entry_id = je.id
       ) totals ON true
      WHERE je.business_id = $1
        AND je.currency_code IS NOT NULL
        AND ($2::text IS NULL OR je.currency_code = $2::text)
        AND ($3::boolean = false OR (je.entry_date, je.id) < ($4::date, $5::uuid))
      ORDER BY je.entry_date DESC, je.id DESC
      LIMIT $6`,
    [session.businessId, currencyParam ? currencyParam.toUpperCase() : null, hasCursor, hasCursor ? cursorDate : null, hasCursor ? cursorId : null, limit],
  );
  return NextResponse.json({ entries: rows });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPost);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = parseMulticurrencyEntryPayload(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.problem }, { status: 400 });

  const location = await resolveActiveLocation(session);

  try {
    const posted = await postMulticurrencyEntry({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      entryDate: parsed.value.entryDate,
      memo: parsed.value.memo,
      currencyCode: parsed.value.currencyCode,
      rateId: parsed.value.rateId,
      lines: parsed.value.lines,
      createdBy: session.sub,
      idempotencyKey: parsed.value.idempotencyKey,
    });
    return NextResponse.json(posted, { status: posted.duplicate ? 200 : 201 });
  } catch (err) {
    if (err instanceof MulticurrencyError) {
      const message = multicurrencyDocumentProblemMessage(err.message as MulticurrencyDocumentProblem);
      return NextResponse.json(
        { error: err.message, message: message ?? undefined },
        { status: err.status },
      );
    }
    throw err;
  }
});
