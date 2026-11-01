import { pluginRoute } from "@/lib/integrations/plugin-route";
import { pluginHandshake } from "@/lib/integrations/plugin-service";

/**
 * The plugin introduces itself (site URL, version) and is told how this
 * connection is configured — currency unit, which entities to sync, the
 * protocol's own limits. Sent on activation, on settings save, and on every
 * scheduled run, so a toggle flipped in the dashboard reaches WordPress
 * without anyone re-entering anything.
 */
export const POST = pluginRoute(async (connection, body) =>
  pluginHandshake(connection, {
    siteUrl: typeof body.siteUrl === "string" ? body.siteUrl : undefined,
    pluginVersion: typeof body.pluginVersion === "string" ? body.pluginVersion : undefined,
    protocolVersion: typeof body.protocolVersion === "number" ? body.protocolVersion : undefined,
    capabilities:
      body.capabilities && typeof body.capabilities === "object"
        ? (body.capabilities as { eventTypes?: string[]; jobTypes?: string[]; orderStatuses?: unknown })
        : undefined,
    telemetry: body.telemetry && typeof body.telemetry === "object" ? (body.telemetry as Record<string, unknown>) : undefined,
  }),
);
