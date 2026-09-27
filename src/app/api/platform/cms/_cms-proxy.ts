import { NextResponse } from "next/server";

import { CmsApiError } from "@/lib/cms/client";
import { cmsErrorCode } from "@/lib/cms/platform-sync";
import { resolvePlatformCmsConfig } from "@/lib/cms/platform-control-service";

export async function requireCmsClient(actor?: string) {
  const config = await resolvePlatformCmsConfig();
  if (!config) {
    return { config: null as null, error: NextResponse.json({ error: "cms_not_configured" }, { status: 400 }) };
  }
  return { config, actor: actor ?? null, error: null as null };
}

export function cmsProxyError(err: unknown) {
  const code = cmsErrorCode(err);
  const status =
    err instanceof CmsApiError
      ? err.status >= 500
        ? 502
        : err.status === 403
          ? 403
          : err.status === 404
            ? 404
            : 400
      : code === "cms_unreachable"
        ? 502
        : 400;
  return NextResponse.json(
    { error: code, message: (err as Error)?.message ?? null },
    { status },
  );
}
