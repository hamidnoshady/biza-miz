import { NextResponse } from "next/server";
import { platformCompanyStatusFor } from "@/lib/platform-company";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import type { PlatformCompanyStatus } from "@/lib/platform-company-types";

/**
 * The one read the Platform Business console makes before it renders anything.
 *
 * It reports the company, the caller's membership and — separately — whether
 * the caller may provision or administer staff, so a screen can show the right
 * message and only the controls that will actually work.
 */
export const GET = withPlatformScope(async (): Promise<NextResponse> => {
  const { session, error } = await requirePlatformAdmin();
  if (error) return error;
  const company: PlatformCompanyStatus = await platformCompanyStatusFor(session);
  return NextResponse.json({ company });
});
