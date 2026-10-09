/**
 * The one error map every `/api/automotive/*` route uses — the same shape as
 * `/api/aec/guard.ts` and `/api/workspace/guard.ts`.
 *
 * The split is the one the rest of the platform uses: a record that does not
 * exist is a 404, a malformed field a 400, and anything a car's *state* refuses
 * — selling it twice, transferring it while a customer holds it, editing a sold
 * vehicle — a 409, because the request was reasonable and the car is what says
 * no. `industry_mismatch`/`permission` refusals are already shaped by
 * `requireIndustryForApi` and `requirePermission` and never reach this map.
 */
import { NextResponse } from "next/server";
import type { SessionPayload } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import type { Permission } from "@/lib/permissions";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { VehicleError } from "@/lib/automotive-service";
import { SerialReservationError } from "@/lib/watch-reservation-service";

const ERROR_STATUS: Record<string, number> = {
  invalid_vehicle: 400,
  invalid_vin: 400,
  invalid_chassis: 400,
  invalid_plate: 400,
  invalid_mileage: 400,
  invalid_prior_owners: 400,
  invalid_amount: 400,
  invalid_date: 400,
  invalid_year: 400,
  reason_required: 400,
  actor_required: 400,
  same_location: 400,
  vehicle_not_found: 404,
  cost_not_found: 404,
  transfer_not_found: 404,
  location_not_found: 404,
  reservation_not_found: 404,
  // A car's own state refusing a reasonable request.
  vehicle_sold: 409,
  vehicle_archived: 409,
  vehicle_reserved: 409,
  already_in_transit: 409,
  wrong_location: 409,
  cost_already_void: 409,
  transfer_closed: 409,
  invalid_state_transition: 409,
  reservation_closed: 409,
  deposit_already_taken: 409,
  // Nothing wrong with the request: the chart a posting needs is not seeded.
  ledger_account_missing: 409,
};

export function handleAutomotiveError(err: unknown): NextResponse {
  if (err instanceof VehicleError) {
    return NextResponse.json(
      { error: err.code, message: err.message },
      { status: ERROR_STATUS[err.code] ?? err.status },
    );
  }
  if (err instanceof SerialReservationError) {
    return NextResponse.json(
      { error: "reservation_rejected", message: err.message },
      { status: err.status },
    );
  }
  if (err instanceof MissingLedgerAccountError) {
    return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
  }
  // A unique-identity violation (a VIN, chassis, engine or stock number already
  // in this business's stock). The service pre-checks with a sentence; this is
  // the structural backstop for the race it cannot see.
  const code = (err as { code?: string })?.code;
  if (code === "23505") {
    return NextResponse.json({ error: "duplicate_vehicle_identity" }, { status: 409 });
  }
  throw err;
}

/**
 * Whether the member holds one permission. Some automotive acts need a *second*
 * key on top of the screen's own (recording an expense needs
 * `vehicles.expense_record`, not just `vehicles.edit`; reading cost needs
 * `vehicles.cost_view`, not just `vehicles.view`), and the answer must be the
 * member's *effective* set — role preset plus per-member overrides — never a
 * role list, because a role list is a second authorization system.
 */
export async function holdsPermission(session: SessionPayload, permission: Permission): Promise<boolean> {
  const access = await memberAccessFor(session);
  return access?.permissions.has(permission) ?? false;
}

/** Reads a JSON body, returning `{}` rather than throwing on a malformed one. */
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}
