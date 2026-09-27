import { NextResponse } from "next/server";
import { NextRequest } from "next/server";

import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { selfTestCmsDeployTarget } from "@/lib/cms/platform-client";
import { cmsProxyError, requireCmsClient } from "../../_cms-proxy";

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("cms.manage");
  if (error) return error;
  const client = await requireCmsClient(session.padmin);
  if (client.error) return client.error;
  let body: { id?: string };
  try {
    body = ((await request.json()) ?? {}) as { id?: string };
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "missing_id" }, { status: 400 });
  try {
    const result = await selfTestCmsDeployTarget(client.config!, body.id, { actor: session.padmin });
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (err) {
    return cmsProxyError(err);
  }
});
