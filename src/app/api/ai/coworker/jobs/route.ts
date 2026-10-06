import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requirePermission } from "@/lib/auth";
import { coworkerErrorMessage, type CoworkerJobInput } from "@/lib/ai-coworker";
import { TEMPLATE_PARAM_ERROR_MESSAGES } from "@/lib/ai-coworker-templates";
import { createCoworkerJob, listCoworkerJobs } from "@/lib/ai-coworker-service";

function messageFor(code: string): string {
  return TEMPLATE_PARAM_ERROR_MESSAGES[code] ?? coworkerErrorMessage(code);
}

export const GET = withTenantScope(async () => {
  const guard = await requirePermission(PERMISSIONS.aiManage);
  if (guard.error) return guard.error;
  return NextResponse.json({ jobs: await listCoworkerJobs(guard.session.businessId) });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.aiManage);
  if (guard.error) return guard.error;

  let body: Partial<CoworkerJobInput>;
  try {
    body = (await request.json()) as Partial<CoworkerJobInput>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Unattended writes are the owner's call, the same rule the autopilot money
  // category follows: a manager may create a job, but only an owner may set one
  // to apply without asking.
  if (body.approvalMode === "auto" && guard.session.role !== "owner") {
    return NextResponse.json({ error: "owner_required" }, { status: 403 });
  }

  const created = await createCoworkerJob(guard.session.businessId, body, guard.session.sub);
  if (!created.ok) {
    return NextResponse.json(
      { error: created.errors[0], errors: created.errors, messages: created.errors.map(messageFor) },
      { status: 400 },
    );
  }
  return NextResponse.json({ job: created.job }, { status: 201 });
});
