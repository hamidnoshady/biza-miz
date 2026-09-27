import { NextResponse } from "next/server";
import { NextRequest } from "next/server";

import { requirePlatformAdmin, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { createCmsSiteDeployment, fetchCmsSiteDeployment } from "@/lib/cms/platform-client";
import { cmsProxyError, requireCmsClient } from "../../../_cms-proxy";

export const GET = withPlatformScope(
  async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePlatformAdmin();
    if (error) return error;
    const { id } = await ctx.params;
    const client = await requireCmsClient(session.padmin);
    if (client.error) return client.error;
    try {
      const deployment = await fetchCmsSiteDeployment(client.config!, id, { actor: session.padmin });
      return NextResponse.json({ deployment });
    } catch (err) {
      return cmsProxyError(err);
    }
  },
);

export const POST = withPlatformScope(
  async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePlatformCapability("cms.manage");
    if (error) return error;
    const { id } = await ctx.params;
    const client = await requireCmsClient(session.padmin);
    if (client.error) return client.error;
    let body: Record<string, unknown>;
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (!body.package) return NextResponse.json({ error: "missing_package" }, { status: 400 });
    try {
      const result = await createCmsSiteDeployment(
        client.config!,
        id,
        {
          domainMode: typeof body.domainMode === "string" ? body.domainMode : undefined,
          package: String(body.package),
          ref: typeof body.ref === "string" ? body.ref : undefined,
          target: typeof body.target === "string" ? body.target : undefined,
        },
        { actor: session.padmin },
      );
      return NextResponse.json(result, { status: 202 });
    } catch (err) {
      return cmsProxyError(err);
    }
  },
);
