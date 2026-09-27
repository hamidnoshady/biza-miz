import { NextResponse } from "next/server";
import { NextRequest } from "next/server";

import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { runCmsPaymentsSelfTest, runCmsStorageSelfTest } from "@/lib/cms/platform-client";
import { cmsProxyError, requireCmsClient } from "../_cms-proxy";

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("cms.manage");
  if (error) return error;
  const client = await requireCmsClient(session.padmin);
  if (client.error) return client.error;

  let body: { kind?: string; payload?: Record<string, unknown> };
  try {
    body = ((await request.json()) ?? {}) as { kind?: string; payload?: Record<string, unknown> };
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const kind = body.kind === "storage" ? "storage" : "payments";
  const payload = body.payload ?? {};

  try {
    const result =
      kind === "storage"
        ? await runCmsStorageSelfTest(client.config!, payload, { actor: session.padmin })
        : await runCmsPaymentsSelfTest(client.config!, payload, { actor: session.padmin });
    return NextResponse.json({ kind, result });
  } catch (err) {
    return cmsProxyError(err);
  }
});
