import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  AgencyReservationError,
  reservationWindow,
} from "@/lib/agency-reservation";
import {
  createReservation,
  listReservations,
} from "@/lib/agency-reservation-service";
import {
  agencyOwner,
  PERMISSIONS,
  readBody,
  handleAgencyError,
} from "../../../guard";
type Context = { params: Promise<{ id: string }> };
function refusal(err: unknown) {
  if (err instanceof AgencyReservationError)
    return NextResponse.json(
      { error: err.code },
      { status: err.code === "invalid_reservation" ? 400 : 409 },
    );
  return handleAgencyError(err);
}
export const GET = withTenantScope(
  async (request: NextRequest, context: Context) => {
    const { owner, error } = await agencyOwner(
      PERMISSIONS.workspaceView,
      request,
    );
    if (error) return error;
    try {
      const data = await listReservations(
        owner,
        (await context.params).id,
        reservationWindow(request.nextUrl.searchParams),
      );
      return NextResponse.json({
        ...data,
        canWrite: data.canManage && Boolean(owner.access?.canManage),
      });
    } catch (err) {
      return refusal(err);
    }
  },
);
export const POST = withTenantScope(
  async (request: NextRequest, context: Context) => {
    const { owner, error } = await agencyOwner(
      PERMISSIONS.workspaceManage,
      request,
    );
    if (error) return error;
    try {
      return NextResponse.json(
        await createReservation(
          owner,
          (await context.params).id,
          await readBody(request),
        ),
        { status: 201 },
      );
    } catch (err) {
      return refusal(err);
    }
  },
);
