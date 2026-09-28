import { NextRequest, NextResponse } from "next/server";
import { authenticateIamSite } from "@/lib/iam/site-auth";
import { buildIamSnapshot } from "@/lib/iam/service";

export async function GET(request: NextRequest) {
  const site = await authenticateIamSite(request);
  if (!site) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const snapshot = await buildIamSnapshot(site.businessId, site.siteDeviceId);
  return NextResponse.json({ snapshot });
}
