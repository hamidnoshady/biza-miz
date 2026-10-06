/** SQL paging for authoritative report services, never for caller-supplied SQL.
 * Counts/rollups and the clamped detail page share one PostgreSQL snapshot.
 * PostgreSQL may scan/materialize the source for totals, but at most 50 detail
 * records cross the DB boundary when page is specified. No nested tenant scope.
 */
import { query } from "./db";
import type { ReportDetailPagination } from "./report-detail-page";

export async function queryReportPage<R extends Record<string, unknown>, S = Record<string, never>>(
  source: string, params: unknown[], options: {
    /** Undefined preserves legacy full-list consumers. */
    page?: number;
    /** Trusted service-owned SQL, including a unique tie-breaker. */
    orderBy: string;
    /** One aggregate expression over report_source; defaults to an empty object. */
    summary?: string;
  },
): Promise<{ rows: R[]; total: number; summary: S; pagination: ReportDetailPagination | null }> {
  const requested = Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number.isFinite(options.page) ? options.page! : 1)));
  const limit = params.length + 1;
  const page = params.length + 2;
  const { rows } = await query<R & { _report_total: string; _report_summary: S; _report_present: boolean | null }>(`
    WITH report_source AS MATERIALIZED (${source}),
    report_summary AS (
      SELECT count(*) AS total, ${options.summary ?? "'{}'::jsonb"} AS summary FROM report_source
    )
    SELECT detail.*, stats.total::text AS _report_total, stats.summary AS _report_summary
      FROM report_summary stats
      LEFT JOIN LATERAL (
        SELECT report_source.*, true AS _report_present FROM report_source
        ORDER BY ${options.orderBy}
        LIMIT $${limit}::int
        OFFSET CASE WHEN $${limit}::int IS NULL THEN 0 ELSE
          least($${page}::bigint - 1, greatest(0, (stats.total - 1) / $${limit}::int)) * $${limit}::int END
      ) detail ON true
      ORDER BY ${options.orderBy}`, [...params, options.page === undefined ? null : 50, requested]);
  const total = Number(rows[0]._report_total);
  const pages = Math.max(1, Math.ceil(total / 50));
  return {
    rows: rows.filter((r) => r._report_present).map(({ _report_total, _report_summary, _report_present, ...row }) => row as unknown as R),
    summary: rows[0]._report_summary,
    total,
    pagination: options.page === undefined ? null : { page: Math.min(requested, pages), pageSize: 50, total, pages },
  };
}
