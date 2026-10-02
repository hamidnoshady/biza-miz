import { NextResponse } from "next/server";
import { platformCompanyStatus } from "@/lib/platform-company";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";

export const GET = withPlatformScope(async () => {
  const { session, error } = await requirePlatformAdmin();
  if (error) return error;
  return NextResponse.json({ company: await platformCompanyStatus(session.padmin) });
});
