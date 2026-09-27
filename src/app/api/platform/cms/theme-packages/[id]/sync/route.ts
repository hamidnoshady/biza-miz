import { NextResponse } from "next/server";
import { NextRequest } from "next/server";

import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { syncCmsThemePackage } from "@/lib/cms/platform-client";
import { cmsProxyError, requireCmsClient } from "../../../_cms-proxy";

export const POST = withPlatformScope(
  async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePlatformCapability("cms.manage");
    if (error) return error;
    const { id } = await ctx.params;
    const client = await requireCmsClient(session.padmin);
    if (client.error) return client.error;
    let body: { ref?: string } = {};
    try {
      body = ((await request.json()) ?? {}) as { ref?: string };
    } catch {
      body = {};
    }
    try {
      const result = await syncCmsThemePackage(client.config!, id, body, { actor: session.padmin });
      return NextResponse.json(result);
    } catch (err) {
      return cmsProxyError(err);
    }
  },
);
