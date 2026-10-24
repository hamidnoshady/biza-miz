"use client";

/**
 * «سایت‌ساز ← پایش» — the website platform's log tail.
 *
 * Same collector, same proxy, same capability as «سیستم ← پایش»; only the stream
 * differs (`?source=cms`). Two producers fill it: every control call this console
 * makes (latency and outcome, from `src/lib/cms/platform-client.ts`) and the CMS's
 * own event feed, polled on a cursor by the tick. That is what makes a second
 * deployment observable without putting a collector credential on it.
 *
 * The browser never talks to the collector — the query goes through
 * `/api/platform/observability`, which is session- and `system.read`-gated.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Pause, Play, RefreshCw, Search } from "lucide-react";

import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import {
  api,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  fmtDate,
  InfoBox,
  inputClass,
  SkeletonRows,
} from "../../ui";

interface ConfigView {
  enabled?: boolean;
  org?: string;
  publicUrl?: string;
  shipper?: { dropped: number; enqueued: number; lastError: null | string; sent: number };
  source?: string;
  stream?: string;
}

interface LogRow {
  _timestamp?: number;
  cms_event_id?: string;
  cms_kind?: string;
  cms_operation?: string;
  cms_outcome?: string;
  cms_site_domain?: string;
  duration_ms?: number;
  level?: string;
  logger?: string;
  message?: string;
  site_id?: string;
  source_at?: string;
  [key: string]: unknown;
}

const RANGES = [
  { label: "۱ ساعت", ms: 60 * 60_000 },
  { label: "۶ ساعت", ms: 6 * 60 * 60_000 },
  { label: "۲۴ ساعت", ms: 24 * 60 * 60_000 },
  { label: "۷ روز", ms: 7 * 24 * 60 * 60_000 },
];

const LEVELS = [
  { label: "همه", value: "all" },
  { label: "خطا", value: "error" },
  { label: "هشدار", value: "warn" },
  { label: "اطلاعات", value: "info" },
];

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

export default function CmsLogsPage() {
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<null | string>(null);
  const [q, setQ] = useState("");
  const [level, setLevel] = useState("all");
  const [rangeIdx, setRangeIdx] = useState(2);
  const [auto, setAuto] = useState(true);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const end = Date.now();
    const start = end - RANGES[rangeIdx].ms;
    const params = new URLSearchParams({
      end: String(end),
      level,
      size: "80",
      source: "cms",
      start: String(start),
    });
    if (q.trim()) params.set("q", q.trim());

    const [cfg, logs, stats] = await Promise.all([
      api<ConfigView>("/api/platform/observability?mode=config&source=cms"),
      api<{ error?: string; rows?: LogRow[] }>(
        `/api/platform/observability?mode=logs&${params.toString()}`,
      ),
      api<{ counts?: { cnt: number; level: string }[] }>(
        `/api/platform/observability?mode=stats&${params.toString()}`,
      ),
    ]);
    if (mine !== seq.current) return;

    setConfig(cfg.data);
    if (cfg.data.enabled === false) {
      setLoading(false);
      return;
    }
    if (!logs.ok) setError("خواندن پایش ممکن نشد؛ جمع‌کنندهٔ لاگ در دسترس نیست.");
    else setError(null);
    setRows(logs.data.rows ?? []);
    setCounts(
      Object.fromEntries((stats.data.counts ?? []).map((row) => [row.level, row.cnt])),
    );
    setLoading(false);
  }, [level, q, rangeIdx]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => void load(), 20_000);
    return () => clearInterval(id);
  }, [auto, load]);

  const total = useMemo(
    () => Object.values(counts).reduce((sum, count) => sum + count, 0),
    [counts],
  );

  if (loading) return <SkeletonRows label="در حال خواندن پایش سایت‌ساز" rows={8} />;

  if (config?.enabled === false) {
    // Shipper counters survive a missing collector (audit F23): when events were
    // produced but could not be stored, say so — "not configured" alone hides
    // that the site is generating logs that go nowhere. Counters are process-local
    // and are not proof of current shipping, so they are labelled as such.
    const shipper = config.shipper;
    const produced = (shipper?.enqueued ?? 0) > 0 || (shipper?.dropped ?? 0) > 0;
    return (
      <div className="space-y-4">
        <EmptyState
          hint="متغیرهای OPENOBSERVE_URL و اعتبارنامه‌های آن روی این سرور تنظیم نشده‌اند. راهنمای نصب در docs/deployment/openobserve.md است؛ تا آن زمان رویدادهای سایت‌ساز جایی ذخیره نمی‌شوند."
          title={
            produced
              ? "ارسال رویداد فعال است اما جمع‌کننده در دسترس نیست"
              : "جمع‌کنندهٔ لاگ پیکربندی نشده است"
          }
        />
        {produced ? (
          <div className="rounded-xl border border-amber-400/50 bg-amber-500/10 p-3 text-sm">
            <p>
              از آخرین راه‌اندازی این فرایند: {formatPersianNumber(shipper?.enqueued ?? 0)} رویداد صف شده،{" "}
              {formatPersianNumber(shipper?.dropped ?? 0)} رویداد حذف شده، {formatPersianNumber(shipper?.sent ?? 0)} رویداد ارسال شده.
            </p>
            {shipper?.lastError ? (
              <p className="mt-1 text-xs text-muted-foreground">آخرین خطا: {shipper.lastError}</p>
            ) : null}
            <p className="mt-1 text-xs text-muted-foreground">
              این شمارش‌ها مربوط به همین فرایند است و نشان نمی‌دهد ارسال هم‌اکنون برقرار است.
            </p>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute inset-y-0 my-auto ms-3 size-4 text-muted-foreground" />
          <input
            className={`${inputClass} ps-9`}
            onChange={(event) => setQ(event.target.value)}
            placeholder="جست‌وجو در پیام‌ها"
            value={q}
          />
        </div>
        <div className="flex gap-1">
          {LEVELS.map((item) => (
            <button
              className={
                level === item.value
                  ? "rounded-lg bg-sky-500/15 px-3 py-2 text-sm font-medium text-sky-700 dark:text-sky-300"
                  : "rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted"
              }
              key={item.value}
              onClick={() => setLevel(item.value)}
              type="button"
            >
              {item.label}
              {counts[item.value] ? (
                <span className="ms-1 tabular-nums text-xs">
                  {formatPersianNumber(counts[item.value])}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {RANGES.map((range, index) => (
            <button
              className={
                rangeIdx === index
                  ? "rounded-lg bg-muted px-2.5 py-2 text-xs font-medium text-foreground"
                  : "rounded-lg px-2.5 py-2 text-xs text-muted-foreground hover:bg-muted"
              }
              key={range.label}
              onClick={() => setRangeIdx(index)}
              type="button"
            >
              {range.label}
            </button>
          ))}
        </div>
        <Button onClick={() => setAuto((value) => !value)} variant="ghost">
          {auto ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>
        <Button onClick={() => void load()} variant="ghost">
          <RefreshCw className="size-4" />
        </Button>
      </div>

      <InfoBox>
        جریان «{config?.stream}» — {formatPersianNumber(total)} رکورد در این بازه. رکوردها از دو
        منبع می‌آیند: تماس‌های این کنسول با سایت‌ساز، و خوراک رویدادهای خودِ سایت‌ساز.
        {config?.publicUrl ? (
          <a
            className="ms-2 inline-flex items-center gap-1 text-sky-700 dark:text-sky-300 hover:underline"
            href={config.publicUrl}
            rel="noreferrer"
            target="_blank"
          >
            باز کردن OpenObserve
            <ExternalLink className="size-3" />
          </a>
        ) : null}
      </InfoBox>

      {rows.length === 0 ? (
        <EmptyState
          hint="اگر «ارسال رویدادها به پایش» در بخش اتصال خاموش است، آن را روشن کنید یا از «همگام‌سازی» یک دریافت دستی بزنید."
          title="در این بازه رکوردی نیست"
        />
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {rows.map((row, index) => (
              <li className="py-2" key={`${row.cms_event_id ?? index}-${row._timestamp ?? index}`}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[11px] ${levelCls(String(row.level ?? "info"))}`}
                  >
                    {String(row.level ?? "info")}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {row._timestamp
                      ? fmtDate(new Date(Math.floor(Number(row._timestamp) / 1000)).toISOString())
                      : row.source_at
                        ? fmtDate(row.source_at)
                        : "—"}
                  </span>
                  {row.cms_site_domain ? (
                    <span className="text-xs text-muted-foreground" dir="ltr">
                      {row.cms_site_domain}
                    </span>
                  ) : null}
                  {row.cms_kind ? (
                    <span className="text-xs text-muted-foreground">{row.cms_kind}</span>
                  ) : null}
                  {row.cms_operation ? (
                    <span className="text-xs text-muted-foreground">{row.cms_operation}</span>
                  ) : null}
                  {row.duration_ms !== undefined ? (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {toPersianDigits(Number(row.duration_ms))}‏ms
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 break-words text-sm text-foreground">{String(row.message ?? "")}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
