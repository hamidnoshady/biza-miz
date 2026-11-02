/**
 * The service-level half of the "never strand a plugin job" rule.
 *
 * The lease query filters by the job types a plugin advertised, so an outbox
 * row of a type the plugin cannot apply sits `pending` forever. The routes
 * already refuse such a request with a 409 before they queue it, but a route
 * is only one of the producers: the AI autopilot executors, the handshake's
 * first-contact bootstrap and chained syncs enqueue too. The two generic
 * enqueue functions (`enqueuePluginExport`, `enqueueExport`) call this
 * themselves so the rule holds for every caller, not just the ones that
 * remembered it (issue #944 / OVR-08).
 */
import { query } from "../db";
import { pluginSupportsJobType } from "./plugin-capabilities";

/** The stable code routes and executors surface when the plugin cannot apply a job. */
export const PLUGIN_JOB_UNSUPPORTED = "plugin_job_unsupported";

export class PluginJobUnsupportedError extends Error {
  constructor(readonly jobType: string) {
    super(PLUGIN_JOB_UNSUPPORTED);
    this.name = "PluginJobUnsupportedError";
  }
}

export function isPluginJobUnsupportedError(err: unknown): err is PluginJobUnsupportedError {
  return err instanceof PluginJobUnsupportedError;
}

/**
 * Throw `PluginJobUnsupportedError` unless this connection's plugin advertised
 * `jobType` (a plugin that predates capability reporting gets the legacy set —
 * see `pluginAdvertisedJobTypes`). Throws `not_found` for a connection this
 * business does not own, so a wrong id never reaches the INSERT.
 */
export async function assertPluginJobSupported(
  businessId: string,
  connectionId: string,
  jobType: string,
): Promise<void> {
  const { rows } = await query<{ plugin_capabilities: Record<string, unknown> | null }>(
    `SELECT plugin_capabilities FROM integration_connections WHERE id = $1 AND business_id = $2`,
    [connectionId, businessId],
  );
  if (rows.length === 0) throw new Error("not_found");
  if (!pluginSupportsJobType(rows[0].plugin_capabilities, jobType)) {
    throw new PluginJobUnsupportedError(jobType);
  }
}
