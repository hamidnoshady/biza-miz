/** Strict wire validation. Never accept scope, SQL, table names or nested tenant IDs. */
import { z } from "zod";
import { validateReportConfig, type ReportConfig } from "./reports";

export class PlatformReportError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const time = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === s;
});
const range = { dateFrom: date.optional(), dateTo: date.optional() };
const filters = z.object({ ...range, equals: z.record(z.string(), z.string().max(200)).optional() }).strict();
const configSchema = z.object({
  view: z.string().max(100), metric: z.string().max(100), dimension: z.string().max(100),
  aggregation: z.enum(["sum", "avg", "count", "count_distinct"]), filters: filters.optional(),
  sort: z.object({ by: z.enum(["dimension", "metric"]), dir: z.enum(["asc", "desc"]) }).strict().optional(),
  limit: z.number().int().min(1).max(1000).default(1000),
}).strict();
const optionsSchema = z.object({
  ...range, locationId: z.string().uuid().optional(), compare: z.enum(["0", "1"]).optional(),
  previousAsOfDate: date.optional(),
  page: z.string().regex(/^[1-9]\d{0,5}$/).transform(Number).optional(),
}).strict();
export function parseReportOptions(params: URLSearchParams) {
  const parsed = optionsSchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) throw new PlatformReportError("invalid_filters");
  const { compare, ...options } = parsed.data;
  if (options.dateFrom && options.dateTo && options.dateFrom > options.dateTo)
    throw new PlatformReportError("invalid_date_range");
  if (options.previousAsOfDate && options.dateTo && options.previousAsOfDate >= options.dateTo)
    throw new PlatformReportError("invalid_comparison_date");
  return { ...options, compare: compare === "1" };
}
export function parseReportQuery(body: unknown): ReportConfig {
  const result = configSchema.safeParse(body);
  if (!result.success) throw new PlatformReportError("invalid_config");
  const config = result.data as ReportConfig;
  // Object prototype names must not resolve as whitelist entries.
  if (validateReportConfig(config).length) throw new PlatformReportError("invalid_config");
  return config;
}
export type PlatformReportOptions = ReturnType<typeof parseReportOptions>;
