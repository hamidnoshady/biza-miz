import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "./platform-auth";
import { withBusinessReporting, platformReportSection, platformStandardReport, platformCustomReport } from "./platform-business-reporting";
import { parseReportOptions, parseReportQuery, PlatformReportError } from "./platform-report-request";

type Params = { id: string; section?: string; key?: string };
/** One authoritative guard for every read surface (POST is a read-only query). */
export function platformReportRoute(kind: "section" | "standard" | "query") {
  return withPlatformScope(async (request: NextRequest, ctx: { params: Promise<Params> }) => {
    const guard = await requirePlatformCapability("business.reports.read");
    const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
    if (guard.error) { guard.error.headers.set("Cache-Control", headers["Cache-Control"]); return guard.error; }
    try {
      const params = await ctx.params;
      const options = parseReportOptions(request.nextUrl.searchParams);
      let body: unknown;
      if (kind === "query") {
        const text = await request.text();
        if (text.length > 16_384) throw new PlatformReportError("query_too_large", 413);
        try { body = JSON.parse(text); } catch { throw new PlatformReportError("invalid_config"); }
      }
      const data = await withBusinessReporting<unknown>(params.id, options, (context) => {
        if (kind === "query") return platformCustomReport(context, parseReportQuery(body));
        if (kind === "standard") return platformStandardReport(context, params.key ?? "");
        return platformReportSection(context, params.section ?? "");
      });
      return NextResponse.json(data, { headers });
    } catch (error) {
      const known = error instanceof PlatformReportError;
      if (!known) console.error("platform report failed", { kind });
      return NextResponse.json({ error: known ? error.message : "report_unavailable" }, { status: known ? error.status : 500, headers });
    }
  });
}
