import { NextResponse } from "next/server";
import { NextRequest } from "next/server";

import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { deleteCmsDeployTarget, updateCmsDeployTarget } from "@/lib/cms/platform-client";
import { cmsProxyError, requireCmsClient } from "../../_cms-proxy";

export const PATCH = withPlatformScope(
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
    try {
      const target = await updateCmsDeployTarget(client.config!, id, body, { actor: session.padmin });
      return NextResponse.json({ target });
    } catch (err) {
      return cmsProxyError(err);
    }
  },
);

export const DELETE = withPlatformScope(async (_request, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePlatformCapability("cms.manage");
  if (error) return error;
  const { id } = await ctx.params;
  const client = await requireCmsClient(session.padmin);
  if (client.error) return client.error;
  try {
    await deleteCmsDeployTarget(client.config!, id, { actor: session.padmin });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return cmsProxyError(err);
  }
});
