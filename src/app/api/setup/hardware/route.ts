import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { markStepDone } from "@/lib/settings";
import { requireManager } from "@/lib/setup-state";

/**
 * Hardware pairing. The printers themselves are paired through the same routes
 * the Settings → Printers tab uses (/api/settings/printers); there is no second
 * printer configuration path, and the step's UI is that same panel embedded
 * whole. This route's one job is to retire the step once real hardware has been
 * saved.
 *
 * Issue #808: the GET that used to list the branch's printers here had no
 * caller left — the panel loads its own data — so it is gone rather than kept
 * as a second, weaker read path.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;

  let body: { done?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.done !== true) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const progress = await markStepDone(session.businessId, "hardware");
  return NextResponse.json({ ok: true, progress });
});
