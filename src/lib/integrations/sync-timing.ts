/** Old plugins keep their five-minute cadence until actually upgraded. */
export function pluginPullIntervalMs(health: Record<string, unknown> | null | undefined): number {
  return health?.fastIntervalSeconds === 60 ? 60_000 : 300_000;
}

export function pluginSilenceThresholdMs(health: Record<string, unknown> | null | undefined): number {
  return 2 * pluginPullIntervalMs(health);
}
