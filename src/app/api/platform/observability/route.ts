import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  buildLevelCountQuery,
  buildLogQuery,
  clampWindow,
  observabilityConfig,
  shipperStats,
  zoHealth,
  zoSearch,
  zoStreams,
} from "@/lib/observability";
import { cmsLogStream } from "@/lib/cms/observability";

/**
 * The console's window into OpenObserve — read-only, capability-gated.
 *
 * The panel deliberately does not talk to the collector from the browser:
 * the query proxy lives here so platform credentials (OPENOBSERVE_USER /
 * _PASSWORD) never leave the server, and so every probe of the log store
 * rides the same `system.read` capability as the system page itself.
 *
 * `?mode=` selects the view:
 *   config  — what is wired up (never the secret itself) + shipper counters
 *   health  — liveness probe of the collector, in ms
 *   streams — log streams present (so the panel can warn when its own stream
 *             has never received data)
 *   stats   — row counts grouped by level for the toolbar chips
 *   logs    — the newest rows matching {start,end,level,q,host,from,size}
 *
 * `?source=cms` selects the website platform's stream instead of this app's own
 * (`OPENOBSERVE_CMS_STREAM`, default `cms_events` — see
 * `src/lib/cms/observability.ts` for why they are deliberately two streams). Both
 * sources share this one proxy rather than growing a second: the credential, the
 * capability gate, the window clamp and the level vocabulary are identical, and a
 * parallel route is how those four drift apart.
 *
 * Times are epoch milliseconds; the search window is clamped to 31 days
 * (docs/deployment/openobserve.md explains why the fleet caps it that low).
 */
const LOG_LEVELS = new Set(["all", "error", "warn", "info", "debug", "fatal"]);

function bad(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformCapability("system.read");
  if (error) return error;

  const cfg = observabilityConfig();
  const mode = request.nextUrl.searchParams.get("mode") ?? "config";
  const source = request.nextUrl.searchParams.get("source") === "cms" ? "cms" : "app";
  if (!cfg) {
    // `config` answers honestly even when disabled so the UI can render its
    // setup guide; every other mode needs a collector to talk to.
    return mode === "config"
      ? NextResponse.json({ enabled: false, shipper: shipperStats() })
      : bad("observability_not_configured", 503);
  }

  const startMs = Number(request.nextUrl.searchParams.get("start"));
  const endMs = Number(request.nextUrl.searchParams.get("end"));
  const now = Date.now();

  const stream = source === "cms" ? cmsLogStream() : cfg.stream;

  if (mode === "config") {
    return NextResponse.json({
      enabled: true,
      org: cfg.org,
      source,
      stream,
      service: cfg.service,
      environment: cfg.environment,
      publicUrl: cfg.publicUrl,
      shipper: shipperStats(),
    });
  }

  if (mode === "health") {
    return NextResponse.json(await zoHealth(cfg));
  }

  try {
    if (mode === "streams") {
      return NextResponse.json({ streams: await zoStreams(cfg) });
    }

    const level = request.nextUrl.searchParams.get("level") ?? "all";
    if (!LOG_LEVELS.has(level)) return bad("invalid_level");
    const q = (request.nextUrl.searchParams.get("q") ?? "").slice(0, 120);
    const host = (request.nextUrl.searchParams.get("host") ?? "").slice(0, 200);
    const filters = { stream, level, q: q || undefined, host: host || undefined };

    if (mode === "stats") {
      const win = clampWindow(startMs, endMs, now);
      const { rows } = await zoSearch(cfg, buildLevelCountQuery(filters), win.startMs, win.endMs, 20, 0);
      const counts = rows
        .map((r) => ({ level: String(r.level ?? "info"), cnt: Number(r.cnt ?? 0) }))
        .filter((c) => Number.isFinite(c.cnt));
      return NextResponse.json({ counts });
    }

    if (mode === "logs") {
      const size = Math.min(Math.max(Number(request.nextUrl.searchParams.get("size")) || 50, 1), 500);
      const from = Math.max(Number(request.nextUrl.searchParams.get("from")) || 0, 0);
      const win = clampWindow(startMs, endMs, now);
      const { rows, tookMs } = await zoSearch(
        cfg,
        buildLogQuery(filters),
        win.startMs,
        win.endMs,
        size,
        from,
      );
      return NextResponse.json({ rows, tookMs, from, size });
    }

    return bad("bad_request");
  } catch (err) {
    // Collector unreachable / query rejected: the panel shows "پایش در دسترس نیست"
    // and keeps its last good data, exactly like the system page does for its
    // own sections.
    void err;
    return bad("observability_unreachable", 502);
  }
});
