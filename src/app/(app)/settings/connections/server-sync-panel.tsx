"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useFeatureLocked } from "@/components/feature-lock";
/**
 * «سرور راه دور» — the «اتصال‌های فنی» hub's tab for the bidirectional
 * server-to-server sync (Phase 11): connects this server to a remote peer
 * (café laptop <-> VPS) and reuses the client offline-queue's idempotency
 * engine. Owner-only, gated by the `site_cloud_sync` feature; the old
 * «همگام‌سازی با سرور راه دور» settings tab redirects here.
 */
import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { isLegacySyncToken, parseSyncToken } from "@/lib/sync-token";
import {
  ErrorBox,
  Field,
  InfoBox,
  PrimaryButton,
  SecondaryButton,
  api,
  errorMessage,
  inputClass,
} from "@/app/dashboard/ui";
import { SectionCard } from "@/app/dashboard/page-chrome";

interface ConfigView {
  remoteUrl: string;
  /** masked preview, e.g. "a3f8…9d21" — never the real secret */
  token: string;
  /** null when no token is configured; "legacy" flags a pre-POS1 hex secret. */
  tokenFormat: "current" | "legacy" | null;
  enabled: boolean;
  batchSize?: number;
  siteDeviceId?: string;
  pairingPending?: boolean;
}

type DeploymentRole = "central" | "site";

interface PairedSiteView {
  tokenSetAt: string;
  lastSeenAt: string | null;
  lastSeenStatus: "ok" | "error" | "skipped" | null;
  deviceCount: number;
  locationCount: number;
}

interface StateView {
  lastPushedEventId: number | null;
  lastPulledEventId: number | null;
  lastPushAttemptAt: string | null;
  lastPullAttemptAt: string | null;
  lastPushSuccessAt: string | null;
  lastPullSuccessAt: string | null;
  lastPushError: string | null;
  lastPullError: string | null;
  legacyTokenLastUsedAt: string | null;
}

interface DeadLetter {
  id: number;
  remoteEventId: number;
  locationId: string;
  clientEventId: string;
  eventType: string;
  error: string;
  createdAt: string;
}

interface SyncRunView {
  id: string;
  siteDeviceId: string | null;
  locationId: string | null;
  direction: "push" | "pull" | "activation";
  status: "running" | "ok" | "error" | "skipped";
  startedAt: string;
  eventsAttempted: number;
  eventsApplied: number;
  eventsDeferred: number;
  eventsConflicted: number;
  eventsDeadLettered: number;
  errorCode: string | null;
}

interface DomainDiagnostics {
  counts: { deferred: number; applied: number; deadLettered: number; openDeadLetters: number };
  recent: Array<{
    clientEventId: string;
    eventType: string;
    schemaVersion: number;
    status: "deferred" | "applied" | "dead_lettered";
    effectType: string | null;
    effectId: string | null;
    errorCode: string | null;
    attempts: number;
    updatedAt: string;
  }>;
  deadLetters: Array<{
    id: number;
    clientEventId: string;
    eventType: string;
    schemaVersion: number | null;
    payloadSha256: string;
    errorCode: string;
    status: "open" | "resolved" | "discarded";
    retryCount: number;
    lastSeenAt: string;
  }>;
}

interface ReplicationDomainView {
  key: string;
  label: string;
  authority: "cloud_authoritative" | "site_authoritative" | "bidirectional" | "site_local" | "cloud_only";
  bootstrap: "snapshot" | "identity_only" | "none";
  eventTypes: string[];
  notes: string;
}

interface AppUpdateStatusView {
  checkedAt: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  error: string | null;
}

function formatTime(iso: string | null): string {
  if (!iso) return "هرگز";
  // Jalali presentation is centralised in the platform formatter. Do not pin
  // an arbitrary Tehran timezone in a sync screen: installations may use the
  // business timezone configured at pairing time.
  const time = new Intl.DateTimeFormat("fa-IR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
  return `${toPersianDigits(formatJalali(iso))} ${time}`;
}

const SYNC_STATUS_LABELS: Record<string, string> = {
  ok: "موفق",
  error: "ناموفق",
  skipped: "رد شده",
};

function StatusRow({ label, value, tone }: { label: string; value: string; tone?: "error" }) {
  return (
    <div className="flex items-center justify-between border-b border-border/60 py-2 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={tone === "error" ? "font-medium text-destructive" : "font-medium"}>{value}</span>
    </div>
  );
}

export function ServerSyncPanel() {
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [role, setRole] = useState<DeploymentRole>("site");
  const [resolvedRemoteUrl, setResolvedRemoteUrl] = useState("");
  const [pairedSite, setPairedSite] = useState<PairedSiteView | null>(null);
  const [syncState, setSyncState] = useState<StateView | null>(null);
  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>([]);
  const [domainDiagnostics, setDomainDiagnostics] = useState<DomainDiagnostics | null>(null);
  const [syncRuns, setSyncRuns] = useState<SyncRunView[]>([]);
  const [appUpdateStatus, setAppUpdateStatus] = useState<AppUpdateStatusView | null>(null);
  const [replicationCatalogue, setReplicationCatalogue] = useState<ReplicationDomainView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [remoteUrl, setRemoteUrl] = useState("");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [batchSize, setBatchSize] = useState("100");
  /** A freshly generated token, shown in full exactly once so it can be copied. */
  const [generated, setGenerated] = useState("");
  const [copied, setCopied] = useState(false);
  /** The genuinely-moved-VPS case: the derived address is wrong and must be typed. */
  const [overriding, setOverriding] = useState(false);
  const locked = useFeatureLocked();

  const load = useCallback(async () => {
    // Locked preview: /api/server-sync/* answers `feature_disabled` without
    // `site_cloud_sync`, so asking would only paint the preview with a load
    // error. The empty form underneath is the preview.
    if (locked) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const { ok, data } = await api<{
      config: ConfigView | null;
      role: DeploymentRole;
      resolvedRemoteUrl: string;
      pairedSite: PairedSiteView | null;
      syncState: StateView;
      deadLetters: DeadLetter[];
      domainDiagnostics: DomainDiagnostics;
      syncRuns: SyncRunView[];
      appUpdateStatus: AppUpdateStatusView | null;
      replicationCatalogue: ReplicationDomainView[];
      error?: string;
    }>("/api/server-sync/config");
    if (ok) {
      setConfig(data.config);
      setRole(data.role ?? "site");
      setResolvedRemoteUrl(data.resolvedRemoteUrl ?? "");
      setPairedSite(data.pairedSite ?? null);
      setSyncState(data.syncState);
      setDeadLetters(data.deadLetters ?? []);
      setDomainDiagnostics(data.domainDiagnostics ?? null);
      setSyncRuns(data.syncRuns ?? []);
      setAppUpdateStatus(data.appUpdateStatus ?? null);
      setReplicationCatalogue(data.replicationCatalogue ?? []);
      setRemoteUrl(data.config?.remoteUrl ?? "");
      setOverriding(false);
      setEnabled(data.config?.enabled ?? false);
      setBatchSize(String(data.config?.batchSize ?? 100));
      setToken("");
      setError("");
      setCopied(false);
    } else {
      setError(errorMessage(data.error));
    }
    setLoading(false);
  }, [locked]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The same check the server runs, run here first: catching a mistyped token
   * at the input is the entire reason the format has a checksum. Legacy hex
   * secrets bypass it exactly as they do server-side.
   */
  const tokenParse = token && !isLegacySyncToken(token) ? parseSyncToken(token) : null;
  const tokenInvalid = tokenParse !== null && !tokenParse.ok;

  async function generateToken() {
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ token?: string; error?: string }>(
      "/api/server-sync/config/generate-token",
      { method: "POST" },
    );
    setBusy(false);
    if (!ok || !data.token) {
      setError(errorMessage(data.error));
      return;
    }
    // Prefilled into the field as well as shown in full: the owner still has
    // to press save, so generating never rotates the live token by itself.
    setGenerated(data.token);
    setToken(data.token);
    setCopied(false);
  }

  async function copyGenerated() {
    try {
      await navigator.clipboard.writeText(generated);
      setCopied(true);
    } catch {
      setError("کپی خودکار ممکن نشد؛ توکن را دستی انتخاب و کپی کنید.");
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (tokenParse && !tokenParse.ok) {
      setError(errorMessage(tokenParse.error));
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const body: Record<string, unknown> = {
      // Send the derived address unless the owner opened the override: an
      // install whose URL came from PLATFORM_BASE_URL rather than from
      // pairing has nothing stored yet, and saving is what persists it.
      remoteUrl: overriding ? remoteUrl : resolvedRemoteUrl,
      enabled,
      batchSize: Number(batchSize),
    };
    // Only send `token` when the owner actually typed a new one — the server
    // keeps the existing token otherwise (see resolveConfigUpdate).
    if (token) body.token = token;

    const { ok, data } = await api<{ error?: string }>("/api/server-sync/config", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error) || data.error || "خطای غیرمنتظره.");
      return;
    }
    setNotice("تنظیمات همگام‌سازی ذخیره شد.");
    await load();
  }

  async function reconcile(action: "retry-deferred" | "retry-dead-letter" | "discard-dead-letter", id?: number) {
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>("/api/server-sync/reconcile", {
      method: "POST",
      body: JSON.stringify({ action, id }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice("عملیات آشتی‌سازی انجام شد.");
    await load();
  }

  if (loading) {
    return <LoadingSkeleton rows={3} />;
  }

  // A central server is the thing sites sync *to* — it has no peer of its own
  // and PUT refuses to give it one, so the connection form is replaced by what
  // it can actually say: which site is paired to this business.
  if (role === "central") {
    return (
      <div className="space-y-6">
        <SectionCard title="این سرور، سرور مرکزی است">
          <p className="mb-4 text-sm text-muted-foreground">
            نصب‌های محلی (مثلاً لپ‌تاپ شعبه) به این سرور همگام می‌شوند؛ خودِ این سرور به جایی همگام نمی‌شود، بنابراین
            آدرس و توکن اتصال اینجا تنظیم نمی‌شود. توکن هر نصب هنگام «جفت‌سازی» در کنسول مدیریت ساخته می‌شود.
          </p>
          <ErrorBox>{error}</ErrorBox>
          {pairedSite ? (
            <>
              <StatusRow label="دستگاه‌های فعال" value={toPersianDigits(String(pairedSite.deviceCount))} />
              <StatusRow label="شعبه‌های متصل" value={toPersianDigits(String(pairedSite.locationCount))} />
              <StatusRow label="آخرین چرخش اعتبارنامه" value={formatTime(pairedSite.tokenSetAt)} />
              <StatusRow label="آخرین ارتباط از نصب محلی" value={formatTime(pairedSite.lastSeenAt)} />
              <StatusRow
                label="وضعیت آخرین ارتباط"
                value={SYNC_STATUS_LABELS[pairedSite.lastSeenStatus ?? ""] ?? "—"}
                tone={pairedSite.lastSeenStatus === "error" ? "error" : undefined}
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              هنوز نصب محلی‌ای به این کسب‌وکار جفت نشده است.
            </p>
          )}
        </SectionCard>

        <SyncStatusPanels
          syncState={syncState}
          appUpdateStatus={appUpdateStatus}
          replicationCatalogue={replicationCatalogue}
          deadLetters={deadLetters}
          domainDiagnostics={domainDiagnostics}
          syncRuns={syncRuns}
          busy={busy}
          onReconcile={reconcile}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionCard title="اتصال به سرور مرکزی">
        <p className="mb-4 text-sm text-muted-foreground">
          این نصب (مثلاً لپ‌تاپ شعبه) با سرور مرکزی به‌صورت دوطرفه همگام می‌شود. توکن مشترک باید در هر دو سمت یکسان
          باشد.
        </p>
        <ErrorBox>{error}</ErrorBox>
        {notice ? <InfoBox>{notice}</InfoBox> : null}
        {config?.pairingPending ? (
          <InfoBox>دادهٔ اولیه روی این دستگاه ثبت شده است و فعال‌سازی امن در حال تلاش دوباره است. تا تأیید ابری، همگام‌سازی زنده شروع نمی‌شود.</InfoBox>
        ) : null}
        {config?.siteDeviceId ? (
          <InfoBox>این نصب با کد اتصال جفت شده است؛ آدرس و اعتبارنامهٔ اختصاصی آن خودکار مدیریت می‌شود. فقط در بازیابی پیشرفته، تنظیم دستی لازم است.</InfoBox>
        ) : null}
        <form onSubmit={save}>
          {overriding ? (
            <Field
              label="آدرس سرور مرکزی"
              hint="فقط در صورتی تغییر دهید که سرور مرکزی واقعاً جابه‌جا شده باشد."
            >
              <input
                className={inputClass}
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
                placeholder="https://pos.eshobe.com"
                dir="ltr"
              />
            </Field>
          ) : (
            <Field label="آدرس سرور مرکزی" hint="این آدرس هنگام جفت‌سازی ثبت شده و نیازی به وارد کردن ندارد.">
              <div className="flex items-center gap-2">
                <code
                  className="flex h-10 flex-1 items-center rounded-lg border border-input bg-muted/40 px-3 text-sm"
                  dir="ltr"
                >
                  {resolvedRemoteUrl || "—"}
                </code>
                <SecondaryButton
                  onClick={() => {
                    setRemoteUrl(resolvedRemoteUrl);
                    setOverriding(true);
                  }}
                >
                  تغییر آدرس
                </SecondaryButton>
              </div>
            </Field>
          )}
          {!config?.siteDeviceId ? (
            <>
          {config?.tokenFormat === "legacy" ? (
            <InfoBox>
              توکن فعلی با قالب قدیمی ساخته شده و همچنان کار می‌کند، اما قابل بازخوانی و تایپ نیست. در فرصت مناسب یک
              توکن جدید بسازید و همان را در سمت دیگر هم ثبت کنید.
            </InfoBox>
          ) : null}
          {generated ? (
            <InfoBox>
              <div className="space-y-2">
                <p>
                  این توکن فقط همین یک بار نمایش داده می‌شود. آن را کپی کنید، در سمت دیگر ثبت کنید، سپس این فرم را
                  ذخیره کنید.
                </p>
                <code className="block rounded-lg bg-background/70 px-3 py-2 font-mono text-sm" dir="ltr">
                  {generated}
                </code>
                <SecondaryButton onClick={copyGenerated}>{copied ? "کپی شد" : "کپی توکن"}</SecondaryButton>
              </div>
            </InfoBox>
          ) : null}
          <Field
            label="توکن مشترک"
            hint={
              tokenInvalid
                ? undefined
                : config?.token
                  ? `توکن فعلی: ${config.token} — برای تغییر، توکن جدید وارد کنید`
                  : "دکمهٔ «ساخت توکن» یک توکن معتبر می‌سازد؛ همان مقدار باید در سمت دیگر هم ثبت شود."
            }
          >
            <div className="flex items-center gap-2">
              <input
                className={inputClass}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={config?.token ? "برای حفظ توکن فعلی خالی بگذارید" : "POS1-…"}
                dir="ltr"
                type="text"
                autoComplete="off"
                spellCheck={false}
              />
              <SecondaryButton onClick={generateToken} disabled={busy}>
                ساخت توکن
              </SecondaryButton>
            </div>
            {tokenInvalid && tokenParse && !tokenParse.ok ? (
              <span className="mt-1 block text-xs text-destructive">{errorMessage(tokenParse.error)}</span>
            ) : null}
          </Field>
            </>
          ) : null}
          <Field label="تعداد رویداد در هر دسته">
            <PersianNumberInput
              className={inputClass}
              value={batchSize}
              onChange={(e) => setBatchSize(e.target.value)}
              dir="ltr"
            />
          </Field>
          <label className="mb-4 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            همگام‌سازی فعال باشد
          </label>
          <PrimaryButton disabled={busy || tokenInvalid}>{busy ? "در حال ذخیره…" : "ذخیره تنظیمات"}</PrimaryButton>
        </form>
      </SectionCard>

      <SyncStatusPanels
        syncState={syncState}
        appUpdateStatus={appUpdateStatus}
        replicationCatalogue={replicationCatalogue}
        deadLetters={deadLetters}
        domainDiagnostics={domainDiagnostics}
        syncRuns={syncRuns}
        busy={busy}
        onReconcile={reconcile}
      />
    </div>
  );
}

/**
 * Everything below the connection section, which both roles show: a central
 * server still pushes and pulls, still runs update checks, and still
 * dead-letters events it cannot apply.
 */
function SyncStatusPanels({
  syncState,
  appUpdateStatus,
  replicationCatalogue,
  deadLetters,
  domainDiagnostics,
  syncRuns,
  busy,
  onReconcile,
}: {
  syncState: StateView | null;
  appUpdateStatus: AppUpdateStatusView | null;
  replicationCatalogue: ReplicationDomainView[];
  deadLetters: DeadLetter[];
  domainDiagnostics: DomainDiagnostics | null;
  syncRuns: SyncRunView[];
  busy: boolean;
  onReconcile: (action: "retry-deferred" | "retry-dead-letter" | "discard-dead-letter", id?: number) => Promise<void>;
}) {
  return (
    <>
      {syncState ? (
        <SectionCard title="وضعیت همگام‌سازی">
          {syncState.legacyTokenLastUsedAt ? (
            <InfoBox>
              درخواست‌های ورودی هنوز با توکن مشترک قدیمی (REMOTE_SYNC_TOKEN) تأیید می‌شوند، نه توکن اختصاصی این
              کسب‌وکار — آخرین بار: {formatTime(syncState.legacyTokenLastUsedAt)}. برای امنیت بیشتر، توکن اختصاصی
              را تنظیم و به‌جای متغیر محیطی مشترک از آن استفاده کنید.
            </InfoBox>
          ) : null}
          <div className="grid gap-x-8 sm:grid-cols-2">
            <div>
              <h3 className="mb-1 text-sm font-medium text-muted-foreground">ارسال (Push)</h3>
              <StatusRow label="آخرین تلاش" value={formatTime(syncState.lastPushAttemptAt)} />
              <StatusRow label="آخرین موفقیت" value={formatTime(syncState.lastPushSuccessAt)} />
              <StatusRow
                label="آخرین خطا"
                value={syncState.lastPushError ?? "—"}
                tone={syncState.lastPushError ? "error" : undefined}
              />
            </div>
            <div>
              <h3 className="mb-1 text-sm font-medium text-muted-foreground">دریافت (Pull)</h3>
              <StatusRow label="آخرین تلاش" value={formatTime(syncState.lastPullAttemptAt)} />
              <StatusRow label="آخرین موفقیت" value={formatTime(syncState.lastPullSuccessAt)} />
              <StatusRow
                label="آخرین خطا"
                value={syncState.lastPullError ?? "—"}
                tone={syncState.lastPullError ? "error" : undefined}
              />
            </div>
          </div>
        </SectionCard>
      ) : null}

      {appUpdateStatus && appUpdateStatus.error !== "sync_not_configured" ? (
        <SectionCard title="به‌روزرسانی نرم‌افزار">
          <p className="mb-4 text-sm text-muted-foreground">
            نسخهٔ نصب‌شده روی این دستگاه در برابر نسخهٔ در حال اجرا روی سرور مرکزی. این فقط یک اعلان است — نصب نسخهٔ
            جدید خودکار نیست و باید توسط مدیر انجام شود.
          </p>
          {appUpdateStatus.updateAvailable ? (
            <InfoBox>
              نسخهٔ جدیدی در دسترس است ({appUpdateStatus.latestVersion}). قبل از نصب حتماً یک پشتیبان تهیه کنید،
              سپس نصب‌کنندهٔ جدید را از مدیر سیستم دریافت و اجرا نمایید. پس از نصب، از سالم بودن داده‌ها اطمینان
              حاصل کنید.
            </InfoBox>
          ) : null}
          <StatusRow label="نسخهٔ فعلی" value={appUpdateStatus.currentVersion || "—"} />
          <StatusRow label="آخرین نسخهٔ منتشرشده" value={appUpdateStatus.latestVersion ?? "—"} />
          <StatusRow label="آخرین بررسی" value={formatTime(appUpdateStatus.checkedAt)} />
          {appUpdateStatus.error ? <StatusRow label="خطا" value={appUpdateStatus.error} tone="error" /> : null}
        </SectionCard>
      ) : null}

      {domainDiagnostics ? (
        <SectionCard title="آشتی‌سازی اثرهای مالی و موجودی">
          <p className="mb-3 text-sm text-muted-foreground">
            فقط شناسه، نوع، نسخه، کد خطا و هش محتوای رویداد نمایش داده می‌شود؛ payload و اعتبارنامه‌ها هرگز در این
            صفحه برگردانده نمی‌شوند.
          </p>
          <div className="grid gap-x-8 sm:grid-cols-2">
            <div>
              <StatusRow label="اعمال‌شده" value={toPersianDigits(String(domainDiagnostics.counts.applied))} />
              <StatusRow label="در انتظار پیش‌نیاز" value={toPersianDigits(String(domainDiagnostics.counts.deferred))} />
            </div>
            <div>
              <StatusRow label="نامهٔ مرده" value={toPersianDigits(String(domainDiagnostics.counts.deadLettered))} />
              <StatusRow label="باز و نیازمند بررسی" value={toPersianDigits(String(domainDiagnostics.counts.openDeadLetters))} />
            </div>
          </div>
          <div className="mt-3">
            <SecondaryButton onClick={() => void onReconcile("retry-deferred")} disabled={busy || domainDiagnostics.counts.deferred === 0}>
              تلاش دوباره برای رویدادهای معوق
            </SecondaryButton>
          </div>
          {domainDiagnostics.recent.length > 0 ? (
            <div className="mt-4 overflow-hidden rounded-lg border">
              <div className="border-b bg-muted/30 px-3 py-2 text-xs font-semibold">آخرین اثرهای دامنه</div>
              {domainDiagnostics.recent.slice(0, 10).map((effect) => (
                <div key={effect.clientEventId} className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-xs last:border-b-0">
                  <div className="min-w-0">
                    <span className="font-medium" dir="ltr">{effect.eventType}@{effect.schemaVersion}</span>
                    <span className="mr-2 text-muted-foreground" dir="ltr">{effect.effectType ? `${effect.effectType}:${effect.effectId ?? "—"}` : effect.errorCode ?? "—"}</span>
                  </div>
                  <span className={effect.status === "applied" ? "text-emerald-700 dark:text-emerald-300" : effect.status === "deferred" ? "text-amber-700 dark:text-amber-300" : "text-destructive"}>
                    {effect.status === "applied" ? "اعمال شد" : effect.status === "deferred" ? `معوق — تلاش ${toPersianDigits(String(effect.attempts))}` : "نامهٔ مرده"}
                    {" — "}{formatTime(effect.updatedAt)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {domainDiagnostics.deadLetters.length > 0 ? (
            <div className="mt-4 space-y-2">
              {domainDiagnostics.deadLetters.filter((letter) => letter.status === "open").map((letter) => (
                <div key={letter.id} className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium" dir="ltr">{letter.eventType}@{letter.schemaVersion ?? "?"}</span>
                    <span className="text-xs text-muted-foreground">{formatTime(letter.lastSeenAt)}</span>
                  </div>
                  <p className="mt-1 text-xs text-destructive" dir="ltr">{letter.errorCode}</p>
                  <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground" dir="ltr">
                    sha256:{letter.payloadSha256}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <SecondaryButton onClick={() => void onReconcile("retry-dead-letter", letter.id)} disabled={busy}>
                      تلاش دوباره
                    </SecondaryButton>
                    <SecondaryButton onClick={() => void onReconcile("discard-dead-letter", letter.id)} disabled={busy}>
                      بایگانی
                    </SecondaryButton>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {syncRuns.length > 0 ? (
        <SectionCard title="آخرین اجراهای همگام‌سازی">
          <p className="mb-3 text-sm text-muted-foreground">هر ردیف یک اجرای مستقل برای همان دستگاه/شعبه است؛ شناسه و payload رویداد در این نمای پشتیبانی نمایش داده نمی‌شود.</p>
          <div className="space-y-2">
            {syncRuns.slice(0, 12).map((run) => (
              <div key={run.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-xs">
                <span dir="ltr" className="font-mono">{run.direction} · {run.status}</span>
                <span>تلاش: {toPersianDigits(String(run.eventsAttempted))} • اعمال: {toPersianDigits(String(run.eventsApplied))}</span>
                {run.errorCode ? <span dir="ltr" className="text-destructive">{run.errorCode}</span> : null}
                <span className="text-muted-foreground">{formatTime(run.startedAt)}</span>
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}

      {replicationCatalogue.length > 0 ? (
        <SectionCard title="پوشش همگام‌سازی">
          <p className="mb-3 text-sm text-muted-foreground">این فهرست از کاتالوگ مالکیت دادهٔ سرویس ساخته می‌شود؛ هر موردی که رویداد زنده ندارد، عمداً به‌عنوان دادهٔ اولیه، محلی یا ابری نمایش داده شده است.</p>
          <div className="space-y-2">
            {replicationCatalogue.map((domain) => (
              <div key={domain.key} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{domain.label}</span>
                  <code dir="ltr" className="text-xs text-muted-foreground">{domain.authority}</code>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{domain.notes}</p>
                <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground" dir="ltr">
                  {domain.eventTypes.length ? domain.eventTypes.join(", ") : `bootstrap:${domain.bootstrap}`}
                </p>
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title="رویدادهای ناموفق قدیمی">
        <p className="mb-4 text-sm text-muted-foreground">
          رویدادهایی که هنگام دریافت از سرور مرکزی اعمال نشدند و برای بررسی نگه داشته شده‌اند.
        </p>
        {deadLetters.length === 0 ? (
          <p className="text-sm text-muted-foreground">رویداد ناموفقی ثبت نشده است.</p>
        ) : (
          <div className="space-y-2">
            {deadLetters.map((dl) => (
              <div key={dl.id} className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{dl.eventType}</span>
                  <span className="text-xs text-muted-foreground">{formatTime(dl.createdAt)}</span>
                </div>
                <p className="mt-1 text-xs text-destructive">{dl.error}</p>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </>
  );
}
