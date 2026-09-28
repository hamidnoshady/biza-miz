import { NextRequest, NextResponse } from "next/server";
import { authenticateIamSite } from "@/lib/iam/site-auth";
import { listIamEvents } from "@/lib/iam/service";

export async function GET(request: NextRequest) {
  const site = await authenticateIamSite(request);
  if (!site) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const after = Number(request.nextUrl.searchParams.get("after") ?? "0");
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? "100");
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const events = await listIamEvents(site.businessId, after, limit);
  return NextResponse.json({ events, after, lastSequence: events.at(-1)?.sequence ?? after });
}
