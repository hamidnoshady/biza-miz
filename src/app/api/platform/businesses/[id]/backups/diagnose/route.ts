import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getBusiness } from "@/lib/platform-service";
import { diagnoseBusinessBackup } from "@/lib/platform-tenant-backup-ops";

/**
 * Issue #903 §3 — "diagnose" for one business.
 *
 * Answers the operator's actual question ("why is this business not protected?")
 * from facts the platform already holds: effective policy, destination
 * resolution (including the legacy-bucket compatibility case), custody
 * generation and whether the KEK is present, managed bytes, queue depth, the
 * device heartbeat and the artifact-state histogram. `actions` is a list of
 * codes, so the console owns the wording and the route stays stable.
 *
 * Read capability on purpose: diagnosis changes nothing.
 */
export const GET = withPlatformScope(
  async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { error } = await requirePlatformCapability("tenant_backup.read");
    if (error) return error;
    const { id } = await ctx.params;
    if (!(await getBusiness(id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const diagnosis = await diagnoseBusinessBackup(id);
    return NextResponse.json({ diagnosis }, { headers: { "Cache-Control": "no-store" } });
  },
);
