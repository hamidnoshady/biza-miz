/** Page detail collections without changing a structured report's rollups. */
export interface ReportDetailPagination { page: number; pageSize: number; total: number; pages: number }
export function pageReportDetails<T extends Record<string, unknown>>(report: T, page = 1) {
  const key = ["rows", "summaries", "items"].find((key) => Array.isArray(report[key]));
  if (!key) return { report, pagination: null };
  const rows = report[key] as unknown[];
  const pages = Math.max(1, Math.ceil(rows.length / 50));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const pagination: ReportDetailPagination = { page: current, pageSize: 50, total: rows.length, pages };
  return { report: { ...report, [key]: rows.slice((current - 1) * 50, current * 50) }, pagination };
}
