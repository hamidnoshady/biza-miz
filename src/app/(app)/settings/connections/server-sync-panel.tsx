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

interface SyncHealthView {
  level: "ok" | "warning" | "error";
  issues: Array<{
    code:
      | "sync_disabled"
      | "backlog_stale"
      | "backlog_growing"
      | "events_refused"
      | "dead_letters"
      | "master_conflicts"
      | "drift"
      | "no_recent_contact";
    level: "warning" | "error";
  }>;
  unsent: number;
  oldestUnsentAt: string | null;
  refused: number;
  lastMasterSyncAt: string | null;
  nextAttemptAt: string | null;
  drift: {
    checkedAt: string | null;
    status: "ok" | "drift" | "pending" | "error" | null;
    days: Array<{
      day: string;
      site: { completedOrders: number } | null;
      cloud: { completedOrders: number } | null;
    }>;
  };
}

interface MasterConflictView {
  id: number;
  table: string;
  rowId: string;
  errorCode: string;
  attempts: number;
  lastSeenAt: string;
}

interface DomainDiagnostics {
  counts: {
    deferred: number;
    applied: number;
    deadLettered: number;
    openDeadLetters: number;
  };
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
    source: "domain" | "server_pull";
    remoteEventId: number | null;
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

interface ReplicationContractView {
  version: number;
  domains: Array<{
    domain: string;
    authority: string;
    direction: string;
    continuousSync: "active" | "bootstrap_only" | "not_replicated";
    eventCount: number;
  }>;
}

interface AppUpdateStatusView {
  checkedAt: string;
  installed?: { version: string; buildCommit: string; buildId: string; channel: "stable" | "beta" | "internal" };
  centralRuntime?: { releaseVersion: string | null; commitSha: string | null; buildId: string | null } | null;
  targetRelease?: { version: string; releaseNotes: string[] } | null;
  compliance?: string;
  // Present while an older packaged web runtime is completing an in-place update.
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  error: string | null;
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

const SYNC_STATUS_LABELS: Record<string, string> = {
  ok: "موفق",
  error: "ناموفق",
  skipped: "رد شده",
};

function StatusRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "error";
}) {
  return (
    <div className="flex items-center justify-between border-b border-border/60 py-2 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={
          tone === "error" ? "font-medium text-destructive" : "font-medium"
        }
      >
        {value}
      </span>
    </div>
  );
}

export function ServerSyncPanel() {
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [role, setRole] = useState<DeploymentRole>("site");
  const [resolvedRemoteUrl, setResolvedRemoteUrl] = useState("");
  const [pairedSite, setPairedSite] = useState<PairedSiteView | null>(null);
  const [syncState, setSyncState] = useState<StateView | null>(null);
  const [domainDiagnostics, setDomainDiagnostics] =
    useState<DomainDiagnostics | null>(null);
  const [replicationContract, setReplicationContract] =
    useState<ReplicationContractView | null>(null);
  const [appUpdateStatus, setAppUpdateStatus] =
    useState<AppUpdateStatusView | null>(null);
  const [health, setHealth] = useState<SyncHealthView | null>(null);
  const [masterConflicts, setMasterConflicts] = useState<MasterConflictView[]>([]);
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
      domainDiagnostics: DomainDiagnostics;
      replicationContract: ReplicationContractView;
      appUpdateStatus: AppUpdateStatusView | null;
      health: SyncHealthView | null;
      masterConflicts: MasterConflictView[];
      error?: string;
    }>("/api/server-sync/config");
    if (ok) {
      setConfig(data.config);
      setHealth(data.health ?? null);
      setMasterConflicts(data.masterConflicts ?? []);
      setRole(data.role ?? "site");
      setResolvedRemoteUrl(data.resolvedRemoteUrl ?? "");
      setPairedSite(data.pairedSite ?? null);
      setSyncState(data.syncState);
      setDomainDiagnostics(data.domainDiagnostics ?? null);
      setReplicationContract(data.replicationContract ?? null);
      setAppUpdateStatus(data.appUpdateStatus ?? null);
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
  const tokenParse =
    token && !isLegacySyncToken(token) ? parseSyncToken(token) : null;
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

    const { ok, data } = await api<{ error?: string }>(
      "/api/server-sync/config",
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error) || data.error || "خطای غیرمنتظره.");
      return;
    }
    setNotice("تنظیمات همگام‌سازی ذخیره شد.");
    await load();
  }

  async function reconcile(
    action: "retry-deferred" | "retry-dead-letter" | "discard-dead-letter",
    id?: number,
  ) {
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>(
      "/api/server-sync/reconcile",
      {
        method: "POST",
        body: JSON.stringify({ action, id }),
      },
    );
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
            نصب‌های محلی (مثلاً لپ‌تاپ شعبه) به این سرور همگام می‌شوند؛ خودِ این
            سرور به جایی همگام نمی‌شود، بنابراین آدرس و توکن اتصال اینجا تنظیم
            نمی‌شود. توکن هر نصب هنگام «جفت‌سازی» در کنسول مدیریت ساخته می‌شود.
          </p>
          <ErrorBox>{error}</ErrorBox>
          {pairedSite ? (
            <>
              <StatusRow
                label="دستگاه‌های فعال"
                value={toPersianDigits(String(pairedSite.deviceCount))}
              />
              <StatusRow
                label="شعبه‌های متصل"
                value={toPersianDigits(String(pairedSite.locationCount))}
              />
              <StatusRow
                label="آخرین چرخش اعتبارنامه"
                value={formatTime(pairedSite.tokenSetAt)}
              />
              <StatusRow
                label="آخرین ارتباط از نصب محلی"
                value={formatTime(pairedSite.lastSeenAt)}
              />
              <StatusRow
                label="وضعیت آخرین ارتباط"
                value={
                  SYNC_STATUS_LABELS[pairedSite.lastSeenStatus ?? ""] ?? "—"
                }
                tone={
                  pairedSite.lastSeenStatus === "error" ? "error" : undefined
                }
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
          domainDiagnostics={domainDiagnostics}
          replicationContract={replicationContract}
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
          این نصب (مثلاً لپ‌تاپ شعبه) با سرور مرکزی به‌صورت دوطرفه همگام می‌شود.
          توکن مشترک باید در هر دو سمت یکسان باشد.
        </p>
        <ErrorBox>{error}</ErrorBox>
        {notice ? <InfoBox>{notice}</InfoBox> : null}
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
            <Field
              label="آدرس سرور مرکزی"
              hint="این آدرس هنگام جفت‌سازی ثبت شده و نیازی به وارد کردن ندارد."
            >
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
          {config?.tokenFormat === "legacy" ? (
            <InfoBox>
              توکن فعلی با قالب قدیمی ساخته شده و همچنان کار می‌کند، اما قابل
              بازخوانی و تایپ نیست. در فرصت مناسب یک توکن جدید بسازید و همان را
              در سمت دیگر هم ثبت کنید.
            </InfoBox>
          ) : null}
          {generated ? (
            <InfoBox>
              <div className="space-y-2">
                <p>
                  این توکن فقط همین یک بار نمایش داده می‌شود. آن را کپی کنید، در
                  سمت دیگر ثبت کنید، سپس این فرم را ذخیره کنید.
                </p>
                <code
                  className="block rounded-lg bg-background/70 px-3 py-2 font-mono text-sm"
                  dir="ltr"
                >
                  {generated}
                </code>
                <SecondaryButton onClick={copyGenerated}>
                  {copied ? "کپی شد" : "کپی توکن"}
                </SecondaryButton>
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
                placeholder={
                  config?.token ? "برای حفظ توکن فعلی خالی بگذارید" : "POS1-…"
                }
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
              <span className="mt-1 block text-xs text-destructive">
                {errorMessage(tokenParse.error)}
              </span>
            ) : null}
          </Field>
          <Field label="تعداد رویداد در هر دسته">
            <PersianNumberInput
              className={inputClass}
              value={batchSize}
              onChange={(e) => setBatchSize(e.target.value)}
              dir="ltr"
            />
          </Field>
          <label className="mb-4 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            همگام‌سازی فعال باشد
          </label>
          <PrimaryButton disabled={busy || tokenInvalid}>
            {busy ? "در حال ذخیره…" : "ذخیره تنظیمات"}
          </PrimaryButton>
        </form>
      </SectionCard>

      {health ? <SyncHealthCard health={health} conflicts={masterConflicts} /> : null}

      <SyncStatusPanels
        syncState={syncState}
        appUpdateStatus={appUpdateStatus}
        domainDiagnostics={domainDiagnostics}
        replicationContract={replicationContract}
        busy={busy}
        onReconcile={reconcile}
      />
    </div>
  );
}

const HEALTH_ISSUE_LABELS: Record<SyncHealthView["issues"][number]["code"], string> = {
  sync_disabled: "همگام‌سازی خاموش است.",
  backlog_growing: "چند تغییر بیش از ۵ دقیقه است منتظر ارسال به سرور مرکزی مانده‌اند.",
  backlog_stale: "تغییراتی بیش از ۳۰ دقیقه است به سرور مرکزی نرسیده‌اند.",
  events_refused: "سرور مرکزی برخی تغییرات را نپذیرفته است؛ با فاصله‌ی بیشتر دوباره فرستاده می‌شوند.",
  dead_letters: "رویدادهایی کنار گذاشته شده‌اند و بررسی شما را لازم دارند (پایین همین صفحه).",
  master_conflicts: "برخی تغییرات مشتری یا منو ادغام نشدند (فهرست زیر).",
  drift: "جمع فروش یا دریافتی برخی روزها با سرور مرکزی یکی نیست.",
  no_recent_contact: "تغییرات منتظرند و مدتی است با سرور مرکزی تماس موفقی نبوده است.",
};

const HEALTH_LEVEL_TITLES: Record<SyncHealthView["level"], string> = {
  ok: "همگام‌سازی سالم است",
  warning: "همگام‌سازی نیاز به توجه دارد",
  error: "همگام‌سازی مشکل دارد",
};

const MASTER_TABLE_LABELS: Record<string, string> = {
  parties: "طرف‌حساب",
  party_categories: "دسته طرف‌حساب",
  payment_methods: "روش پرداخت",
  menu_categories: "دسته منو",
  menu_items: "آیتم منو",
  modifier_groups: "گروه افزودنی",
  modifiers: "افزودنی",
  inventory_items: "کالای انبار",
  dining_tables: "میز",
  menu_item_modifier_groups: "افزودنی آیتم منو",
  menu_item_ingredients: "دستور تهیه",
  modifier_ingredients: "مواد افزودنی",
};

const MASTER_CONFLICT_LABELS: Record<string, string> = {
  unique_violation: "نام یا کد تکراری در دو طرف",
  dependency_missing: "رکورد وابسته هنوز نرسیده است",
  delete_blocked: "حذف ممکن نبود؛ سابقه دارد",
};

/**
 * Migration 0190: the two questions an owner actually has — is it moving, and
 * do the desktop and the central server agree on the money.
 */
function SyncHealthCard({ health, conflicts }: { health: SyncHealthView; conflicts: MasterConflictView[] }) {
  const Box = health.level === "error" ? ErrorBox : InfoBox;
  return (
    <SectionCard title="سلامت همگام‌سازی">
      <div className="space-y-3">
        <Box>
          <p className="font-medium">{HEALTH_LEVEL_TITLES[health.level]}</p>
          {health.issues.length > 0 ? (
            <ul className="mt-1 list-disc ps-5 text-sm">
              {health.issues.map((issue) => (
                <li key={issue.code}>{HEALTH_ISSUE_LABELS[issue.code]}</li>
              ))}
            </ul>
          ) : null}
        </Box>
        <div>
          <StatusRow label="تغییرات در انتظار ارسال" value={toPersianDigits(String(health.unsent))} />
          <StatusRow label="قدیمی‌ترین تغییر ارسال‌نشده" value={health.oldestUnsentAt ? formatTime(health.oldestUnsentAt) : "—"} />
          <StatusRow
            label="تغییرات ردشده (در انتظار تلاش دوباره)"
            value={toPersianDigits(String(health.refused))}
            tone={health.refused > 0 ? "error" : undefined}
          />
          <StatusRow label="آخرین همگام‌سازی مشتری و منو" value={formatTime(health.lastMasterSyncAt)} />
          <StatusRow label="تلاش بعدی پس از خطا" value={health.nextAttemptAt ? formatTime(health.nextAttemptAt) : "—"} />
          <StatusRow
            label="مقایسه‌ی فروش با سرور مرکزی"
            value={
              health.drift.status === "ok"
                ? `یکسان (${formatTime(health.drift.checkedAt)})`
                : health.drift.status === "drift"
                  ? `${toPersianDigits(String(health.drift.days.length))} روز ناهمخوان`
                  : health.drift.status === "pending"
                    ? "پس از ارسال تغییرات در انتظار انجام می‌شود"
                    : health.drift.status === "error"
                      ? "انجام نشد — دوباره تلاش می‌شود"
                      : "هنوز انجام نشده"
            }
            tone={health.drift.status === "drift" ? "error" : undefined}
          />
        </div>
        {health.drift.status === "drift" && health.drift.days.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {health.drift.days.map((day) => (
              <li key={day.day} className="text-destructive">
                {toPersianDigits(formatJalali(day.day))}: این دستگاه{" "}
                {toPersianDigits(String(day.site?.completedOrders ?? 0))} صورت‌حساب، سرور مرکزی{" "}
                {toPersianDigits(String(day.cloud?.completedOrders ?? 0))} صورت‌حساب
              </li>
            ))}
          </ul>
        ) : null}
        {conflicts.length > 0 ? (
          <div>
            <p className="text-sm font-medium">ادغام‌نشده‌ها</p>
            <ul className="mt-1 space-y-1 text-sm">
              {conflicts.map((conflict) => (
                <li key={conflict.id}>
                  {MASTER_TABLE_LABELS[conflict.table] ?? conflict.table} —{" "}
                  {MASTER_CONFLICT_LABELS[conflict.errorCode] ?? "ادغام ممکن نبود"} ({formatTime(conflict.lastSeenAt)})
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </SectionCard>
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
  domainDiagnostics,
  replicationContract,
  busy,
  onReconcile,
}: {
  syncState: StateView | null;
  appUpdateStatus: AppUpdateStatusView | null;
  domainDiagnostics: DomainDiagnostics | null;
  replicationContract: ReplicationContractView | null;
  busy: boolean;
  onReconcile: (
    action: "retry-deferred" | "retry-dead-letter" | "discard-dead-letter",
    id?: number,
  ) => Promise<void>;
}) {
  return (
    <>
      {syncState ? (
        <SectionCard title="وضعیت همگام‌سازی">
          {syncState.legacyTokenLastUsedAt ? (
            <InfoBox>
              درخواست‌های ورودی هنوز با توکن مشترک قدیمی (REMOTE_SYNC_TOKEN)
              تأیید می‌شوند، نه توکن اختصاصی این کسب‌وکار — آخرین بار:{" "}
              {formatTime(syncState.legacyTokenLastUsedAt)}. برای امنیت بیشتر،
              توکن اختصاصی را تنظیم و به‌جای متغیر محیطی مشترک از آن استفاده
              کنید.
            </InfoBox>
          ) : null}
          <div className="grid gap-x-8 sm:grid-cols-2">
            <div>
              <h3 className="mb-1 text-sm font-medium text-muted-foreground">
                ارسال (Push)
              </h3>
              <StatusRow
                label="آخرین تلاش"
                value={formatTime(syncState.lastPushAttemptAt)}
              />
              <StatusRow
                label="آخرین موفقیت"
                value={formatTime(syncState.lastPushSuccessAt)}
              />
              <StatusRow
                label="آخرین خطا"
                value={syncState.lastPushError ?? "—"}
                tone={syncState.lastPushError ? "error" : undefined}
              />
            </div>
            <div>
              <h3 className="mb-1 text-sm font-medium text-muted-foreground">
                دریافت (Pull)
              </h3>
              <StatusRow
                label="آخرین تلاش"
                value={formatTime(syncState.lastPullAttemptAt)}
              />
              <StatusRow
                label="آخرین موفقیت"
                value={formatTime(syncState.lastPullSuccessAt)}
              />
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
        <SectionCard title="وضعیت انتشار دسکتاپ">
          <p className="mb-4 text-sm text-muted-foreground">
            نسخهٔ نصب‌شده، هدف انتشار دسکتاپ و ساختِ در حال اجرای سرور مرکزی سه
            هویت جدا هستند. برای دانلود و نصب امن به «تنظیمات ← دسکتاپ» بروید.
          </p>
          {appUpdateStatus.updateAvailable ? (
            <InfoBox>
              نسخهٔ دسکتاپ {appUpdateStatus.targetRelease?.version ?? appUpdateStatus.latestVersion} برای
              کانال این نصب در دسترس است. موتور به‌روزرسانی پیش از نصب، هش و امضای
              ویندوز را بررسی می‌کند و بدون پشتیبان تأییدشده ادامه نمی‌دهد.
            </InfoBox>
          ) : null}
          <StatusRow
            label="نسخهٔ دسکتاپ نصب‌شده"
            value={appUpdateStatus.installed?.version ?? appUpdateStatus.currentVersion ?? "—"}
          />
          <StatusRow
            label="هدف انتشار دسکتاپ"
            value={appUpdateStatus.targetRelease?.version ?? appUpdateStatus.latestVersion ?? "—"}
          />
          <StatusRow
            label="نسخهٔ انتشار سرور مرکزی"
            value={appUpdateStatus.centralRuntime?.releaseVersion ?? "—"}
          />
          <StatusRow
            label="ساخت سرور مرکزی"
            value={appUpdateStatus.centralRuntime?.commitSha ?? "—"}
          />
          <StatusRow
            label="آخرین بررسی"
            value={formatTime(appUpdateStatus.checkedAt)}
          />
          {appUpdateStatus.error ? (
            <StatusRow label="وضعیت گزارش" value="ارتباط با مرکز ناموفق بود" tone="error" />
          ) : null}
        </SectionCard>
      ) : null}

      {domainDiagnostics ? (
        <SectionCard title="آشتی‌سازی اثرهای مالی و موجودی">
          <p className="mb-3 text-sm text-muted-foreground">
            فقط شناسه، نوع، نسخه، کد خطا و هش محتوای رویداد نمایش داده می‌شود؛
            payload و اعتبارنامه‌ها هرگز در این صفحه برگردانده نمی‌شوند.
          </p>
          {replicationContract ? (
            <p className="mb-3 text-xs text-muted-foreground">
              قرارداد تکثیر نسخهٔ{" "}
              {toPersianDigits(String(replicationContract.version))}:{" "}
              {toPersianDigits(
                String(
                  replicationContract.domains.filter(
                    (domain) => domain.continuousSync === "active",
                  ).length,
                ),
              )}{" "}
              دامنه با همگام‌سازی پیوسته و{" "}
              {toPersianDigits(
                String(
                  replicationContract.domains.filter(
                    (domain) => domain.continuousSync === "bootstrap_only",
                  ).length,
                ),
              )}{" "}
              دامنه فقط با راه‌اندازی اولیه. جزئیات مالکیت، حذف و تلاش مجدد در
              مستندات قرارداد ثبت شده است.
            </p>
          ) : null}
          <div className="grid gap-x-8 sm:grid-cols-2">
            <div>
              <StatusRow
                label="اعمال‌شده"
                value={toPersianDigits(
                  String(domainDiagnostics.counts.applied),
                )}
              />
              <StatusRow
                label="در انتظار پیش‌نیاز"
                value={toPersianDigits(
                  String(domainDiagnostics.counts.deferred),
                )}
              />
            </div>
            <div>
              <StatusRow
                label="نامهٔ مرده"
                value={toPersianDigits(
                  String(domainDiagnostics.counts.deadLettered),
                )}
              />
              <StatusRow
                label="باز و نیازمند بررسی"
                value={toPersianDigits(
                  String(domainDiagnostics.counts.openDeadLetters),
                )}
              />
            </div>
          </div>
          <div className="mt-3">
            <SecondaryButton
              onClick={() => void onReconcile("retry-deferred")}
              disabled={busy || domainDiagnostics.counts.deferred === 0}
            >
              تلاش دوباره برای رویدادهای معوق
            </SecondaryButton>
          </div>
          {domainDiagnostics.recent.length > 0 ? (
            <div className="mt-4 overflow-hidden rounded-lg border">
              <div className="border-b bg-muted/30 px-3 py-2 text-xs font-semibold">
                آخرین اثرهای دامنه
              </div>
              {domainDiagnostics.recent.slice(0, 10).map((effect) => (
                <div
                  key={effect.clientEventId}
                  className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-xs last:border-b-0"
                >
                  <div className="min-w-0">
                    <span className="font-medium" dir="ltr">
                      {effect.eventType}@{effect.schemaVersion}
                    </span>
                    <span className="mr-2 text-muted-foreground" dir="ltr">
                      {effect.effectType
                        ? `${effect.effectType}:${effect.effectId ?? "—"}`
                        : (effect.errorCode ?? "—")}
                    </span>
                  </div>
                  <span
                    className={
                      effect.status === "applied"
                        ? "text-emerald-700 dark:text-emerald-300"
                        : effect.status === "deferred"
                          ? "text-amber-700 dark:text-amber-300"
                          : "text-destructive"
                    }
                  >
                    {effect.status === "applied"
                      ? "اعمال شد"
                      : effect.status === "deferred"
                        ? `معوق — تلاش ${toPersianDigits(String(effect.attempts))}`
                        : "نامهٔ مرده"}
                    {" — "}
                    {formatTime(effect.updatedAt)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {domainDiagnostics.deadLetters.length > 0 ? (
            <div className="mt-4 space-y-2">
              {domainDiagnostics.deadLetters
                .filter((letter) => letter.status === "open")
                .map((letter) => (
                  <div
                    key={letter.id}
                    className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium" dir="ltr">
                        {letter.eventType}@{letter.schemaVersion ?? "?"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatTime(letter.lastSeenAt)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-destructive" dir="ltr">
                      {letter.errorCode}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {letter.source === "server_pull"
                        ? `دریافت‌شده از سرور${letter.remoteEventId ? ` • رویداد ${toPersianDigits(String(letter.remoteEventId))}` : ""}`
                        : "اثر دامنه"}
                      {` • تلاش دوباره: ${toPersianDigits(String(letter.retryCount))}`}
                    </p>
                    <p
                      className="mt-1 break-all font-mono text-[11px] text-muted-foreground"
                      dir="ltr"
                    >
                      sha256:{letter.payloadSha256}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <SecondaryButton
                        onClick={() =>
                          void onReconcile("retry-dead-letter", letter.id)
                        }
                        disabled={busy}
                      >
                        تلاش دوباره
                      </SecondaryButton>
                      <SecondaryButton
                        onClick={() =>
                          void onReconcile("discard-dead-letter", letter.id)
                        }
                        disabled={busy}
                      >
                        بایگانی
                      </SecondaryButton>
                    </div>
                  </div>
                ))}
            </div>
          ) : null}
        </SectionCard>
      ) : null}
    </>
  );
}
