import { NextResponse } from "next/server";
import { NextRequest } from "next/server";

import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  pollCmsSiteDeployment,
  redeployCmsSiteDeployment,
  revertCmsSiteDeployments,
  rollbackCmsSiteDeployment,
  stopCmsSiteDeployment,
  verifyCmsSiteDeployment,
} from "@/lib/cms/platform-client";
import { cmsProxyError, requireCmsClient } from "../../../../_cms-proxy";

const ACTIONS = new Set(["poll", "redeploy", "rollback", "verify", "stop", "revert"]);

export const POST = withPlatformScope(
  async (request: NextRequest, ctx: { params: Promise<{ id: string; action: string }> }) => {
    const { session, error } = await requirePlatformCapability("cms.manage");
    if (error) return error;
    const { id, action } = await ctx.params;
    if (!ACTIONS.has(action)) return NextResponse.json({ error: "unknown_action" }, { status: 404 });

    const client = await requireCmsClient(session.padmin);
    if (client.error) return client.error;

    let body: Record<string, unknown> = {};
    try {
      body = action === "revert" ? {} : ((await request.json()) ?? {}) as Record<string, unknown>;
    } catch {
      body = {};
    }

    try {
      if (action === "revert") {
        const result = await revertCmsSiteDeployments(client.config!, id, { actor: session.padmin });
        return NextResponse.json(result);
      }
      if (action === "redeploy") {
        const result = await redeployCmsSiteDeployment(
          client.config!,
          id,
          {
            domainMode: typeof body.domainMode === "string" ? body.domainMode : undefined,
            ref: typeof body.ref === "string" ? body.ref : undefined,
          },
          { actor: session.padmin },
        );
        return NextResponse.json(result, { status: 202 });
      }
      const deploymentId = typeof body.deployment === "string" ? body.deployment : "";
      if (!deploymentId && action !== "revert") {
        return NextResponse.json({ error: "missing_deployment" }, { status: 400 });
      }
      if (action === "poll") {
        const result = await pollCmsSiteDeployment(client.config!, id, deploymentId, {
          actor: session.padmin,
        });
        return NextResponse.json(result);
      }
      if (action === "verify") {
        const result = await verifyCmsSiteDeployment(client.config!, id, deploymentId, {
          actor: session.padmin,
        });
        return NextResponse.json(result, { status: result.ok ? 200 : 422 });
      }
      if (action === "stop") {
        const result = await stopCmsSiteDeployment(
          client.config!,
          id,
          deploymentId,
          { reason: typeof body.reason === "string" ? body.reason : undefined },
          { actor: session.padmin },
        );
        return NextResponse.json(result);
      }
      if (action === "rollback") {
        const result = await rollbackCmsSiteDeployment(client.config!, id, deploymentId, {
          actor: session.padmin,
        });
        return NextResponse.json(result, { status: 202 });
      }
      return NextResponse.json({ error: "unknown_action" }, { status: 404 });
    } catch (err) {
      return cmsProxyError(err);
    }
  },
);
