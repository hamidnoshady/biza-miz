import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import {
  getAppUpdateStatus,
  getDesktopUpdatePolicy,
  setDesktopUpdatePolicy,
} from "@/lib/app-update";
import { isDesktopReleaseChannel } from "@/lib/desktop-release";

/** Owner-only bridge from the local web runtime to the Electron update UI. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner");
  if (error) return error;
  const [status, policy] = await Promise.all([
    getAppUpdateStatus(session.businessId),
    getDesktopUpdatePolicy(session.businessId),
  ]);
  return NextResponse.json({ status, policy });
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;
  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  if (!isDesktopReleaseChannel(body.channel)) {
    return NextResponse.json({ error: "invalid_release_channel" }, { status: 400 });
  }
  const policy = {
    automaticChecks: body.automaticChecks !== false,
    backgroundDownload: body.backgroundDownload === true,
    automaticInstall: false as const,
    channel: body.channel,
  };
  await setDesktopUpdatePolicy(session.businessId, policy);
  return NextResponse.json({ policy });
});
