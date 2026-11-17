import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createAgencyTime, listAgencyTime } from "@/lib/agency-time-service";
import { AgencyTimeError } from "@/lib/agency-time";
import {
  agencyOwner,
  PERMISSIONS,
  readBody,
  handleAgencyError,
} from "../../../guard";
function refusal(err: unknown) {
  if (err instanceof AgencyTimeError)
    return NextResponse.json(
      { error: err.code },
      {
        status:
          err.code === "invalid_time"
            ? 400
            : err.code === "time_forbidden"
              ? 403
              : 409,
      },
    );
  return handleAgencyError(err);
}
type Context = { params: Promise<{ id: string }> };
export const GET = withTenantScope(
  async (request: NextRequest, context: Context) => {
    const { owner, error } = await agencyOwner(
      PERMISSIONS.workspaceView,
      request,
    );
    if (error) return error;
    try {
      const data = await listAgencyTime(owner, (await context.params).id);
      return NextResponse.json({
        ...data,
        canWrite: data.canContribute && Boolean(owner.access?.canManage),
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
        await createAgencyTime(
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
