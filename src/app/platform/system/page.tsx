"use client";

/**
 * Phase 15 — the system health dashboard.
 *
 * Migration status, the live connection-pool figures, whether RLS is actually
 * being enforced, the most recent backup per business, and platform-wide
 * counts. Read-only — this is a dashboard, not a control surface: nothing on
 * this page applies a migration or clears a credential, and nothing here should
 * ever grow such a button.
 *
 * The migration block is driven by the canonical `MigrationStatus` from
 * `/api/platform/system` (see `src/lib/migration-status-service.ts`), not by a
 * bare pending count. That distinction is the whole point of the screen:
 *
 *   • an **ordinary** pending migration is the old schema-mismatch warning —
 *     "the running code is ahead of the database, run npm run db:migrate";
 *   • the **gated** `0209_ai_gateway_secret_cutover.sql` is a deliberate hold.
 *     It is reported as "legacy AI secret cleanup awaits verified completion",
 *     because a bare `npm run db:migrate` defers it again and the real next step
 *     is the operator verification sequence in `migration-status-labels.ts`;
 *   • an **unreadable** inventory is reported as unknown, never as zero pending.
 *
 * A mixed deployment shows both categories separately rather than summing them
 * into one misleading number.
 *
 * The endpoint answers `{ status: … }` (see /api/platform/system) — the page
 * used to treat the whole body as the status object, which crashed every
 * render. It now unwraps correctly and every block degrades to "—" instead of
 * throwing when a field is missing, so one dead sub-query can never take the
 * whole dashboard down again.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Copy,
  Database,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  TriangleAlert,
  CircleAlert,
  CircleCheck,
  HelpCircle,
  KeyRound,
} from "lucide-react";
import { formatPersianNumber } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  AI_SECRET_CUTOVER_COMMANDS,
  AI_SECRET_CUTOVER_MIGRATE_COMMAND,
  MIGRATE_COMMAND,
  migrationHeadline,
  migrationReasonLabel,
  migrationStateLabel,
} from "@/lib/migration-status-labels";
import type { MigrationEntry, MigrationStatus } from "@/lib/migration-status-service";
import { api, errorMessage, ErrorBox, Card, StatCard, InfoBox, fmtDate, SkeletonRows } from "../ui";

interface SystemStatus {
  migrations?: { filename: string; appliedAt: string }[];
  pendingMigrations?: number | null;
  migrationStatus?: MigrationStatus;
  pool?: { total: number; idle: number; waiting: number };
  rlsEffective?: boolean;
  backups?: { businessId: string; businessName: string; status: string; ranAt: string | null }[];
  platformBackup?: {
    status: string;
    ranAt: string | null;
    alert: string;
    alertLevel: "ok" | "warning" | "error";
    artifacts: number;
    servingEnabled: boolean;
  } | null;
  counts?: { businesses: number; platformUsers: number; platformAdmins: number };
}

const AUTO_REFRESH_MS = 60_000;

/** The platform backup's alert reasons, in the same words the backup page uses. */
const PLATFORM_BACKUP_ALERT_LABELS: Record<string, string> = {
  ok: "سالم",
  disabled: "خاموش",
  local_failed: "ناموفق",
  local_stale: "کهنه",
  cloud_failed: "ابر ناموفق",
  cloud_stale: "ابر کهنه",
};
const MIGRATIONS_PREVIEW = 8;

/** Tone → the console's own token pair, so the block flips with the theme. */
const TONE_CLASS: Record<string, { box: string; icon: string }> = {
  ok: {
    box: "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
    icon: "text-emerald-700 dark:text-emerald-300",
  },
  warn: {
    box: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200",
    icon: "text-amber-700 dark:text-amber-300",
  },
  bad: {
    box: "border-red-500/30 bg-red-500/10 text-red-800 dark:text-red-200",
    icon: "text-red-700 dark:text-red-300",
  },
  unknown: {
    box: "border-border bg-muted/60 text-foreground",
    icon: "text-muted-foreground",
  },
};

function toneIcon(tone: string) {
  if (tone === "ok") return <CircleCheck className="h-4 w-4" />;
  if (tone === "bad") return <CircleAlert className="h-4 w-4" />;
  if (tone === "unknown") return <HelpCircle className="h-4 w-4" />;
  return <TriangleAlert className="h-4 w-4" />;
}

export default function SystemPage() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [showAllMigrations, setShowAllMigrations] = useState(false);
  const [copied, setCopied] = useState(false);
  // Monotonic request id: a slow refresh that resolves after a newer one must
  // never overwrite the newer result on screen. The interval and the manual
  // «تازه‌سازی» button can overlap, and without this the dashboard could show
  // an older migration status than the one it just fetched.
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const { ok, data } = await api<{ status?: SystemStatus; error?: string }>(
      "/api/platform/system",
    );
    if (requestId !== requestIdRef.current) return;
    if (ok && data.status) {
      setStatus(data.status);
      setLoadedAt(new Date().toISOString());
      setError(null);
    } else {
      setError(errorMessage((data as { error?: string }).error ?? "not_found"));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (!status) {
    return (
      <div>
        <h1 className="mb-6 text-xl font-bold">سیستم</h1>
        <ErrorBox>{error}</ErrorBox>
        {!error ? (
          <SkeletonRows rows={5} label="در حال بارگذاری وضعیت سامانه" />
        ) : (
          <ButtonLikeRetry onClick={() => void load()} />
        )}
      </div>
    );
  }

  const counts = status.counts ?? { businesses: 0, platformUsers: 0, platformAdmins: 0 };
  const pool = status.pool ?? { total: 0, idle: 0, waiting: 0 };
  const migrations = status.migrations ?? [];
  const backups = status.backups ?? [];
  const platformBackup = status.platformBackup ?? null;
  const migrationStatus = status.migrationStatus ?? null;
  const headline = migrationStatus ? migrationHeadline(migrationStatus) : null;
  const busy = pool.total - pool.idle;
  const shown = showAllMigrations ? migrations : migrations.slice(0, MIGRATIONS_PREVIEW);

  const copySummary = async () => {
    const text = [
      `کسب‌وکار: ${counts.businesses} | کاربران: ${counts.platformUsers} | مدیران: ${counts.platformAdmins}`,
      `وضعیت مهاجرت‌ها: ${headline?.summary ?? "نامشخص"} | RLS: ${status?.rlsEffective ? "فعال" : "غیرفعال"}`,
      `استخر اتصال: ${busy}/${pool.total} درگیر، ${pool.waiting} در صف`,
      `برداشت: ${formatJalali(new Date(loadedAt ?? Date.now()))}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; no-op — the figures are on screen */
    }
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">سیستم</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {loadedAt ? `آخرین به‌روزرسانی: ${fmtDate(loadedAt)} — هر دقیقه تازه می‌شود.` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void copySummary()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs text-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? "کپی شد" : "کپی خلاصه"}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs text-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            تازه‌سازی
          </button>
        </div>
      </div>

      {error ? (
        <InfoBox>
          نمایش آخرین وضعیت موفق؛ تازه‌سازی دوباره تلاش می‌کند. ({error})
        </InfoBox>
      ) : null}

      <section aria-label="وضعیت مهاجرت‌های پایگاه‌داده" className="space-y-3">
        <MigrationStatusBlock status={migrationStatus} />
      </section>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="کسب‌وکارها"
          value={formatPersianNumber(counts.businesses)}
          icon={<Database className="h-4 w-4" />}
        />
        <StatCard label="هویت‌های سکو" value={formatPersianNumber(counts.platformUsers)} />
        <StatCard label="مدیران سکو" value={formatPersianNumber(counts.platformAdmins)} />
        <StatCard
          label="ایزوله‌سازی سطری"
          value={status.rlsEffective ? "فعال" : "غیرفعال"}
          tone={status.rlsEffective ? "ok" : "bad"}
          hint={
            status.rlsEffective
              ? "نقش اپراتور superuser نیست"
              : "خطر: داده‌ها ایزوله نمی‌شوند!"
          }
          icon={
            status.rlsEffective ? (
              <ShieldCheck className="h-4 w-4" />
            ) : (
              <ShieldX className="h-4 w-4" />
            )
          }
        />
      </div>

      <Card title="استخر اتصال">
        <div className="mb-2 flex items-end justify-between text-sm">
          <span className="text-muted-foreground">
            {formatPersianNumber(busy)} درگیر از {formatPersianNumber(pool.total)}
          </span>
          <span className={pool.waiting > 0 ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}>
            {formatPersianNumber(pool.waiting)} در صف انتظار
          </span>
        </div>
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all ${
              pool.total > 0 && busy / pool.total > 0.85 ? "bg-amber-400" : "bg-sky-400"
            }`}
            style={{ width: `${pool.total > 0 ? Math.min(100, (busy / pool.total) * 100) : 0}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          صفِ غیرصفر یعنی درخواست‌ها پشت اتصال‌ها مانده‌اند — با رشد ترافیک، limit استخر را بالا ببرید.
        </p>
      </Card>

      <Card title="مهاجرت‌های اعمال‌شده">
        {migrations.length === 0 ? (
          <p className="text-sm text-muted-foreground">موردی یافت نشد.</p>
        ) : (
          <>
            <ul className="space-y-1 text-sm">
              {shown.map((m) => (
                <li
                  key={m.filename}
                  className="flex flex-col gap-1 border-b border-border py-2 last:border-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="break-all text-foreground" dir="ltr">
                    {m.filename}
                  </span>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">{fmtDate(m.appliedAt)}</span>
                </li>
              ))}
            </ul>
            {migrations.length > MIGRATIONS_PREVIEW ? (
              <button
                type="button"
                onClick={() => setShowAllMigrations((v) => !v)}
                className="mt-2 text-xs text-sky-700 dark:text-sky-300 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                {showAllMigrations
                  ? "فشرده‌سازی فهرست"
                  : `نمایش همهٔ ${formatPersianNumber(migrations.length)} مورد`}
              </button>
            ) : null}
          </>
        )}
      </Card>

      <Card title="آخرین پشتیبان‌گیری هر کسب‌وکار">
        {platformBackup ? (
          <div className="mb-3 flex flex-col gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
            <span className="flex flex-wrap items-center gap-2">
              <Link href="/platform/backup" className="font-medium text-sky-700 dark:text-sky-300 hover:underline">
                پشتیبان‌گیری کل سیستم
              </Link>
              <span
                className={
                  platformBackup.alertLevel === "ok"
                    ? "rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300"
                    : platformBackup.alertLevel === "warning"
                      ? "rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300"
                      : "rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs text-red-700 dark:text-red-300"
                }
              >
                {PLATFORM_BACKUP_ALERT_LABELS[platformBackup.alert] ?? platformBackup.alert}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground sm:gap-3">
              <span>{formatPersianNumber(platformBackup.artifacts)} نسخه روی دیسک</span>
              {platformBackup.servingEnabled ? <span className="text-amber-700/80 dark:text-amber-300/80">ارسال به سرور دیگر روشن</span> : null}
              <span className="whitespace-nowrap">{fmtDate(platformBackup.ranAt)}</span>
            </span>
          </div>
        ) : null}
        {backups.length === 0 ? (
          <p className="text-sm text-muted-foreground">پشتیبانی ثبت نشده است.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {backups.map((b) => (
              <li
                key={b.businessId}
                className="flex flex-col gap-2 border-b border-border py-2 last:border-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="text-foreground">{b.businessName}</span>
                <span className="flex flex-wrap items-center gap-2 sm:gap-3">
                  <span
                    className={
                      b.status === "success"
                        ? "rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300"
                        : b.status === "failed"
                          ? "rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs text-red-700 dark:text-red-300"
                          : "rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
                    }
                  >
                    {b.status === "success" ? "موفق" : b.status === "failed" ? "ناموفق" : b.status}
                  </span>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">{fmtDate(b.ranAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/**
 * The migration block: one canonical status, rendered as the distinct operator
 * situations it actually contains. Every branch names the migration, its state
 * and reason, the next required action and the last successful application.
 */
function MigrationStatusBlock({ status }: { status: MigrationStatus | null }) {
  if (!status) {
    return (
      <div className="rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm text-muted-foreground">
        وضعیت مهاجرت‌ها در دسترس نیست.
      </div>
    );
  }

  const headline = migrationHeadline(status);
  const tone = TONE_CLASS[headline.tone] ?? TONE_CLASS.unknown;

  return (
    <div className="space-y-3">
      <div
        className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${tone.box}`}
        role="status"
        aria-live="polite"
      >
        <span className={`mt-0.5 shrink-0 ${tone.icon}`} aria-hidden="true">
          {toneIcon(headline.tone)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            <span className="me-2">{headline.label}</span>
            <span className="font-normal">{headline.summary}</span>
          </p>
          <p className="mt-1 text-xs opacity-80">
            آخرین مهاجرت موفق:{" "}
            {status.lastAppliedAt ? fmtDate(status.lastAppliedAt) : "ثبت‌شده‌ای وجود ندارد"} — بررسی
            در {fmtDate(status.checkedAt)}
          </p>
        </div>
      </div>

      {!status.available ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-800 dark:text-red-200">
          <p className="font-medium">وضعیت مهاجرت‌ها نامشخص است.</p>
          <p className="mt-1 text-xs leading-6 opacity-80">
            دلیل: {migrationReasonLabel(status.reasonCode ?? "")} در این وضعیت شمار «اجرا نشده»
            گزارش نمی‌شود و این صفحه ادعای سالم بودن نمی‌کند.
          </p>
          <p className="mt-2 text-xs opacity-80" dir="ltr">
            {MIGRATE_COMMAND}
          </p>
        </div>
      ) : null}

      {status.cutover.flagsConflict ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-800 dark:text-red-200">
          <p className="font-medium">تناقض در تنظیمات مهاجرت کلید هوش مصنوعی</p>
          <p className="mt-1 text-xs opacity-80">
            هر دو تنظیم AI_GATEWAY_SECRET_CUTOVER_DEFER و AI_GATEWAY_SECRET_CUTOVER_VERIFIED روشن
            هستند و اجرای مهاجرت تا رفع یکی از آن‌ها رد می‌شود.
          </p>
        </div>
      ) : null}

      {status.cutover.blockedBy ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-800 dark:text-red-200">
          <p className="font-medium">یک مهاجرت بعدی به ستون قدیدی وابسته است</p>
          <p className="mt-1 text-xs opacity-80" dir="ltr">
            {status.cutover.blockedBy}
          </p>
          <p className="mt-1 text-xs opacity-80">
            این مهاجرت هنوز اعمال نشده و به ستون متنی قدیمی کلید هوش مصنوعی اشاره می‌کند؛ تا زمانی که
            مهاجرت کلید هوش مصنوعی به تعویق افتاده، اجرای مهاجرت‌ها نمی‌تواند از آن جلو بزند.
          </p>
        </div>
      ) : null}

      {status.gated.length > 0 ? (
        <GatedCutoverBlock status={status} />
      ) : null}

      {status.ordinaryPending.length > 0 ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          <p className="flex items-start gap-2 font-medium">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              {formatPersianNumber(status.ordinaryPending.length)} مهاجرت هنوز روی پایگاه‌داده اعمال
              نشده است؛ کد در حال اجرا جلوتر از ساختار داده است.
            </span>
          </p>
          <ul className="mt-2 space-y-1">
            {status.ordinaryPending.map((entry) => (
              <MigrationRow key={entry.filename} entry={entry} />
            ))}
          </ul>
          <p className="mt-3 text-xs font-medium">اقدام بعدی: اجرای معمول مهاجرت‌ها</p>
          <p className="mt-1 text-xs opacity-80" dir="ltr">
            {MIGRATE_COMMAND}
          </p>
        </div>
      ) : null}

      {status.available && status.gated.length === 0 && status.ordinaryPending.length === 0 ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
          همهٔ مهاجرت‌های این نسخه روی پایگاه‌داده اعمال شده‌اند.
        </div>
      ) : null}
    </div>
  );
}

/**
 * The gated AI gateway secret cutover. Deliberately NOT the generic schema
 * warning: the pending migration is a hold, and the next step is a verification
 * sequence an operator performs — never a button on a health dashboard.
 */
function GatedCutoverBlock({ status }: { status: MigrationStatus }) {
  const cutover = status.cutover;
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
      <p className="flex items-start gap-2 font-medium">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>پاک‌سازی کلیدهای قدیمی هوش مصنوعی در انتظار تأیید است</span>
      </p>
      <p className="mt-2 text-xs leading-6 opacity-90">
        کلیدهای متنی قدیمی هوش مصنوعی به‌عمد نگه داشته شده‌اند تا خوانش رمزنگاری‌شده روی همهٔ
        نمونه‌ها و شاخه‌ها تأیید شود. اجرای سادهٔ <span dir="ltr">npm run db:migrate</span> این
        مهاجرت را دوباره به تعویق می‌اندازد؛ آن را با تأیید صریح و پس از کامل‌شدن مراحل زیر اجرا
        کنید.
      </p>
      <p className="mt-1 text-xs leading-6 opacity-90">
        دامنهٔ تأیید: یک آزمون موفق با یک کلید تجربی، سلامت همهٔ کلیدهای کسب‌وکارها/شاخه‌ها یا همهٔ
        نمونه‌های در حال اجرا را تضمین نمی‌کند. این صفحه هیچ آزمون پرداخت‌بر یا اتصال به ارائه‌دهنده
        انجام نمی‌دهد؛ وضعیت اتصال را در صفحهٔ هوش مصنوعی ببینید.
      </p>

      <ul className="mt-3 space-y-2">
        {status.gated.map((entry) => (
          <li key={entry.filename}>
            <MigrationRow entry={entry} />
            <p className="mt-1 text-xs leading-6 opacity-90">
              اقدام بعدی: ابتدا خوانش رمزنگاری‌شده را روی هر نمونهٔ در حال اجرا بررسی کنید، سپس
              نمونه‌های قدیمی را خالی کنید و در پایان مهاجرت را با تأیید صریح اجرا کنید.
            </p>
          </li>
        ))}
      </ul>

      {cutover.rowsMissingCiphertext !== null && cutover.rowsMissingCiphertext > 0 ? (
        <p className="mt-3 text-xs leading-6 opacity-90">
          {formatPersianNumber(cutover.rowsMissingCiphertext)} ردیف کلید متنی بدون نسخهٔ
          رمزنگاری‌شده وجود دارد؛ ابتدا <span dir="ltr">npm run db:encrypt-ai-secrets</span> را اجرا
          کنید.
        </p>
      ) : null}
      {cutover.legacyPlaintextRows !== null && cutover.legacyPlaintextRows > 0 ? (
        <p className="mt-1 text-xs leading-6 opacity-90">
          {formatPersianNumber(cutover.legacyPlaintextRows)} ردیف هنوز کلید متنی قدیمی را نگه
          داشته است.
        </p>
      ) : null}

      <div className="mt-3 space-y-1">
        <p className="text-xs font-medium">مراحل تکمیل (هر دستور جداگانه، درون کانتینر برنامه):</p>
        <ol className="list-decimal space-y-1 ps-5 text-xs">
          {AI_SECRET_CUTOVER_COMMANDS.map((command) => (
            <li key={command}>
              <code className="break-all" dir="ltr">
                {command}
              </code>
            </li>
          ))}
        </ol>
        <p className="pt-1 text-xs font-medium">تنها پس از موفقیت مراحل بالا:</p>
        <code className="block break-all text-xs" dir="ltr">
          {AI_SECRET_CUTOVER_MIGRATE_COMMAND}
        </code>
        <p className="pt-1 text-xs leading-6 opacity-90">
          تنظیم تأیید نباید پیش‌فرض دائمی استقرار شود؛ پس از ثبت مهاجرت آن را بردارید.
        </p>
      </div>

      <p className="mt-3 text-xs">
        <Link
          href="/platform/ai"
          className="font-medium text-sky-700 underline dark:text-sky-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          مشاهدهٔ وضعیت اتصال و کلیدهای هوش مصنوعی
        </Link>
      </p>
    </div>
  );
}

/** One migration line: filename (LTR, wrapped), state, reason, last success. */
function MigrationRow({ entry }: { entry: MigrationEntry }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 px-3 py-2">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <span className="break-all text-foreground" dir="ltr">
          {entry.filename}
        </span>
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {migrationStateLabel(entry)}
        </span>
      </div>
      <p className="mt-1 text-xs leading-6 text-muted-foreground">{migrationReasonLabel(entry.reasonCode)}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        آخرین اجرای موفق: {entry.appliedAt ? fmtDate(entry.appliedAt) : "هرگز"}
      </p>
      {entry.detail ? <p className="mt-0.5 text-xs text-muted-foreground">{entry.detail}</p> : null}
    </div>
  );
}

function ButtonLikeRetry({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-4 inline-flex h-9 items-center rounded-lg border border-border px-4 text-sm text-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      تلاش دوباره
    </button>
  );
}
