import { NextRequest, NextResponse } from "next/server";
import { authenticateIamSite } from "@/lib/iam/site-auth";
import { buildLoginCredentials } from "@/lib/iam/login-credentials-service";

/** Global login: the password + second factor a paired site replicates (src/lib/iam/login-credentials.ts). */
export async function GET(request: NextRequest) {
  const site = await authenticateIamSite(request);
  if (!site) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const response = NextResponse.json({ credentials: await buildLoginCredentials(site.businessId) });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
