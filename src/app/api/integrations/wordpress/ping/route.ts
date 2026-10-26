import { NextResponse } from "next/server";
import { pluginRoute } from "@/lib/integrations/plugin-route";
import { pluginSiteMismatch } from "@/lib/integrations/plugin-service";

/**
 * The plugin's «آزمایش اتصال» button, and its liveness beacon.
 *
 * Cheapest possible authenticated call: reaching this handler at all already
 * proves the address is right, the token is right, the clock is within the
 * skew window, and the signature verifies — which is every way this connection
 * can be misconfigured but two. The two it can still answer are named here:
 * the store says which site it is (`siteUrl`), so a token pasted into the wrong
 * WordPress is a 409 `site_mismatch` rather than a green tick, and the reply
 * carries `serverStatus` so a paused connection is told apart from a healthy one.
 *
 * It writes nothing about the site. A ping is a test, and a test that rebinds
 * or flags the connection would make pressing a button change what the next
 * handshake decides; the handshake is the only place that records a mismatch.
 * Authenticating still records `last_plugin_seen_at` and the plugin version.
 */
export const POST = pluginRoute(async (connection, body) => {
  const siteUrl = typeof body.siteUrl === "string" ? body.siteUrl.trim().slice(0, 500) : "";
  const mismatch = siteUrl ? pluginSiteMismatch(connection, siteUrl) : null;
  if (mismatch) {
    return NextResponse.json({ ok: false, error: "site_mismatch", ...mismatch }, { status: 409 });
  }
  return NextResponse.json({
    ok: true,
    connectionId: connection.id,
    name: connection.name,
    status: connection.status,
    serverStatus: connection.status === "paused" ? "paused" : "active",
    serverTime: new Date().toISOString(),
  });
});
