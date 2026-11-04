/**
 * Issue #902 §6 — nearest-rank percentiles over a set of measurements.
 *
 * Split out of `campaign-delivery-report.ts` for the same reason
 * `delivery-health.ts` was: the reporting modules own database reads, the
 * Superadmin card is a client component, and a trend needs the same arithmetic
 * per bucket. One implementation, importable from both sides.
 *
 * `null` for an empty set rather than zeros: "we measured nothing" and "it took
 * no time" are different statements, and a report that says `0 ms` for "no data"
 * is the kind of number an operator quotes in a meeting.
 */
export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export function latencyStats(values: readonly (number | null | undefined)[]): LatencyStats | null {
  const measured = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (measured.length === 0) return null;
  const at = (percentile: number) => {
    // Nearest-rank: ceil(p/100 × n) − 1, clamped. For a single sample every
    // percentile is that sample, which is the honest reading of one measurement.
    const rank = Math.ceil((percentile / 100) * measured.length);
    return measured[Math.min(measured.length - 1, Math.max(0, rank - 1))];
  };
  return {
    count: measured.length,
    p50: at(50),
    p95: at(95),
    max: measured[measured.length - 1],
  };
}
