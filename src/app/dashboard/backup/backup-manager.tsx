"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
/**
 * Backup dashboard (Phase 10). Four cards:
 *  1. Status — health badges, last successful local/cloud backup, a manual
 *     «پشتیبان‌گیری هم‌اکنون» button, and the recent run history.
 *  2. Restore (Owner only) — the counterpart of 1: verify a stored artifact
 *     into a scratch database, then replace the live one with it after an
 *     explicit confirmation. Hidden unless the install holds one business.
 *  3. Export (Owner only) — this business's own data, as SQL or xlsx.
 *  4. Settings (Owner only) — schedule/retention plus the cloud target.
 *     Secrets are write-only: the server never echoes them back, an empty
 *     field on save means "keep the stored value".
 */
import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { uploadRestoreFile } from "@/lib/restore-upload-client";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ErrorBox, Field, InfoBox, PrimaryButton, api, inputClass } from "../ui";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, StatusBadge } from "../page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";

interface Health {
  enabled: boolean;
  cloudEnabled: boolean;
  intervalHours: number;
  localLastSuccessAt: string | null;
  localLastError: string | null;
  cloudLastSuccessAt: string | null;
  cloudLastError: string | null;
  alert: { level: "ok" | "warning" | "error"; reason: string };
}

interface RunRow {
  id: string;
  kind: "local" | "cloud";
  trigger: "scheduled" | "manual";
  status: "running" | "success" | "failed";
  artifact: string | null;
  sizeBytes: number | null;
  error: string | null;
  startedAt: string;
}

interface CloudForm {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  passphrase: string;
  retention: number;
  hasSecretAccessKey?: boolean;
  hasPassphrase?: boolean;
}

interface ConfigForm {
  enabled: boolean;
  intervalHours: number;
  anchorTime: string;
  localRetention: number;
  directory: string;
  passphrase?: string;
  encryptLocal?: boolean;
  hasPassphrase?: boolean;
  warnings?: string[];
  cloud: CloudForm;
}

interface RestoreArtifact {
  key: string;
  kind: "local" | "cloud";
  sizeBytes: number | null;
  startedAt: string;
  exists: boolean;
}

interface RestoreSummary {
  source: string;
  migrations: number;
  latestMigration: string;
  tables: { name: string; rows: number }[];
}

interface RestoreView {
  allowed: boolean;
  local: RestoreArtifact[];
  cloud: RestoreArtifact[];
}

const ALERT_LABELS: Record<string, string> = {
  ok: "سالم",
  disabled: "پشتیبان‌گیری خودکار غیرفعال است",
  local_failed: "آخرین پشتیبان‌گیری محلی ناموفق بود",
  local_stale: "مدت زیادی از آخرین پشتیبان محلی موفق گذشته است",
  cloud_failed: "آخرین بارگذاری ابری ناموفق بود",
  cloud_stale: "مدت زیادی از آخرین پشتیبان ابری موفق گذشته است",
};

const CONFIG_ERRORS: Record<string, string> = {
  not_an_object: "داده‌های تنظیمات نامعتبر است.",
  invalid_cloud: "تنظیمات فضای ابری نامعتبر است.",
  invalid_interval: "بازهٔ پشتیبان‌گیری نامعتبر است.",
  invalid_anchor_time: "ساعت پشتیبان‌گیری نامعتبر است.",
  invalid_local_retention: "تعداد نگهداری نسخه‌های محلی باید بین ۱ تا ۳۶۵ باشد.",
  invalid_cloud_retention: "تعداد نگهداری نسخه‌های ابری باید بین ۱ تا ۳۶۵ باشد.",
  invalid_cloud_endpoint: "نشانی فضای ابری باید با http یا https شروع شود.",
  invalid_cloud_prefix: "پیشوند نباید با / شروع شود.",
  missing_cloud_bucket: "نام باکت را وارد کنید.",
  missing_cloud_credentials: "کلید دسترسی و کلید محرمانه هر دو لازم‌اند.",
  weak_passphrase: "عبارت عبور رمزنگاری باید دست‌کم ۸ نویسه باشد.",
  invalid_directory: "مسیر پوشهٔ پشتیبان‌گیری نامعتبر است.",
  cloud_backup_unavailable_local: "در نصب محلی، پشتیبان‌گیری ابری در دسترس نیست.",
  passphrase_required: "برای پشتیبان ابری، یک عبارت عبور رمزنگاری حداقل ۸ نویسه‌ای ذخیره کنید.",
};

const RESTORE_ERRORS: Record<string, string> = {
  restore_busy: "یک بازگردانی دیگر در حال اجراست؛ کمی بعد دوباره تلاش کنید.",
  restore_not_available:
    "بازگردانی کل پایگاه‌داده روی این نصب در دسترس نیست، زیرا دادهٔ بیش از یک کسب‌وکار را نگه می‌دارد.",
  artifact_not_found: "این فایل دیگر روی دیسک نیست (احتمالاً توسط نگهداری نسخه‌ها حذف شده است).",
  cloud_not_configured: "اطلاعات فضای ابری برای دانلود پیکربندی نشده است.",
  passphrase_required: "برای پشتیبان ابری، یک عبارت عبور رمزنگاری حداقل ۸ نویسه‌ای ذخیره کنید.",
  missing_artifact: "نسخهٔ پشتیبان انتخاب نشده است.",
  download_failed: "دریافت نسخهٔ پشتیبان از فضای ابری ناموفق بود:",
  decrypt_failed: "رمزگشایی نسخهٔ پشتیبان ناموفق بود — عبارت عبور را بررسی کنید:",
  upload_not_found: "فایل بارگذاری‌شده دیگر روی سرور نیست؛ دوباره بارگذاری کنید.",
  upload_failed: "بارگذاری فایل پشتیبان ناموفق بود.",
  upload_network: "ارتباط هنگام بارگذاری فایل قطع شد؛ دوباره تلاش کنید.",
  upload_offset: "بارگذاری فایل پشتیبان ناهماهنگ شد؛ دوباره تلاش کنید.",
  upload_too_large: "این فایل برای بازگردانی بیش از حد بزرگ است.",
  empty_chunk: "فایل انتخاب‌شده خالی است.",
};

function restoreErrorMessage(code: string): string {
  if (!code) return "بازگردانی ناموفق بود.";
  // download_failed:… / decrypt_failed:… carry the underlying reason after the colon.
  const sep = code.indexOf(":");
  if (sep !== -1) {
    const prefix = code.slice(0, sep);
    const detail = code.slice(sep + 1);
    if (prefix === "download_failed" || prefix === "decrypt_failed") {
      return `${RESTORE_ERRORS[prefix]} ${detail}`;
    }
  }
  return RESTORE_ERRORS[code] ?? code;
}

function formatTime(iso: string | null): string {
  if (!iso) return "هرگز";
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
  return `${toPersianDigits(formatJalali(iso))} ${toPersianDigits(time)}`;
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "—";
  const mb = bytes / (1024 * 1024);
  return toPersianDigits(mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);
}

function RunStatus({ status }: { status: RunRow["status"] }) {
  if (status === "success") return <StatusBadge tone="positive">موفق</StatusBadge>;
  if (status === "failed") return <StatusBadge tone="danger">ناموفق</StatusBadge>;
  return <StatusBadge tone="active">در حال اجرا</StatusBadge>;
}

export function BackupManager({ isOwner }: { isOwner: boolean }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);

  const loadStatus = useCallback(async () => {
    const res = await api<{ health?: Health; runs?: RunRow[] }>("/api/backup/status");
    if (res.ok) {
      setHealth(res.data.health ?? null);
      setRuns(res.data.runs ?? []);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  return (
    <div className="space-y-6">
      <StatusCard health={health} runs={runs} onChanged={loadStatus} />
      {isOwner ? <RestoreCard onChanged={loadStatus} /> : null}
      {isOwner ? <ExportCard /> : null}
      {isOwner ? <SettingsCard onSaved={loadStatus} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Restore (Owner only) — verify into a scratch DB, then apply on confirmation
// ---------------------------------------------------------------------------

/** The source toggle's two pills — a pressed chip is amber (docs/ui-conventions.md). */
function SourcePill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-9 rounded-lg border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40 ${
        active
          ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 text-amber-950 dark:text-amber-200"
          : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function RestoreCard({ onChanged }: { onChanged: () => void }) {
  const [view, setView] = useState<RestoreView | null>(null);
  const [source, setSource] = useState<"local" | "cloud" | "file">("local");
  /** The artifact key a request is running for, and which of the two it is. */
  const [busy, setBusy] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"verify" | "apply" | null>(null);
  const [verify, setVerify] = useState<{ key: string; summary: RestoreSummary } | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<RestoreView>("/api/backup/restore");
    if (res.ok) setView(res.data);
    setError(null);
    setVerify(null);
    setConfirmKey(null);
    setConfirmed(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const artifacts = (source === "local" ? view?.local : source === "cloud" ? view?.cloud : null) ?? [];

  // A whole-database restore replaces every business on the install, so the
  // server only offers it when there is exactly one. Elsewhere the card is a
  // capability this install doesn't have — gone, not explained, the same way a
  // feature flag hides what a business hasn't bought.
  if (view && !view.allowed) return null;

  function pickSource(next: "local" | "cloud" | "file") {
    setSource(next);
    setConfirmKey(null);
    setConfirmed(false);
    setVerify(null);
  }

  async function run(key: string, apply: boolean) {
    setBusy(key);
    setBusyAction(apply ? "apply" : "verify");
    setError(null);
    setVerify(null);
    setDone(false);
    const res = await api<{ status?: string; summary?: RestoreSummary; error?: string }>(
      "/api/backup/restore",
      { method: "POST", body: JSON.stringify({ source, artifact: key, apply }) },
    );
    setBusy(null);
    setBusyAction(null);
    if (!res.ok || res.data.status === "failed") {
      setError(restoreErrorMessage(res.data.error ?? ""));
      return;
    }
    if (res.data.status === "verified" && res.data.summary) {
      setVerify({ key, summary: res.data.summary });
    } else if (res.data.status === "applied") {
      setDone(true);
      onChanged();
      load();
    }
  }

  return (
    <SectionCard
      title="بازگردانی پشتیبان"
      description="کل پایگاه‌دادهٔ این نصب را از یک نسخهٔ پشتیبان محلی یا ابری بازگردانی کنید. هر بازگردانی ابتدا در یک پایگاه‌دادهٔ موقت بررسی می‌شود و بدون تأیید شما چیزی تغییر نمی‌کند."
      actions={
        view?.allowed ? (
          <div
            role="group"
            aria-label="منبع بازگردانی"
            className="flex gap-1 rounded-xl border border-border/80 bg-muted/60 p-1"
          >
            <SourcePill active={source === "local"} onClick={() => pickSource("local")}>
              محلی
            </SourcePill>
            <SourcePill active={source === "cloud"} onClick={() => pickSource("cloud")}>
              ابری
            </SourcePill>
            <SourcePill active={source === "file"} onClick={() => pickSource("file")}>
              از فایل
            </SourcePill>
          </div>
        ) : null
      }
    >
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {verify ? (
        <InfoBox>
          بررسی <code dir="ltr">{verify.summary.source}</code> موفق بود —{" "}
          {toPersianDigits(String(verify.summary.migrations))} مهاجرت (آخرین:{" "}
          <code dir="ltr">{verify.summary.latestMigration}</code>) و جدول‌های اصلی:{" "}
          {verify.summary.tables
            .map((t) => `${t.name}: ${toPersianDigits(String(t.rows))}`)
            .join(" · ")}
          . این نسخه برای بازگردانی آماده است.
        </InfoBox>
      ) : null}
      {done ? (
        <InfoBox>
          بازگردانی انجام شد. داده‌های ثبت‌شده پس از زمان این پشتیبان از بین رفتند؛ برنامه را دوباره
          راه‌اندازی کنید تا با پایگاه‌دادهٔ بازگردانی‌شده هماهنگ شود و در صورت نیاز دوباره وارد شوید.
        </InfoBox>
      ) : null}

      {source === "file" ? (
        <UploadRestorePanel
          endpoint="/api/backup/restore/upload"
          onRun={async ({ uploadId, fileName, passphrase, apply }) => {
            const res = await api<{ status?: string; summary?: RestoreSummary; error?: string }>(
              "/api/backup/restore",
              {
                method: "POST",
                body: JSON.stringify({ source: "upload", uploadId, fileName, passphrase, apply }),
              },
            );
            if (res.ok && res.data.status === "applied") onChanged();
            return res.ok ? res.data : { error: res.data.error ?? "" };
          }}
        />
      ) : !view ? (
        <LoadingSkeleton rows={3} />
      ) : artifacts.length === 0 ? (
        <EmptyState>نسخهٔ پشتیبان {source === "local" ? "محلی" : "ابری"} موفقی یافت نشد.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {artifacts.map((artifact) => {
            const isBusy = busy === artifact.key;
            return (
              <li
                key={artifact.key}
                className="rounded-xl border border-border/80 p-3 sm:p-3.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p
                      dir="ltr"
                      title={artifact.key}
                      className="truncate text-start font-mono text-xs text-foreground"
                    >
                      {artifact.key}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>
                        {formatTime(artifact.startedAt)}
                        {artifact.sizeBytes !== null ? ` · ${formatSize(artifact.sizeBytes)}` : ""}
                      </span>
                      {!artifact.exists ? (
                        <StatusBadge tone="neutral">حذف‌شده توسط نگهداری نسخه‌ها</StatusBadge>
                      ) : null}
                      {verify?.key === artifact.key ? (
                        <StatusBadge tone="positive">بررسی‌شده و آماده</StatusBadge>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isBusy || !artifact.exists}
                      onClick={() => void run(artifact.key, false)}
                    >
                      {isBusy && busyAction === "verify" ? "در حال بررسی…" : "بررسی"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={isBusy || !artifact.exists}
                      onClick={() => {
                        setConfirmKey(confirmKey === artifact.key ? null : artifact.key);
                        setConfirmed(false);
                      }}
                    >
                      بازگردانی
                    </Button>
                  </div>
                </div>

                {isBusy && busyAction === "apply" ? (
                  <p className="mt-3 rounded-lg border border-amber-500/25 dark:border-amber-500/60 bg-amber-500/[0.075] dark:bg-amber-400/15 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                    در حال بازگردانی — پایگاه‌داده به‌طور موقت از دسترس خارج است.
                  </p>
                ) : null}

                {confirmKey === artifact.key ? (
                  <div className="mt-3 space-y-3 rounded-xl border border-destructive/25 bg-destructive/[0.055] p-3">
                    <p className="text-xs leading-5 text-destructive">
                      بازگردانی، پایگاه‌دادهٔ فعلی را با محتوای این پشتیبان جایگزین می‌کند؛ هر
                      داده‌ای که پس از زمان آن ثبت شده (سفارش‌ها، موجودی، اسناد و تنظیمات) از بین
                      می‌رود. ابتدا همان بررسی اولیه انجام می‌شود و اگر فایل معتبر نباشد، چیزی تغییر
                      نمی‌کند.
                    </p>
                    <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(e) => setConfirmed(e.target.checked)}
                        className="size-4"
                      />
                      می‌فهمم که داده‌های پس از این پشتیبان حذف می‌شود.
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={!confirmed || isBusy}
                        onClick={() => void run(artifact.key, true)}
                      >
                        {isBusy && busyAction === "apply" ? "در حال بازگردانی…" : "بازگردانی نهایی"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setConfirmKey(null)}
                      >
                        انصراف
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Restore from a file this install never recorded (reinstall, USB stick)
// ---------------------------------------------------------------------------

type RestoreRunResult = { status?: string; summary?: RestoreSummary; error?: string };

function uploadErrorMessage(code: string): string {
  if (code === "passphrase_required") {
    return "این فایل رمزنگاری شده است؛ عبارت عبور رمزنگاری همان نصبی را که پشتیبان را ساخته وارد کنید.";
  }
  if (code === "restore_not_available") {
    return "بازگردانی روی این نصب در دسترس نیست (فقط روی نصب تازه یا تک‌کسب‌وکاری ممکن است).";
  }
  return restoreErrorMessage(code);
}

/**
 * Pick a `.dump`/`.dump.enc`, upload it in pieces, verify it into a scratch
 * database, then — after the same explicit confirmation as a listed artifact —
 * apply it. Shared with the first-run screen, which passes its own endpoints.
 */
export function UploadRestorePanel({
  endpoint,
  onRun,
  onApplied,
}: {
  endpoint: string;
  onRun: (input: {
    uploadId: string;
    fileName: string;
    passphrase: string;
    apply: boolean;
  }) => Promise<RestoreRunResult>;
  onApplied?: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState<"upload" | "verify" | "apply" | null>(null);
  const [summary, setSummary] = useState<RestoreSummary | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pickFile(next: File | null) {
    setFile(next);
    setUploadId(null);
    setSummary(null);
    setConfirmed(false);
    setDone(false);
    setError(null);
    setProgress(null);
  }

  async function verify() {
    if (!file) return;
    setError(null);
    setSummary(null);
    let id = uploadId;
    if (!id) {
      setBusy("upload");
      const uploaded = await uploadRestoreFile(endpoint, file, setProgress);
      if (!uploaded.ok) {
        setBusy(null);
        setError(uploadErrorMessage(uploaded.error));
        return;
      }
      id = uploaded.uploadId;
      setUploadId(id);
    }
    setBusy("verify");
    const result = await onRun({ uploadId: id, fileName: file.name, passphrase, apply: false });
    setBusy(null);
    if (result.error || result.status !== "verified" || !result.summary) {
      if (result.error === "upload_not_found") setUploadId(null);
      setError(uploadErrorMessage(result.error ?? ""));
      return;
    }
    setSummary(result.summary);
  }

  async function apply() {
    if (!file || !uploadId) return;
    setBusy("apply");
    setError(null);
    const result = await onRun({ uploadId, fileName: file.name, passphrase, apply: true });
    setBusy(null);
    if (result.error || result.status !== "applied") {
      if (result.error === "upload_not_found") setUploadId(null);
      setError(uploadErrorMessage(result.error ?? ""));
      return;
    }
    setDone(true);
    setSummary(null);
    onApplied?.();
  }

  return (
    <div className="space-y-3">
      <p className="text-sm leading-6 text-muted-foreground">
        فایل پشتیبانی را که پیش‌تر ساخته‌اید (مثلاً قبل از حذف و نصب دوبارهٔ برنامه) انتخاب کنید —
        پسوند آن <code dir="ltr">.dump</code> یا <code dir="ltr">.dump.enc</code> است. فایل خروجی SQL
        یا اکسل قابل بازگردانی نیست.
      </p>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {done ? (
        <InfoBox>
          بازگردانی انجام شد. برنامه را ببندید و دوباره باز کنید، سپس با همان حساب کاربری قبلی وارد
          شوید. برای وصل‌کردن دوبارهٔ همگام‌سازی ابری به «تنظیمات ← اتصال‌ها ← برنامهٔ دسکتاپ ← ترمیم /
          اتصال دوباره» بروید و یک کد اتصال تازه از پنل ابری وارد کنید.
        </InfoBox>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="فایل پشتیبان">
          <input
            type="file"
            accept=".dump,.enc,application/octet-stream"
            className={inputClass}
            disabled={busy !== null}
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        <Field label="عبارت عبور رمزنگاری (اگر فایل رمزنگاری‌شده است)">
          <input
            type="password"
            dir="ltr"
            autoComplete="off"
            className={inputClass}
            value={passphrase}
            disabled={busy !== null}
            onChange={(e) => setPassphrase(e.target.value)}
          />
        </Field>
      </div>
      {busy === "upload" && progress !== null ? (
        <p className="text-xs text-muted-foreground">
          در حال بارگذاری… {toPersianDigits(String(Math.round(progress * 100)))}٪
        </p>
      ) : null}
      {summary ? (
        <InfoBox>
          بررسی <code dir="ltr">{summary.source}</code> موفق بود —{" "}
          {toPersianDigits(String(summary.migrations))} مهاجرت و جدول‌های اصلی:{" "}
          {summary.tables.map((t) => `${t.name}: ${toPersianDigits(String(t.rows))}`).join(" · ")}.
        </InfoBox>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!file || busy !== null}
          onClick={() => void verify()}
        >
          {busy === "upload" ? "در حال بارگذاری…" : busy === "verify" ? "در حال بررسی…" : "بارگذاری و بررسی"}
        </Button>
      </div>
      {summary ? (
        <div className="space-y-3 rounded-xl border border-destructive/25 bg-destructive/[0.055] p-3">
          <p className="text-xs leading-5 text-destructive">
            بازگردانی، پایگاه‌دادهٔ فعلی این نصب را کامل با محتوای این فایل جایگزین می‌کند؛ هر داده‌ای
            که اکنون در این نصب است و در فایل نیست از بین می‌رود.
          </p>
          <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="size-4"
            />
            می‌فهمم که دادهٔ فعلی این نصب با این فایل جایگزین می‌شود.
          </label>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={!confirmed || busy !== null}
            onClick={() => void apply()}
          >
            {busy === "apply" ? "در حال بازگردانی…" : "بازگردانی نهایی"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-tenant export (Phase 17, Owner only)
// ---------------------------------------------------------------------------

async function downloadExport(format: "sql" | "xlsx", encrypt: boolean): Promise<string | null> {
  const res = await fetch(`/api/backup/export?format=${format}${encrypt ? "&encrypt=1" : ""}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (data.error === "passphrase_required") {
      return "برای رمزنگاری فایل خروجی، ابتدا عبارت عبور رمزنگاری را در تنظیمات پشتیبان‌گیری ذخیره کنید.";
    }
    return data.error ?? "دریافت خروجی ناموفق بود.";
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match ? match[1] : `business-export.${format}`;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return null;
}

function ExportCard() {
  const [busy, setBusy] = useState<"sql" | "xlsx" | null>(null);
  const [encrypt, setEncrypt] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(format: "sql" | "xlsx") {
    setBusy(format);
    setError(null);
    const err = await downloadExport(format, encrypt);
    if (err) setError(err);
    setBusy(null);
  }

  return (
    <SectionCard title="خروجی اطلاعات کسب‌وکار">
      <p className="mb-4 text-sm text-muted-foreground">
        تمام اطلاعات این کسب‌وکار (سفارش‌ها، انبار، حساب‌ها، اعضا و غیره) را دریافت کنید — جدا از
        سایر کسب‌وکارهای این سامانه. فایل SQL برای بازگردانی در پایگاه‌دادهٔ دیگر و فایل اکسل برای
        مشاهده و بایگانی مناسب است.
      </p>
      <label className="mb-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={encrypt}
          onChange={(e) => setEncrypt(e.target.checked)}
          className="size-4"
        />
        رمزنگاری فایل خروجی با عبارت عبور پشتیبان‌گیری
      </label>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <div className="flex flex-wrap gap-3">
        <PrimaryButton type="button" disabled={busy !== null} onClick={() => run("sql")}>
          {busy === "sql" ? "در حال آماده‌سازی…" : "دریافت خروجی SQL"}
        </PrimaryButton>
        <PrimaryButton type="button" disabled={busy !== null} onClick={() => run("xlsx")}>
          {busy === "xlsx" ? "در حال آماده‌سازی…" : "دریافت خروجی اکسل"}
        </PrimaryButton>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 1. Status + manual backup + history
// ---------------------------------------------------------------------------

function StatusCard({
  health,
  runs,
  onChanged,
}: {
  health: Health | null;
  runs: RunRow[] | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function backupNow() {
    setBusy(true);
    setMessage(null);
    setError(null);
    const res = await api<{
      result?: {
        local: { status: string; artifact?: string; error?: string };
        cloud: { status: string; error?: string };
      };
    }>("/api/backup/run", { method: "POST" });
    setBusy(false);
    const result = res.data.result;
    if (result?.local.status === "ok") {
      if (result.cloud.status === "ok") setMessage("پشتیبان محلی و ابری با موفقیت ساخته شد.");
      else if (result.cloud.status === "disabled") setMessage("پشتیبان محلی با موفقیت ساخته شد.");
      else setError(`پشتیبان محلی ساخته شد اما بارگذاری ابری ناموفق بود: ${result.cloud.error ?? ""}`);
    } else if (result?.local.status === "busy") {
      setError("یک پشتیبان‌گیری دیگر در حال اجراست؛ کمی بعد دوباره تلاش کنید.");
    } else {
      setError(`پشتیبان‌گیری ناموفق بود: ${result?.local.error ?? "خطای نامشخص"}`);
    }
    onChanged();
  }

  return (
    <SectionCard
      title="وضعیت پشتیبان‌گیری"
      actions={
        <Button type="button" onClick={backupNow} disabled={busy}>
          {busy ? "در حال پشتیبان‌گیری…" : "پشتیبان‌گیری هم‌اکنون"}
        </Button>
      }
    >
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {message ? <InfoBox>{message}</InfoBox> : null}

      {!health ? (
        <LoadingSkeleton rows={3} />
      ) : (
        <>
          <div
            className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
              health.alert.level === "ok"
                ? "border-primary/30 bg-primary/5 text-primary"
                : health.alert.level === "warning"
                  ? "border-amber-500/40 dark:border-amber-500/60 bg-amber-500/10 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300"
                  : "border-destructive/40 bg-destructive/10 text-destructive"
            }`}
          >
            {ALERT_LABELS[health.alert.reason] ?? health.alert.reason}
          </div>
          <dl className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-2 sm:justify-start">
              <dt className="text-muted-foreground">آخرین پشتیبان محلی موفق:</dt>
              <dd>{formatTime(health.localLastSuccessAt)}</dd>
            </div>
            <div className="flex justify-between gap-2 sm:justify-start">
              <dt className="text-muted-foreground">آخرین پشتیبان ابری موفق:</dt>
              <dd>{health.cloudEnabled ? formatTime(health.cloudLastSuccessAt) : "غیرفعال"}</dd>
            </div>
          </dl>
        </>
      )}

      <h3 className="mb-2 mt-6 text-sm font-medium text-muted-foreground">اجراهای اخیر</h3>
      {!runs ? (
        <LoadingSkeleton rows={3} />
      ) : runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">هنوز پشتیبانی گرفته نشده است.</p>
      ) : (
        <DataTable caption="تاریخچه پشتیبان‌گیری" frame={false} tableClassName="min-w-[560px]">
          <DataTableHead>
            <Th>زمان</Th>
            <Th>نوع</Th>
            <Th>شروع</Th>
            <Th numeric>حجم</Th>
            <Th>وضعیت</Th>
          </DataTableHead>
          <DataTableBody>
            {runs.map((r) => (
              <DataTableRow key={r.id} className="align-top">
                <Td>{formatTime(r.startedAt)}</Td>
                <Td>{r.kind === "local" ? "محلی" : "ابری"}</Td>
                <Td>{r.trigger === "scheduled" ? "زمان‌بندی" : "دستی"}</Td>
                <Td numeric>{formatSize(r.sizeBytes)}</Td>
                <Td>
                  <RunStatus status={r.status} />
                  {r.error ? (
                    <p dir="ltr" className="mt-1 max-w-xs truncate text-xs text-destructive" title={r.error}>
                      {r.error}
                    </p>
                  ) : null}
                </Td>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 2. Settings (Owner only)
// ---------------------------------------------------------------------------

const INTERVAL_OPTIONS = [
  { value: 24, label: "شبانه (هر ۲۴ ساعت)" },
  { value: 12, label: "هر ۱۲ ساعت" },
  { value: 8, label: "هر ۸ ساعت" },
  { value: 6, label: "هر ۶ ساعت" },
  { value: 4, label: "هر ۴ ساعت" },
  { value: 2, label: "هر ۲ ساعت" },
  { value: 1, label: "هر ساعت" },
];

function SettingsCard({ onSaved }: { onSaved: () => void }) {
  const [config, setConfig] = useState<ConfigForm | null>(null);
  const [localOnly, setLocalOnly] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await api<{ config?: ConfigForm; localOnly?: boolean }>("/api/backup/config");
      if (res.ok && res.data.config) setConfig(res.data.config);
      if (res.ok) setLocalOnly(Boolean(res.data.localOnly));
    })();
  }, []);

  if (!config) {
    return (
      <SectionCard title="تنظیمات پشتیبان‌گیری">
        <LoadingSkeleton rows={3} />
      </SectionCard>
    );
  }

  const cloud = config.cloud;
  const setCloud = (patch: Partial<CloudForm>) => setConfig({ ...config, cloud: { ...cloud, ...patch } });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    const res = await api<{ error?: string }>("/api/backup/config", {
      method: "PUT",
      body: JSON.stringify(config),
    });
    setBusy(false);
    if (!res.ok) {
      setError(CONFIG_ERRORS[res.data.error ?? ""] ?? "ذخیرهٔ تنظیمات ناموفق بود.");
      return;
    }
    setMessage("ذخیره شد.");
    onSaved();
  }

  return (
    <SectionCard title="تنظیمات پشتیبان‌گیری">
      {config.warnings && config.warnings.length > 0 ? (
        <div className="mb-6 rounded-lg border border-amber-500/40 dark:border-amber-500/60 bg-amber-500/10 dark:bg-amber-500/15 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          <ul className="list-inside list-disc">
            {config.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="mb-4 text-sm text-muted-foreground">
        {localOnly ? (
          <>
            پشتیبان محلی در پوشهٔ مقصد زیر (و در صورت تنظیم BACKUP_SECONDARY_DIR، روی حافظهٔ دوم
            مثل USB/NAS) ذخیره می‌شود.
          </>
        ) : (
          <>
            پشتیبان محلی در پوشهٔ backups سرور (و در صورت تنظیم BACKUP_SECONDARY_DIR، روی حافظهٔ
            دوم مثل USB/NAS) ذخیره می‌شود. نسخهٔ ابری پیش از بارگذاری با عبارت عبور شما رمزنگاری
            می‌شود — بدون آن، بازگردانی از نسخهٔ ابری ممکن نیست؛ آن را جای امنی نگه دارید.
          </>
        )}
      </p>

      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {message ? <InfoBox>{message}</InfoBox> : null}

      <form onSubmit={save} className="max-w-xl">
        <label className="mb-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
          />
          پشتیبان‌گیری خودکار فعال باشد
        </label>

        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="بازهٔ پشتیبان‌گیری">
            <SearchableSelect
              value={String(config.intervalHours)}
              onChange={(value) => setConfig({ ...config, intervalHours: Number(value) })}
              options={INTERVAL_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
            />
          </Field>
          <Field label="ساعت شروع (به وقت محلی)" hint="مثلاً ۰۳:۳۰ بامداد، بعد از بستن روز">
            <input
              type="time"
              dir="ltr"
              className={inputClass}
              value={config.anchorTime}
              onChange={(e) => setConfig({ ...config, anchorTime: e.target.value })}
            />
          </Field>
        </div>
        <Field label="تعداد نسخه‌های محلی نگه‌داشته‌شده" hint="نسخه‌های قدیمی‌تر خودکار حذف می‌شوند">
          <PersianNumberInput
            dir="ltr"
            className={inputClass}
            value={config.localRetention}
            onChange={(e) => setConfig({ ...config, localRetention: Number(e.target.value) })}
          />
        </Field>
        <Field
          label="پوشهٔ مقصد"
          hint="خالی بگذارید تا از مسیر پیش‌فرض سرور استفاده شود. ترجیحاً یک درایو دیگر یا حافظهٔ خارجی."
        >
          <input
            dir="ltr"
            className={inputClass}
            value={config.directory}
            onChange={(e) => setConfig({ ...config, directory: e.target.value })}
            placeholder="D:\pos-backups"
          />
        </Field>

        {/* A local-only install has no cloud half at all — see the note below. */}
        {!localOnly ? (
          <>
            <div className="mb-4 mt-6 border-t pt-4">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={cloud.enabled}
                  onChange={(e) => setCloud({ enabled: e.target.checked })}
                />
                پشتیبان ابری (خارج از محل) فعال باشد
              </label>
              <p className="mt-1 text-xs text-muted-foreground">
                هر فضای سازگار با S3 — مثل آروان‌کلاد، Backblaze B2 یا MinIO روی NAS.
              </p>
            </div>

            <Field label="نشانی سرویس (Endpoint)" hint="مثلاً https://s3.ir-thr-at1.arvanstorage.ir">
              <input
                dir="ltr"
                className={inputClass}
                value={cloud.endpoint}
                onChange={(e) => setCloud({ endpoint: e.target.value })}
                placeholder="https://…"
              />
            </Field>
            <div className="grid gap-x-4 sm:grid-cols-2">
              <Field label="باکت (Bucket)">
                <input dir="ltr" className={inputClass} value={cloud.bucket} onChange={(e) => setCloud({ bucket: e.target.value })} />
              </Field>
              <Field label="ناحیه (Region)">
                <input dir="ltr" className={inputClass} value={cloud.region} onChange={(e) => setCloud({ region: e.target.value })} />
              </Field>
              <Field label="کلید دسترسی (Access Key)">
                <input dir="ltr" className={inputClass} value={cloud.accessKeyId} onChange={(e) => setCloud({ accessKeyId: e.target.value })} />
              </Field>
              <Field label="کلید محرمانه (Secret Key)" hint={cloud.hasSecretAccessKey ? "ذخیره شده — برای تغییر، مقدار جدید وارد کنید" : undefined}>
                <input
                  dir="ltr"
                  type="password"
                  className={inputClass}
                  value={cloud.secretAccessKey}
                  onChange={(e) => setCloud({ secretAccessKey: e.target.value })}
                  placeholder={cloud.hasSecretAccessKey ? "••••••••" : ""}
                />
              </Field>
              <Field label="پیشوند مسیر (Prefix)">
                <input dir="ltr" className={inputClass} value={cloud.prefix} onChange={(e) => setCloud({ prefix: e.target.value })} />
              </Field>
              <Field label="تعداد نسخه‌های ابری نگه‌داشته‌شده">
                <PersianNumberInput
                  dir="ltr"
                  className={inputClass}
                  value={cloud.retention}
                  onChange={(e) => setCloud({ retention: Number(e.target.value) })}
                />
              </Field>
            </div>
          </>
        ) : null}
        
        <div className="mt-8 pt-6 border-t">
          <h3 className="mb-4 text-sm font-semibold text-foreground">رمزنگاری و امنیت (Encryption)</h3>
          
          <div className="mb-4">
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border text-amber-600 dark:text-amber-400 focus:ring-amber-500 dark:focus:ring-amber-400/45"
                checked={config.encryptLocal ?? true}
                onChange={(e) => setConfig({ ...config, encryptLocal: e.target.checked })}
              />
              <span className="text-sm font-medium text-foreground">
                رمزنگاری نسخه‌های محلی و USB
              </span>
            </label>
            <p className="mt-1 text-xs text-muted-foreground pr-7">
              در صورت غیرفعال بودن، نسخه‌های محلی بدون رمزنگاری (Plaintext) ذخیره می‌شوند.
            </p>
          </div>
          
          <Field
            label="عبارت عبور رمزنگاری"
            hint={
              config.hasPassphrase || config.cloud.hasPassphrase
                ? "ذخیره شده — برای تغییر، مقدار جدید وارد کنید. بدون این عبارت، نسخه‌های پشتیبان (ابری و محلی) قابل بازگردانی نیستند."
                : "دست‌کم ۸ نویسه. بدون این عبارت، نسخه‌های پشتیبان (ابری و محلی) قابل بازگردانی نیستند — جای امنی نگه دارید."
            }
          >
            <input
              dir="ltr"
              type="password"
              className={inputClass}
              value={config.passphrase ?? config.cloud.passphrase ?? ""}
              onChange={(e) => setConfig({ ...config, passphrase: e.target.value })}
              placeholder={config.hasPassphrase || config.cloud.hasPassphrase ? "••••••••" : ""}
            />
          </Field>
        </div>

        {localOnly ? (
          <p className="mb-4 rounded-lg border border-input bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            این نصب محلی است؛ پشتیبان‌گیری ابری در دسترس نیست. نسخه‌های پشتیبان روی همین دستگاه
            ساخته و نگهداری می‌شوند.
          </p>
        ) : null}

        <PrimaryButton disabled={busy}>ذخیره</PrimaryButton>
      </form>
    </SectionCard>
  );
}
