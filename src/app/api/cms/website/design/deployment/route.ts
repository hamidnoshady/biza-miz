import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  createEdgeDeployment,
  getDeployment,
  mapDeploymentError,
  pollDeployment,
} from "@/lib/cms/platform-deployments-client";
import { ownerPlatformContext } from "@/lib/cms/owner-api-context";

export const GET = withTenantScope(async (_request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsView);
  if (error) return error;
  const ctx = await ownerPlatformContext(session.businessId);
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.error === "not_connected" ? 409 : 503 });
  try {
    const status = await getDeployment(ctx.config, ctx.siteId);
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json({ error: mapDeploymentError(err) }, { status: 503 });
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsConfigure);
  if (error) return error;
  const ctx = await ownerPlatformContext(session.businessId);
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.error === "not_connected" ? 409 : 503 });

  let body: { action?: string; package?: string; ref?: string; deployment?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    if (body.action === "poll") {
      const deploymentId = typeof body.deployment === "string" ? body.deployment : "";
      if (!deploymentId) return NextResponse.json({ error: "bad_request" }, { status: 400 });
      const polled = await pollDeployment(ctx.config, ctx.siteId, deploymentId);
      return NextResponse.json(polled);
    }
    const packageRef = typeof body.package === "string" ? body.package : "";
    if (!packageRef) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const created = await createEdgeDeployment(ctx.config, ctx.siteId, {
      package: packageRef,
      ref: typeof body.ref === "string" ? body.ref : null,
    });
    return NextResponse.json(created, { status: 202 });
  } catch (err) {
    return NextResponse.json({ error: mapDeploymentError(err) }, { status: 503 });
  }
});
