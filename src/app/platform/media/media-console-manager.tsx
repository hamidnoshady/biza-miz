"use client";

/**
 * «رسانه و فایل‌ها» — the Superadmin console's media-storage panel (migration 0149 + 0234).
 *
 * Cards:
 *   ۱ وضعیت         — tenant/asset/byte counts across the platform.
 *   ۲ اتصال         — S3/Parspack connection (blocks direct endpoint/bucket/prefix
 *                     overwrites when stored files exist — issue #926 P1.5).
 *   ۳ مهاجرت امن    — copy + count/byte_size/sha256 verification + atomic switch +
 *                     rollback without premature source object deletion.
 *   ۴ پایش orphan   — scheduled read-only orphan reconciliation scans + gated
 *                     manual cleanup behind explicit backup confirmation (issue #926 P1.7).
 *   ۵ تعرفه         — daily price policy, READ-ONLY here (Billing owns writes).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { tomanLabel } from "@/lib/platform-money";
import {
  api,
  Button,
  Card,
  ErrorBox,
  Field,
  InfoBox,
  inputClass,
  SkeletonRows,
  StatCard,
  useCan,
} from "../ui";

interface MaskedConfig {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  keyPrefix: string;
  accessKeyId: string;
  secretAccessKeySet: boolean;
  billingEnabled: boolean;
  dailyFlatRial: number;
  dailyPerGbRial: number;
  freeQuotaMb: number;
  enhanceModel: string;
  enhancePriceRial: number;
}

interface Usage {
  businesses: number;
  assets: number;
  bytes: number;
}

interface MigrationAuditItem {
  id: string;
  actorEmail: string;
  action: string;
  status: string;
  totalAssets: number;
  copiedAssets: number;
  verifiedAssets: number;
  totalBytes: number;
  errorDetail: string | null;
  /** The API calls this `createdAt`; the UI used to read a non-existent `startedAt`. */
  createdAt: string;
  completedAt: string | null;
}

interface OrphanScanItem {
  id: string;
  mode: string;
  status: string;
  scannedObjects: number;
  orphanCount: number;
  orphanBytes: number;
  /**
   * The API returns `youngSkipped` / `prefixSkipped`. The UI used to read
   * `youngSkippedCount` / `unscopedCount`, which do not exist — that mismatch is
   * where the literal `undefined` in the reconciliation row came from.
   */
  youngSkipped: number;
  prefixSkipped: number;
  deletedCount: number;
  oldestOrphanAt: string | null;
  sampleKeys: string[];
  errorDetail: string | null;
  createdAt: string;
}

interface ConnectionTestStep {
  id: string;
  label: string;
  ok: boolean;
  providerStatus: number | null;
  providerCode: string | null;
  detail: string | null;
}

interface ConnectionTestReport {
  ok: boolean;
  message: string;
  reference?: string;
  error?: string;
  steps: ConnectionTestStep[];
  capabilities?: {
    write: boolean;
    readBack: boolean;
    integrity: boolean;
    streamedUpload: boolean;
    delete: boolean;
  };
  leftoverKeys?: string[];
}

interface PreviousStorageSummary {
  endpoint: string;
  region: string;
  bucket: string;
  keyPrefix: string;
}

/**
 * Byte sizes, honestly. `Math.max(1, …)` used to floor an empty library to
 * «۱ کیلوبایت»; zero now reads as zero, and a sub-kilobyte value is shown in
 * bytes instead of being rounded up to 1 KB.
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return `${toPersianDigits(0)} بایت`;
  if (bytes < 1024) return `${toPersianDigits(Math.round(bytes))} بایت`;
  if (bytes < 1024 * 1024) return `${toPersianDigits(Number((bytes / 1024).toFixed(1)))} کیلوبایت`;
  if (bytes < 1024 * 1024 * 1024) return `${toPersianDigits(Number((bytes / (1024 * 1024)).toFixed(1)))} مگابایت`;
  return `${toPersianDigits(Number((bytes / (1024 * 1024 * 1024)).toFixed(2)))} گیگابایت`;
}

/**
 * Operator-facing Persian for the audit vocabulary. The raw codes
 * (`migration_completed`, `migration_started`, `config_saved`, `ok`, …) used to
 * be rendered verbatim into the console.
 */
const MIGRATION_ACTION_LABELS: Record<string, string> = {
  config_saved: "ذخیرهٔ تنظیمات اتصال",
  location_change_blocked: "تغییر مستقیم مسیر مسدود شد",
  migration_started: "آغاز مهاجرت",
  migration_verified: "راستی‌آزمایی مهاجرت",
  migration_completed: "پایان موفق مهاجرت",
  migration_failed: "مهاجرت ناموفق",
  migration_rolled_back: "بازگشت به فضای قبلی",
};

const STATUS_LABELS: Record<string, string> = {
  running: "در حال اجرا",
  verified: "راستی‌آزمایی‌شده",
  completed: "تکمیل‌شده",
  failed: "ناموفق",
  rolled_back: "بازگشت‌خورده",
  blocked: "مسدود",
  ok: "سالم",
  alert: "نیازمند بررسی",
  skipped: "انجام نشد",
  error: "خطا",
};

const ORPHAN_MODE_LABELS: Record<string, string> = {
  scheduled_scan: "اسکن خودکار دوره‌ای",
  manual_scan: "اسکن دستی (بدون حذف)",
  manual_cleanup: "پاک‌سازی دستی",
};

function actionLabel(action: string): string {
  return MIGRATION_ACTION_LABELS[action] ?? "رویداد ناشناخته";
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? "نامشخص";
}

/**
 * A `running` audit row is only "running" if the stored migration state agrees.
 * A row left behind by a crashed/restarted process would otherwise look like an
 * operation still in progress forever.
 */
function migrationStatusText(item: MigrationAuditItem, migrationState: string): string {
  if (item.status === "running") {
    return migrationState === "migrating"
      ? "در حال اجرا (فرایند فعال)"
      : "ناتمام — فرایند متوقف شده است (نیازمند بررسی)";
  }
  return statusLabel(item.status);
}

const ERRORS: Record<string, string> = {
  endpoint_required: "برای فعال‌سازی، آدرس سرویس S3 لازم است.",
  endpoint_invalid: "آدرس سرویس S3 معتبر نیست؛ نمونهٔ درست: https://s3.parspack.com",
  endpoint_insecure:
    "آدرس سرویس S3 باید با https باشد. آدرس http فقط برای سرویس محلی (localhost) یا همان آدرس ذخیره‌شدهٔ فعلی مجاز است.",
  bucket_required: "نام باکت لازم است.",
  credentials_required: "کلید دسترسی و کلید محرمانه هر دو لازم‌اند.",
  invalid_price: "مقادیر تعرفه باید عدد صفر یا بزرگ‌تر باشند.",
  invalid_mode: "نوع عملیات مشخص یا شناخته‌شده نیست؛ هیچ عملیاتی انجام نشد.",
  migration_in_progress: "یک فرایند مهاجرت دیگر در حال اجراست؛ تا پایان آن دوباره تلاش نکنید.",
  incomplete_config: "پیکربندی ذخیره‌سازی کامل نیست.",
  storage_disabled: "کتابخانهٔ رسانه برای کسب‌وکارها غیرفعال است.",
  storage_migration_required:
    "تغییر مستقیم آدرس، باکت یا پیشوند در حالی که فایل‌های ذخیره‌شده وجود دارند مسدود شده است. از بخش «مهاجرت امن و تأیید SHA-256» در پایین همین صفحه استفاده کنید.",
};

export function MediaConsoleManager() {
  const can = useCan();
  const canManage = can("media.manage");

  const [config, setConfig] = useState<MaskedConfig | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [canRollback, setCanRollback] = useState(false);
  const [previousStorage, setPreviousStorage] = useState<PreviousStorageSummary | null>(null);
  const [migrations, setMigrations] = useState<MigrationAuditItem[]>([]);
  const [orphanScans, setOrphanScans] = useState<OrphanScanItem[]>([]);
  const [secret, setSecret] = useState("");
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [testReport, setTestReport] = useState<ConnectionTestReport | null>(null);
  const [migrationState, setMigrationState] = useState("idle");
  const [loading, setLoading] = useState(true);
  /**
   * A load failure used to leave `config` null forever, so the page rendered its
   * skeleton rows with no error and no way out. The failure now has its own
   * state and a Retry button.
   */
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<{
      config: MaskedConfig;
      usage: Usage;
      canRollback?: boolean;
      previousStorage?: PreviousStorageSummary | null;
      migrations?: MigrationAuditItem[];
      orphanScans?: OrphanScanItem[];
      migrationState?: string;
    }>("/api/platform/media");
    setLoading(false);
    if (!ok) {
      setLoadError("خواندن تنظیمات فضای ذخیره‌سازی ناموفق بود. اتصال خود را بررسی کنید و دوباره تلاش کنید.");
      return;
    }
    setLoadError("");
    setConfig(data.config);
    setUsage(data.usage);
    setCanRollback(Boolean(data.canRollback));
    setPreviousStorage(data.previousStorage ?? null);
    setMigrations(data.migrations ?? []);
    setOrphanScans(data.orphanScans ?? []);
    setMigrationState(data.migrationState ?? "idle");
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  function patch(update: Partial<MaskedConfig>) {
    setConfig((c) => (c ? { ...c, ...update } : c));
  }

  async function save() {
    if (!config) return;
    setBusy(true);
    setError("");
    setNotice("");
    const body: Record<string, unknown> = {
      enabled: config.enabled,
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      keyPrefix: config.keyPrefix,
      accessKeyId: config.accessKeyId,
      enhanceModel: config.enhanceModel,
    };
    if (secret) body.secretAccessKey = secret;
    const { ok, data } = await api<{ config?: MaskedConfig; error?: string; message?: string }>("/api/platform/media", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!ok) {
      setError(data.message ?? ERRORS[data.error ?? ""] ?? "ذخیره ناموفق بود.");
      void load();
      return;
    }
    if (data.config) setConfig(data.config);
    setSecret("");
    setNotice("تنظیمات ذخیره شد.");
    void load();
  }

  async function testConnection() {
    setBusy(true);
    setTestReport(null);
    setError("");
    const { ok, data } = await api<{
      ok?: boolean;
      error?: string;
      message?: string;
      detail?: string;
      reference?: string;
      steps?: ConnectionTestStep[];
      capabilities?: ConnectionTestReport["capabilities"];
      leftoverKeys?: string[];
    }>("/api/platform/media/test", { method: "POST" });
    setBusy(false);

    // Every failure path gets a sentence: a code from the server, the console's
    // own dictionary, and — when neither exists — a generic line that still
    // carries the support reference. A missing `detail` must never render
    // "اتصال برقرار نشد: undefined".
    const message = data.message ?? (data.error ? ERRORS[data.error] : undefined) ?? "آزمایش اتصال ناموفق بود.";
    setTestReport({
      ok,
      message,
      reference: data.reference,
      error: data.error,
      steps: Array.isArray(data.steps) ? data.steps : [],
      capabilities: data.capabilities,
      leftoverKeys: data.leftoverKeys ?? [],
    });
  }

  async function runSafeMigration() {
    if (!config) return;
    if (
      !window.confirm(
        "همهٔ فایل‌های موجود در فضای مبدأ به مقصد جدید کپی و با اندازه و SHA-256 تک‌به‌تک راستی‌آزمایی می‌شوند و در صورت موفقیت، پیکربندی به‌صورت اتمی جابه‌جا می‌شود (بدون حذف فایل‌های مبدأ). ادامه می‌دهید؟",
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const body: Record<string, unknown> = {
      mode: "migrate",
      enabled: config.enabled,
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      keyPrefix: config.keyPrefix,
      accessKeyId: config.accessKeyId,
      enhanceModel: config.enhanceModel,
    };
    if (secret) body.secretAccessKey = secret;
    const { ok, data } = await api<{
      ok?: boolean;
      verifiedAssets?: number;
      copiedAssets?: number;
      message?: string;
    }>("/api/platform/media", {
      method: "POST",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!ok) {
      setError(data.message ?? "مهاجرت امن انجام نشد؛ پیکربندی قبلی دست‌نخورده باقی ماند.");
      void load();
      return;
    }
    setSecret("");
    setNotice(
      `مهاجرت امن با موفقیت تکمیل شد: ${toPersianDigits(data.copiedAssets ?? 0)} فایل کپی و ${toPersianDigits(data.verifiedAssets ?? 0)} فایل با SHA-256 تأیید شد.`,
    );
    void load();
  }

  async function runRollback() {
    if (!window.confirm("بازگشت اتمی به فضای ذخیره‌سازی قبلی انجام شود؟")) return;
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ verifiedAssets?: number; message?: string }>("/api/platform/media", {
      method: "POST",
      body: JSON.stringify({ mode: "rollback" }),
    });
    setBusy(false);
    if (!ok) {
      setError(data.message ?? "بازگشت به فضای قبلی ناموفق بود.");
      return;
    }
    setNotice(
      `بازگشت به فضای قبلی با موفقیت انجام شد (${toPersianDigits(data.verifiedAssets ?? 0)} فایل تأیید شد).`,
    );
    void load();
  }

  async function runOrphanScan(applyCleanup: boolean) {
    if (applyCleanup) {
      if (!backupConfirmed) {
        setError("ابتدا تیک تأیید پشتیبان‌گیری از باکت و پایگاه داده را فعال کنید.");
        return;
      }
      if (!window.confirm("فایل‌های بدون مرجع که از مهلت ایمنی عبور کرده‌اند حذف دائمی شوند؟")) {
        return;
      }
    }
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{
      scan?: OrphanScanItem;
      scans?: OrphanScanItem[];
      message?: string;
    }>("/api/platform/media", {
      method: "POST",
      body: JSON.stringify({ mode: "reconcile", apply: applyCleanup, backupConfirmed }),
    });
    setBusy(false);
    if (!ok || !data.scan) {
      setError(data.message ?? "پایش فایل‌های بدون مرجع ناموفق بود.");
      return;
    }
    setOrphanScans(data.scans ?? []);
    if (applyCleanup) {
      setBackupConfirmed(false);
      setNotice(`${toPersianDigits(data.scan.deletedCount)} فایل بدون مرجع حذف شد.`);
    } else {
      setNotice(
        `پایش بدون حذف انجام شد: ${toPersianDigits(data.scan.scannedObjects)} شیء بررسی شد و ${toPersianDigits(data.scan.orphanCount)} مورد بدون مرجع شناسایی شد.`,
      );
    }
  }

  if (!config) {
    return (
      <div className="space-y-4">
        <Card title="رسانه و فایل‌ها">
          {loadError ? (
            <>
              <ErrorBox>{loadError}</ErrorBox>
              <Button onClick={() => void load()} disabled={loading}>
                {loading ? "در حال تلاش…" : "تلاش دوباره"}
              </Button>
            </>
          ) : (
            <SkeletonRows rows={6} />
          )}
        </Card>
      </div>
    );
  }

  const latestScan = orphanScans[0] ?? null;
  const capabilitySummary = testReport?.capabilities
    ? [
        testReport.capabilities.write ? "نوشتن" : null,
        testReport.capabilities.readBack ? "خواندن مجدد" : null,
        testReport.capabilities.integrity ? "راستی‌آزمایی SHA-256" : null,
        testReport.capabilities.streamedUpload ? "بارگذاری جریانی بیش از ۱ مگابایت" : null,
        testReport.capabilities.delete ? "حذف" : null,
      ]
        .filter((item): item is string => Boolean(item))
        .join(" · ")
    : "";

  return (
    <div className="space-y-4">
      {/* ۱ — وضعیت */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="کسب‌وکارهای دارای فایل" value={toPersianDigits(usage?.businesses ?? 0)} />
        <StatCard label="تعداد فایل‌ها" value={toPersianDigits(usage?.assets ?? 0)} />
        <StatCard label="حجم کل ذخیره‌شده" value={usage ? formatBytes(usage.bytes) : "—"} />
      </div>

      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}
      {testReport ? (
        <div
          className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
            testReport.ok
              ? "border-primary/30 bg-primary/10 text-primary"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          }`}
        >
          <p className="font-medium">
            {testReport.ok ? "آزمایش اتصال موفق بود." : "آزمایش اتصال ناموفق بود."} {testReport.message}
          </p>
          {testReport.reference ? (
            <p className="mt-1 text-xs opacity-80">کد پیگیری: {testReport.reference}</p>
          ) : null}
          {capabilitySummary ? (
            <p className="mt-1 text-xs">قابلیت‌های تأییدشده: {capabilitySummary}</p>
          ) : null}
          {testReport.steps.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs">
              {testReport.steps.map((step) => (
                <li key={step.id} className="flex flex-wrap items-baseline gap-x-2">
                  <span aria-hidden={true}>{step.ok ? "✓" : "✗"}</span>
                  <span>{step.label}</span>
                  {!step.ok && (step.providerStatus || step.providerCode) ? (
                    <span className="opacity-80">
                      (پاسخ سرویس: {step.providerStatus ?? "—"}
                      {step.providerCode ? ` ${step.providerCode}` : ""})
                    </span>
                  ) : null}
                  {!step.ok && step.detail ? <span className="opacity-80">{step.detail}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {testReport.leftoverKeys && testReport.leftoverKeys.length > 0 ? (
            <p className="mt-2 text-xs">
              {toPersianDigits(testReport.leftoverKeys.length)} فایل آزمایشی در باکت باقی ماند و باید دستی حذف شود:
              <span dir="ltr" className="mx-1 font-mono">
                {testReport.leftoverKeys.join(", ")}
              </span>
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ۲ — اتصال */}
      <Card title="اتصال فضای ذخیره‌سازی (S3 سازگار — پارس‌پک، آروان، MinIO و …)">
        <label className="mb-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.enabled}
            disabled={!canManage}
            onChange={(e) => patch({ enabled: e.target.checked })}
            className="size-4"
          />
          کتابخانهٔ رسانه برای کسب‌وکارها فعال باشد
        </label>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="آدرس سرویس (Endpoint)">
            <input
              className={inputClass}
              dir="ltr"
              value={config.endpoint}
              disabled={!canManage}
              onChange={(e) => patch({ endpoint: e.target.value })}
              placeholder="https://s3.parspack.com"
            />
          </Field>
          <Field label="ناحیه (Region)">
            <input
              className={inputClass}
              dir="ltr"
              value={config.region}
              disabled={!canManage}
              onChange={(e) => patch({ region: e.target.value })}
            />
          </Field>
          <Field label="باکت (Bucket)">
            <input
              className={inputClass}
              dir="ltr"
              value={config.bucket}
              disabled={!canManage}
              onChange={(e) => patch({ bucket: e.target.value })}
            />
          </Field>
          <Field
            label="پیشوند کلیدها (Prefix)"
            hint="جداسازی مستأجرها داخل همین پیشوند با شناسهٔ کسب‌وکار انجام می‌شود؛ تغییر مستقیم آدرس، باکت یا پیشوند روی داده‌های موجود نیازمند مهاجرت امن است."
          >
            <input
              className={inputClass}
              dir="ltr"
              value={config.keyPrefix}
              disabled={!canManage}
              onChange={(e) => patch({ keyPrefix: e.target.value })}
            />
          </Field>
          <Field label="کلید دسترسی (Access Key)">
            <input
              className={inputClass}
              dir="ltr"
              value={config.accessKeyId}
              disabled={!canManage}
              onChange={(e) => patch({ accessKeyId: e.target.value })}
            />
          </Field>
          <Field
            label="کلید محرمانه (Secret Key)"
            hint={config.secretAccessKeySet ? "کلیدی ذخیره شده است؛ برای تعویض تایپ کنید." : "هنوز کلیدی ذخیره نشده است."}
          >
            <input
              className={inputClass}
              dir="ltr"
              type="password"
              value={secret}
              disabled={!canManage}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={config.secretAccessKeySet ? "••••••••" : ""}
            />
          </Field>
          <Field label="مدل ویرایش تصویر" hint="نام مدلی که درگاه هوش مصنوعی برای ویرایش تصویر می‌شناسد (اتصال فنی — قیمت آن در مرکز صورت‌حساب است)">
            <input
              className={inputClass}
              dir="ltr"
              value={config.enhanceModel}
              disabled={!canManage}
              onChange={(e) => patch({ enhanceModel: e.target.value })}
            />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={!canManage || busy}>
            {busy ? "در حال ذخیره…" : "ذخیرهٔ تنظیمات"}
          </Button>
          <Button variant="ghost" onClick={testConnection} disabled={!canManage || busy}>
            آزمایش اتصال
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          آزمایش اتصال همیشه روی تنظیمات <b>ذخیره‌شده</b> اجرا می‌شود (همان پیکربندی که درخواست‌های کسب‌وکارها
          می‌خوانند). اگر تغییری در فرم داده‌اید، ابتدا آن را ذخیره کنید. این آزمایش نوشتن، خواندن مجدد با
          راستی‌آزمایی SHA-256، بارگذاری جریانی بیش از ۱ مگابایت و حذف را بررسی می‌کند و هیچ فایلی در کتابخانهٔ
          رسانهٔ کسب‌وکارها نمی‌سازد.
        </p>
      </Card>

      {/* ۳ — مهاجرت امن و بازگشت */}
      <Card title="مهاجرت امن و تأیید SHA-256 (جابه‌جایی باکت یا پیشوند بدون قطعی)">
        <p className="mb-3 text-sm text-muted-foreground">
          هنگامی که فایل در سیستم ذخیره شده است، تغییر مستقیم آدرس، باکت یا پیشوند مسدود است تا هیچ فایلی یتیم یا غیرقابل‌دسترس نشود. ابتدا مقادیر مقصد جدید را در فرم بالا وارد کنید و سپس دکمهٔ زیر را بزنید تا همهٔ فایل‌ها کپی، اندازه و SHA-256 آن‌ها تک‌به‌تک راستی‌آزمایی، و پیکربندی با حفظ امکان بازگشت و خواندن دوگانه جابه‌جا شود.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={runSafeMigration} disabled={!canManage || busy}>
            {busy ? "در حال انجام…" : "مهاجرت امن و تأیید SHA-256"}
          </Button>
          {canRollback && previousStorage ? (
            <Button variant="ghost" onClick={runRollback} disabled={!canManage || busy}>
              بازگشت به مبدأ قبلی ({previousStorage.bucket})
            </Button>
          ) : null}
        </div>
        {migrations.length > 0 ? (
          <div className="mt-4 space-y-1.5 border-t border-border pt-3 text-xs">
            <p className="font-medium text-foreground">سوابق اخیر مهاجرت و تغییر پیکربندی:</p>
            {migrations.slice(0, 5).map((item) => (
              <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5">
                <span>
                  <b className="text-foreground">{actionLabel(item.action)}</b> · وضعیت:{" "}
                  <b>{migrationStatusText(item, migrationState)}</b>
                  {item.totalAssets > 0
                    ? ` · تأییدشده: ${toPersianDigits(item.verifiedAssets)} از ${toPersianDigits(item.totalAssets)}`
                    : ""}
                  {item.errorDetail ? (
                    <span className="block text-destructive">
                      جزئیات: <span dir="ltr">{item.errorDetail.slice(0, 200)}</span>
                    </span>
                  ) : null}
                </span>
                <span className="text-muted-foreground">
                  {item.actorEmail} · شروع: {formatJalali(item.createdAt)}
                  {item.completedAt ? ` · پایان: ${formatJalali(item.completedAt)}` : ""}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      {/* ۴ — پایش فایل‌های بدون مرجع (Orphan Reconciliation) */}
      <Card title="پایش دوره‌ای فایل‌های بدون مرجع (Orphan Reconciliation)">
        <p className="mb-3 text-sm text-muted-foreground">
          اسکن خودکار دوره‌ای فقط گزارش تهیه می‌کند و هرگز به‌صورت خودکار شیئی را حذف نمی‌کند. حذف دستی تنها پس از پشتیبان‌گیری و تأیید صریح ادمین پلتفرم انجام می‌شود.
        </p>
        {latestScan ? (
          <div className="mb-3 rounded-xl border border-border bg-muted/40 p-3 text-xs space-y-1">
            <p>
              آخرین گزارش ({formatJalali(latestScan.createdAt)}) — وضعیت: <b>{statusLabel(latestScan.status)}</b> (
              {ORPHAN_MODE_LABELS[latestScan.mode] ?? "حالت نامشخص"}) · اشیای بررسی‌شده:{" "}
              <b>{toPersianDigits(latestScan.scannedObjects ?? 0)}</b> · بدون مرجع واجد شرایط:{" "}
              <b>{toPersianDigits(latestScan.orphanCount ?? 0)}</b> ({formatBytes(latestScan.orphanBytes ?? 0)}) · ردشده در
              مهلت ایمنی: <b>{toPersianDigits(latestScan.youngSkipped ?? 0)}</b>
            </p>
            {(latestScan.deletedCount ?? 0) > 0 ? (
              <p>در این پاک‌سازی {toPersianDigits(latestScan.deletedCount)} فایل بدون مرجع حذف شد.</p>
            ) : null}
            {latestScan.oldestOrphanAt ? (
              <p className="text-muted-foreground">قدیمی‌ترین فایل بدون مرجع: {formatJalali(latestScan.oldestOrphanAt)}</p>
            ) : null}
            {(latestScan.prefixSkipped ?? 0) > 0 ? (
              <p className="text-destructive">
                هشدار: {toPersianDigits(latestScan.prefixSkipped)} کلید خارج از ساختار شناسهٔ کسب‌وکار مشاهده شد و هرگز
                خودکار حذف نمی‌شود.
              </p>
            ) : null}
            {latestScan.errorDetail ? (
              <p className="text-destructive">
                علت: <span dir="ltr">{latestScan.errorDetail.slice(0, 200)}</span>
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" onClick={() => void runOrphanScan(false)} disabled={!canManage || busy}>
            اجرای اسکن آزمایشی (بدون حذف)
          </Button>
          {latestScan && latestScan.orphanCount > 0 ? (
            <>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={backupConfirmed}
                  disabled={!canManage || busy}
                  onChange={(e) => setBackupConfirmed(e.target.checked)}
                  className="size-4"
                />
                از باکت و پایگاه داده پشتیبان تهیه کرده‌ام و حذف دائمی را تأیید می‌کنم
              </label>
              <Button
                onClick={() => void runOrphanScan(true)}
                disabled={!canManage || busy || !backupConfirmed}
              >
                پاک‌سازی دستی فایل‌های بدون مرجع ({toPersianDigits(latestScan.orphanCount)})
              </Button>
            </>
          ) : null}
        </div>
      </Card>

      {/* ۵ — تعرفه (read-only; Billing owns the write path) */}
      <Card title="تعرفهٔ نگهداری روزانه (فقط نمایش)">
        <p className="mb-4 text-sm text-muted-foreground">
          هزینهٔ نگهداری هر روز یک بار از کیف پول هر کسب‌وکاری که فایلی ذخیره کرده کسر می‌شود: یک مبلغ پایهٔ ثابت
          به‌علاوهٔ نرخ حجمی به‌ازای هر گیگابایت مازاد بر سهمیهٔ رایگان.
        </p>
        <div className="grid gap-x-4 text-sm sm:grid-cols-2">
          <p className="mb-3">
            وضعیت کسر روزانه: <b>{config.billingEnabled ? "فعال" : "غیرفعال"}</b>
          </p>
          <p className="mb-3">
            مبلغ پایهٔ روزانه: <b className="tabular-nums">{tomanLabel(config.dailyFlatRial)}</b>
          </p>
          <p className="mb-3">
            نرخ روزانهٔ هر گیگابایت: <b className="tabular-nums">{tomanLabel(config.dailyPerGbRial)}</b>
          </p>
          <p className="mb-3">
            سهمیهٔ رایگان: <b className="tabular-nums">{toPersianDigits(config.freeQuotaMb)} مگابایت</b>
          </p>
          <p className="mb-3">
            قیمت هر بهینه‌سازی تصویر محصول: <b className="tabular-nums">{tomanLabel(config.enhancePriceRial)}</b>
          </p>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          تعرفه‌ها فقط از <Link href="/platform/billing?tab=usage" className="underline">مرکز صورت‌حساب ← تعرفه مصرف و اعتبار</Link> تغییر می‌کنند.
        </p>
      </Card>
    </div>
  );
}
