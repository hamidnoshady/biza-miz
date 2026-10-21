import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { deploymentRole } from "@/lib/deployment-role";

/** Main-process per-invocation role check, not a transferable approval token. */
export const POST = withTenantScope(async () => {
  const { error } = await requireRole("owner");
  if (error) return error;
  if (deploymentRole() !== "site") {
    return NextResponse.json({ error: "not_local_install" }, { status: 409 });
  }
  return NextResponse.json({ authorized: true }, { headers: { "Cache-Control": "no-store" } });
});
