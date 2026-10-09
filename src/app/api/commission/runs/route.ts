import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { actorOf, commissionErrorResponse, csvResponse, exportStamp } from "@/lib/commission-settlement-http";
import {
  parseCreateRunBody,
  parseIdempotencyKey,
  parseRunListQuery,
} from "@/lib/commission-settlement-input";
import {
  createCommissionRun,
  exportCommissionRuns,
  listCommissionRuns,
} from "@/lib/commission-settlement-service";
import { runsToCsv } from "@/lib/commission-settlement-csv";
import { resolveBusinessMoneyUnit } from "@/lib/ai-money-unit";
import { badRequest, readJsonObject } from "@/lib/payroll-http";

/**
 * The commission settlement runs, newest first (issue #869).
 *
 * `?status=`, `?limit=`, `?offset=`; `?format=csv` downloads the list with the
 * same filter. Gated on `commission.view`: a run is compensation data.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.commissionView);
  if (error) return error;

  try {
    const options = parseRunListQuery(request.nextUrl.searchParams);
    if (options.format === "csv") {
      const unit = await resolveBusinessMoneyUnit(session.businessId);
      const rows = await exportCommissionRuns(session.businessId, options.status);
      return csvResponse(runsToCsv(rows, unit), `دوره‌های-تسویه-پورسانت-${exportStamp()}.csv`);
    }
    return NextResponse.json(await listCommissionRuns(session.businessId, options));
  } catch (err) {
    const response = commissionErrorResponse(err);
    if (response) return response;
    throw err;
  }
});

/**
 * Open a draft run for a period (Gregorian storage; the screen picks Shamsi
 * dates). Body: `periodFrom`, `periodTo`, optional `locationId`, `employeeIds`,
 * `title`, and an optional `idempotencyKey` (or the `Idempotency-Key` header).
 * Same key and same request replays the run (`200`, `replayed: true`); the same
 * key with a different request is `409 idempotency_key_conflict`.
 *
 * Creating a draft moves no money and claims nothing; calculating it does. Gated
 * on `commission.calculate`.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.commissionCalculate);
  if (error) return error;

  const body = await readJsonObject(request);
  if (!body) return badRequest();

  try {
    const input = parseCreateRunBody(body);
    const key = parseIdempotencyKey(request.headers.get("idempotency-key"), body.idempotencyKey);
    const result = await createCommissionRun(session.businessId, actorOf(session, membership), input, key);
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (err) {
    const response = commissionErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
