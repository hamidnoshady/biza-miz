import { NextResponse } from "next/server";
import { NextRequest } from "next/server";

import { requirePlatformAdmin, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { createCmsDeployTarget, fetchCmsDeployTargets } from "@/lib/cms/platform-client";
import { cmsProxyError, requireCmsClient } from "../_cms-proxy";

export const GET = withPlatformScope(async () => {
  const { session, error } = await requirePlatformAdmin();
  if (error) return error;
  const client = await requireCmsClient(session.padmin);
  if (client.error) return client.error;
  try {
    const targets = await fetchCmsDeployTargets(client.config!, { actor: session.padmin });
    return NextResponse.json({ targets });
  } catch (err) {
    return cmsProxyError(err);
  }
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("cms.manage");
  if (error) return error;
  const client = await requireCmsClient(session.padmin);
  if (client.error) return client.error;
  let body: Record<string, unknown>;
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  try {
    const target = await createCmsDeployTarget(client.config!, body, { actor: session.padmin });
    return NextResponse.json({ target });
  } catch (err) {
    return cmsProxyError(err);
  }
});
