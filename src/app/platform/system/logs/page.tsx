"use client";

/**
 * «پایش» — the OpenObserve tab of the system section.
 *
 * Two states. Unconfigured: a setup guide, because a half-wired collector is
 * worse than an absent one — the panel tells you exactly which env vars and
 * the compose file to run. Configured: a live tail of the platform's own
 * log stream — level chips with counts, substring search, time range,
 * auto-refresh, and expandable raw records — backed by `/api/platform/
 * observability`, which proxies the collector server-side so credentials
 * never reach the browser. Deep triage (SQL, dashboards, alerts) stays in
 * the OpenObserve UI itself, one click away; this tab is the "is anything
 * on fire, right now?" surface — and unlike «سلامت», it sees every host
 * shipping logs, not just the one answering this page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ExternalLink,
  Pause,
  Play,
  RefreshCw,
  Search,
  TriangleAlert,
} from "lucide-react";
import { toPersianDigits, formatPersianNumber } from "@/lib/digits";
import {
  api,
  errorMessage,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  InfoBox,
  SkeletonRows,
  inputClass,
  fmtDate,
} from "../../ui";

interface ConfigView {
  enabled?: boolean;
  org?: string;
  stream?: string;
  service?: string;
  environment?: string;
  publicUrl?: string;
  shipper?: { enqueued: number; sent: number; dropped: number; lastFlushAt: string | null; lastError: string | null };
  error?: string;
}

interface HealthView {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

interface LogRow {
  _timestamp?: number;
  level?: string;
  message?: string;
  service?: string;
  environment?: string;
  logger?: string;
  host?: string;
  [k: string]: unknown;
}

interface StatsView {
  counts?: { level: string; cnt: number }[];
  error?: string;
}

const RANGES = [
  { label: "۱۵ دقیقه", ms: 15 * 60_000 },
  { label: "۱ ساعت", ms: 60 * 60_000 },
  { label: "۶ ساعت", ms: 6 * 60 * 60_000 },
  { label: "۲۴ ساعت", ms: 24 * 60 * 60_000 },
  { label: "۷ روز", ms: 7 * 24 * 60 * 60_000 },
];

const LEVELS = [
  { value: "all", label: "همه" },
  { value: "error", label: "خطا" },
  { value: "warn", label: "هشدار" },
  { value: "info", label: "اطلاعات" },
];

const PAGE_SIZE = 50;
const AUTO_MS = 15_000;

function levelCls(level: string): string {
  switch (level) {
    case "error":
    case "fatal":
      return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
    case "warn":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "info":
      return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

export default function ObservabilityPage() {
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [health, setHealth] = useState<HealthView | null>(null);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [level, setLevel] = useState("all");
  const [rangeIdx, setRangeIdx] = useState(2);
  const [auto, setAuto] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const requestSeq = useRef(0);

  useEffect(() => {
    (async () => {
      const { data } = await api<ConfigView>("/api/platform/observability?mode=config");
      setConfig(data);
      setLoading(false);
    })();
  }, []);

  const enabled = Boolean(config?.enabled);

  const load = useCallback(async () => {
    if (!enabled) return;
    const seq = ++requestSeq.current;
    const end = Date.now();
    const start = end - RANGES[rangeIdx].ms;
    const params = new URLSearchParams({
      start: String(start),
      end: String(end),
      level,
      size: String(PAGE_SIZE),
    });
    if (q.trim()) params.set("q", q.trim());

    const [logsRes, statsRes, healthRes] = await Promise.all([
      api<{ rows?: LogRow[]; error?: string }>(`/api/platform/observability?mode=logs&${params}`),
      api<StatsView>(`/api/platform/observability?mode=stats&${params}`),
      api<HealthView>(`/api/platform/observability?mode=health`),
    ]);
    if (seq !== requestSeq.current) return; // a newer refresh won

    if (logsRes.ok && logsRes.data.rows) {
      setRows(logsRes.data.rows);
      setCounts(
        Object.fromEntries((statsRes.data.counts ?? []).map((c) => [c.level, c.cnt])),
      );
      setHealth(healthRes.ok ? healthRes.data : null);
      setError(logsRes.data.error ? errorMessage(logsRes.data.error) : null);
      setStale(false);
    } else if (rows.length > 0) {
      // Keep showing the last good window, flagged — a blipping collector
      // should never blank the operator's view mid-incident.
      setStale(true);
      setError(errorMessage(logsRes.data?.error ?? "observability_unreachable"));
    } else {
      setError(errorMessage(logsRes.data?.error ?? "observability_unreachable"));
      setHealth(healthRes.ok ? healthRes.data : null);
    }
  }, [enabled, rangeIdx, level, q, rows.length]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    if (!auto) return;
    const t = setInterval(() => void load(), AUTO_MS);
    return () => clearInterval(t);
  }, [enabled, auto, load]);

  const hasMore = rows.length >= PAGE_SIZE;

  function loadMore() {
    if (!enabled || !hasMore) return;
    const end = Date.now();
    const start = end - RANGES[rangeIdx].ms;
    const params = new URLSearchParams({
      start: String(start),
      end: String(end),
      level,
      size: String(PAGE_SIZE),
      from: String(rows.length),
    });
    if (q.trim()) params.set("q", q.trim());
    void (async () => {
      const { ok, data } = await api<{ rows?: LogRow[] }>(`/api/platform/observability?mode=logs&${params}`);
      if (ok && data.rows && data.rows.length > 0) {
        // Offset paging over a live tail can re-serve a row that arrived
        // between refreshes — dedupe by (timestamp, message), not identity,
        // since JSON rows are fresh objects on every fetch.
        const key = (r: LogRow) => `${r._timestamp ?? ""}|${String(r.message ?? "")}`;
        setRows((cur) => {
          const seen = new Set(cur.map(key));
          return [...cur, ...data.rows!.filter((r) => !seen.has(key(r)))];
        });
      }
    })();
  }

  const errorCount = (counts.error ?? 0) + (counts.fatal ?? 0);

  const exportCsv = useMemo(
    () => () => {
      if (rows.length === 0) return;
      const head = ["time", "level", "service", "logger", "message"];
      const lines = rows.map((r) =>
        [
          new Date(Math.round(Number(r._timestamp ?? 0) / 1000)).toISOString(),
          String(r.level ?? ""),
          String(r.service ?? ""),
          String(r.logger ?? ""),
          String(r.message ?? "").replace(/\s+/g, " "),
        ]
          .map((c) => `"${c.replaceAll('"', '""')}"`)
          .join(","),
      );
      const blob = new Blob(["\ufeff" + [head.join(","), ...lines].join("\n")], {
        type: "text/csv;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pos-logs-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    },
    [rows],
  );

  if (loading) return <SkeletonRows rows={4} />;

  if (!enabled) return <SetupGuide />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">پایش و لاگ‌ها</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            استریم <code dir="ltr" className="text-muted-foreground">{config?.stream}</code> از سرویس{" "}
            <code dir="ltr" className="text-muted-foreground">{config?.service}</code>؛ خطاهای همهٔ
            نصب‌هایی که به این کلکتور لاگ می‌فرستند، یک‌جا.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {health ? (
            <span
              className={
                health.ok
                  ? "inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-700 dark:text-emerald-300"
                  : "inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs text-red-700 dark:text-red-300"
              }
            >
              <span className={`h-1.5 w-1.5 rounded-full ${health.ok ? "bg-emerald-400" : "bg-red-400"}`} />
              {health.ok ? `کلکتور سالم · ${toPersianDigits(health.latencyMs)}ms` : "کلکتور در دسترس نیست"}
            </span>
          ) : null}
          {config?.publicUrl ? (
            <a
              href={config.publicUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs text-foreground transition-colors hover:bg-muted"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              داشبورد کامل
            </a>
          ) : null}
        </div>
      </div>

      {stale ? <InfoBox>ارتباط لحظه‌ای با کلکتور قطع بود؛ آخرین دادهٔ موفق نمایش داده می‌شود.</InfoBox> : null}
      <ErrorBox>{error}</ErrorBox>
      {config?.shipper && config.shipper.dropped > 0 ? (
        <InfoBox>
          {formatPersianNumber(config.shipper.dropped)} رویداد لاگ هنگام قطعی کلکتور حذف شد
          (ارسال‌شده: {formatPersianNumber(config.shipper.sent)}).
        </InfoBox>
      ) : null}

      <Card>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className={`${inputClass} ps-9`}
              placeholder="جستجو در پیام لاگ‌ها…"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {RANGES.map((r, i) => (
              <button
                key={r.label}
                type="button"
                onClick={() => setRangeIdx(i)}
                className={
                  rangeIdx === i
                    ? "rounded-full border border-sky-400/50 bg-sky-500/15 px-3 py-1 text-xs font-medium text-sky-700 dark:text-sky-300"
                    : "rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                }
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {LEVELS.map((l) => {
            const n = l.value === "all" ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[l.value] ?? (l.value === "error" ? errorCount : 0);
            const activeChip = level === l.value;
            return (
              <button
                key={l.value}
                type="button"
                onClick={() => setLevel(l.value)}
                className={
                  activeChip
                    ? "rounded-full border border-sky-400/50 bg-sky-500/15 px-3 py-1 text-xs font-medium text-sky-700 dark:text-sky-300"
                    : "rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                }
              >
                {l.label}
                <span className="ms-1.5 tabular-nums text-muted-foreground">{toPersianDigits(n)}</span>
              </button>
            );
          })}
          <span className="ms-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setAuto((v) => !v)}
              title={auto ? "توقف تازه‌سازی خودکار" : "شروع تازه‌سازی خودکار (هر ۱۵ ثانیه)"}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-foreground hover:bg-muted"
            >
              {auto ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {auto ? "خودکار" : "متوقف"}
            </button>
            <Button variant="ghost" onClick={() => void load()} className="!h-8 text-xs">
              <RefreshCw className="ms-1 inline h-3.5 w-3.5" />
              تازه‌سازی
            </Button>
            <Button variant="ghost" onClick={exportCsv} className="!h-8 text-xs">
              خروجی CSV
            </Button>
          </span>
        </div>
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          title={error ? "نمایش لاگ‌ها ممکن نشد." : "لاگی در این بازه نیست."}
          hint={
            error
              ? undefined
              : `اگر همین حالا سروری روشن است، رویداد راه‌اندازی و هر خطای بعدی اینجا دیده می‌شود. فیلترها را شل کنید یا بازه را بزرگ‌تر کنید.`
          }
        />
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {rows.map((r, idx) => {
              const lvl = String(r.level ?? "info");
              const open = expanded.has(idx);
              const ts = r._timestamp ? Math.round(Number(r._timestamp) / 1000) : null;
              return (
                <li key={idx} className="py-2.5 first:pt-0 last:pb-0">
                  <button
                    type="button"
                    className="flex w-full items-start gap-3 text-start"
                    onClick={() =>
                      setExpanded((cur) => {
                        const next = new Set(cur);
                        if (next.has(idx)) next.delete(idx);
                        else next.add(idx);
                        return next;
                      })
                    }
                    aria-expanded={open}
                  >
                    <span className={`mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${levelCls(lvl)}`}>
                      {lvl}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
                        {String(r.message ?? "")}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                        {ts ? <span className="tabular-nums">{fmtDate(new Date(ts).toISOString())}</span> : null}
                        {r.logger ? <span dir="ltr">{String(r.logger)}</span> : null}
                        {r.host ? <span dir="ltr">{String(r.host)}</span> : null}
                        {r.status !== undefined ? (
                          <span dir="ltr">
                            {String(r.method ?? "")} → {String(r.status)} ({formatPersianNumber(Number(r.duration_ms ?? 0))}ms)
                          </span>
                        ) : null}
                        {r.service ? <span dir="ltr">{String(r.service)}</span> : null}
                      </span>
                    </span>
                  </button>
                  {open ? (
                    <pre
                      dir="ltr"
                      className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-muted p-3 text-start text-[11px] leading-5 text-muted-foreground"
                    >
                      {JSON.stringify(r, null, 2)}
                    </pre>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {hasMore ? (
            <div className="mt-3 flex justify-center">
              <Button variant="ghost" onClick={loadMore} className="text-xs">
                نمایش {toPersianDigits(PAGE_SIZE)} مورد قدیمی‌تر
              </Button>
            </div>
          ) : null}
        </Card>
      )}
    </div>
  );
}

/** Shown when the collector is not wired — turns a dead tab into a to-do. */
function SetupGuide() {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">پایش و لاگ‌ها</h2>
      <Card title="پایش هنوز تنظیم نشده است">
        <p className="mb-4 text-sm leading-7 text-muted-foreground">
          این تب به یک نمونهٔ <a href="https://openobserve.ai" target="_blank" rel="noreferrer" className="text-sky-700 dark:text-sky-300 hover:underline">OpenObserve</a>{" "}
          وصل می‌شود و لاگ خطاها، درخواست‌های کند/ناموفق و پیام‌های همهٔ سرورهای متصل را یک‌جا نشان می‌دهد.
          راه‌اندازی‌اش یک سرویس اضافه روی همان داکر-کامپوز است:
        </p>
        <ol className="list-inside list-decimal space-y-2 text-sm leading-7 text-foreground">
          <li>
            در سرور مرکزی، استک را با فایل اضافه بالا بیاورید:{" "}
            <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5 text-xs">
              docker compose -f archive/deploy/docker-compose.komodo.yml -f archive/deploy/docker-compose.observability.yml up -d
            </code>
          </li>
          <li>
            در <code dir="ltr" className="text-xs">.env</code> کامپوز، نام‌کاربری/رمز ریشه را ست کنید:{" "}
            <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5 text-xs">
              OPENOBSERVE_ROOT_EMAIL / OPENOBSERVE_ROOT_PASSWORD
            </code>
          </li>
          <li>
            اپ (و هر نصب ساحه‌ای که می‌خواهید لاگ بفرستد) باید این‌ها را ببیند:{" "}
            <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5 text-xs">
              OPENOBSERVE_URL, OPENOBSERVE_USER, OPENOBSERVE_PASSWORD
            </code>{" "}
            — بقیه اختیاری است. فایل کامپوز این‌ها را خودکار تزریق می‌کند.
          </li>
          <li>
            راهنمای کامل، هشدارها و پاک‌سازی خودکار لاگ‌ها:{" "}
            <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5 text-xs">
              docs/deployment/openobserve.md
            </code>
          </li>
        </ol>
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-card p-3 text-xs leading-6 text-muted-foreground">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700/80 dark:text-amber-300/80" />
          تا پیش از تنظیم، سلامت دیتابیس (تب «سلامت») همچنان کامل کار می‌کند؛ این تب فقط نمای لاگ‌ها را اضافه می‌کند.
        </div>
      </Card>
    </div>
  );
}
