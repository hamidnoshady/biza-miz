"use client";

/**
 * The console's whole-system backup panel (migration 0132).
 *
 * Five cards, in the order an operator needs them — and deliberately in the
 * order the danger increases:
 *
 *   ۱ سلامت    — the one-line answer to «کپی دیشب را داریم؟», plus «پشتیبان‌گیری فوری».
 *   ۲ تنظیمات   — schedule, retention, destinations, passphrase, cloud bucket.
 *   ۳ دسترسی   — which credentials may *pull* this server's backups (serving).
 *   ۴ بازیابی   — pick the artifact from anywhere it lives (this server's disk,
 *                the configured S3 bucket, a registered peer, or a direct URL),
 *                verify it in a scratch database, and only then replace this one.
 *   ۵ تاریخچه   — every run and every restore, with the artifact name verbatim so
 *                it can be pasted into `npm run db:restore` on a machine that has
 *                no console left to click.
 *
 * Secrets never come back from the server (`hasPassphrase` / `hasSecretAccessKey`
 * only), so the form writes "unchanged" rather than echoing a value: an empty
 * passphrase field keeps the stored one, and the explicit «پاک کردن» button is the
 * only way to clear it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Database,
  Download,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Unplug,
  Wand2,
} from "lucide-react";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { toPersianDigits } from "@/lib/digits";
// `BackupAlert` is a type-only import on purpose: `src/lib/backup.ts` and
// `src/lib/platform-backup.ts` both live in `node:crypto` territory (the AES-GCM
// envelope), and a *value* import of either into a client component fails the
// webpack build with "Reading from node:crypto is not handled by plugins". Which
// is also why the confirm phrase below is fetched rather than imported — the one
// string this page must show is the one string the server already answers with.
import type { BackupAlert } from "@/lib/backup";
import {
  api,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  fmtDate,
  InfoBox,
  inputClass,
  selectClass,
  SkeletonRows,
  StatCard,
  useCan,
} from "../ui";

interface Health {
  enabled: boolean;
  cloudEnabled: boolean;
  servingEnabled: boolean;
  intervalHours: number;
  anchorTime: string;
  timezone: string;
  localLastSuccessAt: string | null;
  localLastError: string | null;
  cloudLastSuccessAt: string | null;
  cloudLastError: string | null;
  alert: BackupAlert;
  artifactsOnDisk: number;
  newestArtifact: string | null;
}

interface Config {
  enabled: boolean;
  intervalHours: number;
  anchorTime: string;
  timezone: string;
  directory: string;
  secondaryDirectory: string;
  localRetention: number;
  encryptLocal: boolean;
  passphrase: string;
  hasPassphrase: boolean;
  servingEnabled: boolean;
  allowInsecurePeers: boolean;
  warnings?: string[];
  cloud: {
    enabled: boolean;
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    accessKeyId: string;
    secretAccessKey: string;
    hasSecretAccessKey: boolean;
    retention: number;
  };
}

interface RunRow {
  id: string;
  kind: "local" | "cloud";
  trigger: "scheduled" | "manual" | "peer";
  status: "running" | "success" | "failed";
  artifact: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  manifest: Record<string, unknown> | null;
}

interface ArtifactRow {
  artifact: string;
  kind: "local" | "cloud";
  sizeBytes: number | null;
  sha256: string | null;
  createdAt: string | null;
  encrypted: boolean;
  exists: boolean;
}

interface TokenRow {
  id: string;
  label: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  uses: number;
  expiresAt: string | null;
  revokedAt: string | null;
}

interface PeerRow {
  id: string;
  label: string;
  baseUrl: string;
  enabled: boolean;
  hasToken: boolean;
  tokenHint: string;
  lastCheckAt: string | null;
  lastCheckStatus: string | null;
  lastError: string | null;
  secure: boolean;
}

interface PeerArtifact {
  artifact: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  encrypted: boolean;
}

interface PeerManifest {
  app: string;
  version: string;
  databaseName: string;
  pgServerMajor: number;
  schemaMigrations: number;
  latestMigration: string;
  businessCount: number;
  artifacts: PeerArtifact[];
}

interface RestoreRun {
  id: string;
  source: string;
  artifact: string;
  mode: "verify" | "apply";
  status: "running" | "success" | "failed";
  summary: { migrations?: number; latestMigration?: string; tables?: { name: string; rows: number }[] } | null;
  error: string | null;
  startedAt: string;
}

const ALERT_LABELS: Record<string, string> = {
  ok: "سالم",
  disabled: "پشتیبان‌گیری خودکار غیرفعال است",
  local_failed: "آخرین پشتیبان‌گیری کل سیستم ناموفق بود",
  local_stale: "مدت زیادی از آخرین پشتیبان موفق گذشته است",
  cloud_failed: "آخرین بارگذاری در فضای ابری ناموفق بود",
  cloud_stale: "مدت زیادی از آخرین پشتیبان ابری موفق گذشته است",
};

const CODES: Record<string, string> = {
  backup_failed: "پشتیبان‌گیری ناموفق بود.",
  backup_busy: "یک پشتیبان‌گیری دیگر همین حالا در حال اجراست؛ صبر کنید و دوباره تلاش کنید.",
  restore_failed: "بازگردانی انجام نشد.",
  restore_busy: "یک بازگردانی دیگر در حال اجراست؛ کمی بعد دوباره تلاش کنید.",
  confirmation_required: "برای بازگردانی، عبارت تأیید را دقیق وارد کنید.",
  passphrase_required: "عبارت عبور رمزنگاری ذخیره نشده است؛ آن را وارد کنید.",
  decrypt_failed: "رمزگشایی نسخهٔ پشتیبان ناموفق بود — عبارت عبور را بررسی کنید.",
  checksum_mismatch: "کنترل جمع‌بندی فایل ناموفق بود؛ فایل دانلودشده همان نسخه نیست.",
  peer_unreachable: "سرور مقصر در دسترس نیست. آدرس و اتصال شبکه را بررسی کنید.",
  peer_auth_failed: "کلید این سرور در آن سمت رد شد (لغو یا منقضی شده باشد).",
  bad_manifest: "پاسخ سرور مقابل قابل خواندن نیست؛ ممکن است نسخهٔ قدیمی باشد.",
  newer_schema: "آن پشتیبان از نسخهٔ جدیدتری از برنامه گرفته شده؛ اول همین سرور را به‌روزرسانی کنید.",
  newer_postgres: "نسخهٔ Postgres سرور مقابل جدیدتر از این سرور است و pg_restore آن را نمی‌خواند.",
  no_artifacts: "سرور مقابل هیچ نسخهٔ پشتیبانی برای تبادل ندارد.",
  unknown_artifact: "این نسخه در فهرست سرور مقابل پیدا نشد.",
  no_backup_yet: "هنوز هیچ پشتیبانی روی این سرور گرفته نشده است.",
  https_required: "برای آدرس http باید «اجازهٔ اتصال ناامن» را در تنظیمات روشن کنید.",
  invalid_url: "آدرس نامعتبر است؛ آن را کامل با http:// یا https:// وارد کنید.",
  url_has_no_artifact_name: "بخش آخر آدرس باید نام یک فایل پشتیبان باشد.",
  artifact_url_mismatch: "نام فایل با آدرس واردشده هم‌خوانی ندارد.",
  artifact_too_large: "حجم فایل پشتیبان از حد مجاز این سرور بیشتر است.",
  peer_not_found: "این سرور ثبت نشده است.",
  peer_disabled: "این سرور غیرفعال است؛ ابتدا آن را فعال کنید.",
  missing_token: "برای این سرور کلید وارد نشده است.",
  missing_peer: "سرور مقابل را انتخاب کنید.",
  missing_label: "برای کلید یا سرور یک نام بنویسید.",
  not_this_app: "سرور مقابل نسخهٔ پشتیبان این برنامه را ارائه نمی‌کند.",
  missing_artifact: "نسخهٔ پشتیبان را انتخاب کنید.",
  artifact_not_found: "این فایل دیگر روی دیسک این سرور نیست.",
  cloud_not_configured: "اطلاعات فضای ابری برای این سرور تنظیم نشده است.",
  unsafe_artifact_name: "نام فایل پشتیبان معتبر نیست.",
  invalid_interval: "بازهٔ پشتیبان‌گیری نامعتبر است.",
  invalid_anchor_time: "ساعت پشتیبان‌گیری نامعتبر است.",
  invalid_timezone: "منطقهٔ زمانی معتبر نیست.",
  invalid_local_retention: "تعداد نگهداری نسخه‌ها باید بین ۱ تا ۳۶۵ باشد.",
  invalid_cloud_retention: "تعداد نگهداری نسخه‌های ابری باید بین ۱ تا ۳۶۵ باشد.",
  invalid_cloud_endpoint: "نشانی فضای ابری باید با http یا https شروع شود.",
  invalid_cloud_prefix: "پیشوند نباید با / شروع شود.",
  missing_cloud_bucket: "نام باکت را وارد کنید.",
  missing_cloud_credentials: "کلید دسترسی و کلید محرمانه هر دو لازم‌اند.",
  weak_passphrase: "عبارت عبور رمزنگاری باید دست‌کم ۸ نویسه باشد.",
  secondary_same_as_primary: "پوشهٔ دوم نباید همان پوشهٔ اول باشد.",
  invalid_expiry: "تعداد روزهای انقضا نامعتبر است.",
  // Issue #807: cloud artifact identity and SSRF refusals the server can
  // return now that a restore may name an object key or an external URL.
  blocked_address: "آدرس مقصد مجاز نیست (حلقهٔ محلی، شبکهٔ داخلی، آدرس ابری سرویس‌دهنده یا مشابه آن).",
  object_key_outside_prefix: "نام شیء بیرون از پیشوند فضای ابری تنظیم‌شده است.",
  artifact_key_mismatch: "نام فایل با کلید شیء انتخاب‌شده هم‌خوانی ندارد.",
  invalid_object_key: "کلید شیء فضای ابری نامعتبر است.",
  invalid_passphrase: "عبارت عبور نامعتبر است؛ نویسهٔ غیرمجاز دارد.",
  invalid_source: "منبع بازگردانی نامعتبر است.",
  invalid_redirect: "سرور مقصد به آدرس نامعتبری هدایت کرد.",
  too_many_redirects: "سرور مقصد بیش از حد مجاز هدایت کرد.",
  redirect_blocked_address: "سرور مقصد به آدرسی هدایت کرد که سیاست خروج اجازه نمی‌دهد.",
  dns_resolution_failed: "نام سرور مقصد قابل تبدیل به آدرس نیست.",
  credentials_in_url: "آدرس نباید نام کاربری یا رمز داشته باشد.",
  invalid_url_scheme: "آدرس باید با http:// یا https:// شروع شود.",
  url_fragment_not_allowed: "آدرس نباید بخش # داشته باشد.",
  missing_url: "آدرس بازگردانی را وارد کنید.",
  artifact_scope_mismatch: "این نسخهٔ پشتیبان به کسب‌وکار دیگری تعلق دارد و قابل استفاده نیست.",
  physical_tenant_backup_forbidden: "این سرور نسخهٔ فیزیکی «کل پایگاه‌داده» را به‌جای دادهٔ این کسب‌وکار ساخته است؛ عملیات متوقف شد.",
  physical_tenant_restore_forbidden: "بازگردانی نسخهٔ فیزیکی کسب‌وکار روی این سرور مجاز نیست.",
  platform_backup_not_available_on_site: "پشتیبان‌گیری کل سیستم فقط از کنسول مرکزی انجام می‌شود.",
  platform_backup_lock_unavailable: "یک عملیات پشتیبان‌گیری یا بازگردانی کل سیستم همین حالا در جریان است.",
  restore_lock_unavailable: "بازگردانی سرور مقصد همین حالا در حال اجراست.",
  restore_regrant_failed: "پس از بازگردانی، دسترسی نقش برنامه بازگردانده نشد و عملیات متوقف شد.",
  runtime_role_validation_failed: "پس از بازگردانی، بررسی خواندن با نقش برنامه ناموفق بود.",
  artifact_is_logical_snapshot: "این فایل نسخهٔ منطقی کسب‌وکار است، نه نسخهٔ فیزیکی کل پایگاه‌داده.",
};

function text(code: string | undefined, extra?: string): string {
  if (!code) return "خطای غیرمنتظره.";
  const known = CODES[code];
  if (known) return extra ? `${known} ${extra}` : known;
  // Server errors are often `code:detail` (e.g. `blocked_address:metadata` or
  // `restore_regrant_failed:permission denied`). Translate the head, keep the
  // machine detail for the operator's report.
  const separator = code.indexOf(":");
  if (separator > 0) {
    const head = CODES[code.slice(0, separator)];
    if (head) return `${head} (${code.slice(separator + 1)})`;
  }
  return extra ? `${code}: ${extra}` : code;
}

function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${toPersianDigits(n)} بایت`;
  const mb = n / (1024 * 1024);
  return `${toPersianDigits(mb < 10 ? mb.toFixed(1) : Math.round(mb).toString())} مگابایت`;
}

export function BackupManager() {
  const can = useCan();
  // Issue #807 split `backup.manage` into the capabilities each control actually
  // needs, so the page shows exactly what the signed-in role may do: a support
  // admin reads the health line, an engineer runs and verifies, and only an
  // owner reconfigures the destination, mints sharing tokens, manages peers or
  // applies a destructive restore.
  const canRun = can("backup.run") || can("backup.manage");
  const canVerify = can("backup.verify") || can("backup.manage");
  const canConfigure = can("backup.configure");
  const canShare = can("backup.share");
  const canPeerManage = can("backup.peer.manage");
  const canRestore = can("backup.restore");

  const [health, setHealth] = useState<Health | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [local, setLocal] = useState<ArtifactRow[]>([]);
  const [cloud, setCloud] = useState<ArtifactRow[]>([]);
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [restores, setRestores] = useState<RestoreRun[]>([]);
  // The restore form is a different card from the artifact list, so "restore
  // this one" only names the file; the form below owns the actual restore.
  const [presetArtifact, setPresetArtifact] = useState<string | null>(null);
  const consumePreset = useCallback(() => setPresetArtifact(null), []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmPhrase, setConfirmPhrase] = useState("");

  async function load() {
    const [status, cfg, tk, pr, phraseRes] = await Promise.all([
      api<{
        health?: Health;
        runs?: RunRow[];
        local?: ArtifactRow[];
        cloud?: ArtifactRow[];
        restores?: RestoreRun[];
      }>("/api/platform/backup/status"),
      api<{ config?: Config }>("/api/platform/backup/config"),
      api<{ tokens?: TokenRow[]; servingEnabled?: boolean }>("/api/platform/backup/tokens"),
      api<{ peers?: PeerRow[] }>("/api/platform/backup/peers"),
      api<{ confirmPhrase?: string }>("/api/platform/backup/restore"),
    ]);
    if (phraseRes.ok && phraseRes.data.confirmPhrase) setConfirmPhrase(phraseRes.data.confirmPhrase);
    if (status.ok && status.data.health) {
      setHealth(status.data.health);
      setRuns(status.data.runs ?? []);
      setLocal(status.data.local ?? []);
      setCloud(status.data.cloud ?? []);
      setRestores(status.data.restores ?? []);
      setError(null);
    } else {
      setError(text((status.data as { error?: string }).error));
    }
    if (cfg.ok && cfg.data.config) setConfig(cfg.data.config);
    if (tk.ok) setTokens(tk.data.tokens ?? []);
    if (pr.ok) setPeers(pr.data.peers ?? []);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function runNow() {
    setBusy("run");
    setNote(null);
    const res = await api<{ result?: { local: { status: string } } }>("/api/platform/backup/run", { method: "POST" });
    await load();
    setBusy(null);
    setNote(
      res.ok
        ? "نسخهٔ جدید از کل پایگاه‌داده گرفته شد."
        : text((res.data as { error?: string }).error, (res.data as { detail?: string }).detail),
    );
  }

  async function saveConfig(patch: Record<string, unknown>, key: string) {
    setBusy(key);
    const res = await api("/api/platform/backup/config", { method: "PUT", body: JSON.stringify(patch) });
    if (res.ok) {
      await load();
      setNote("تنظیمات ذخیره شد.");
    } else {
      setNote(text((res.data as { error?: string }).error));
    }
    setBusy(null);
  }

  const alertTone = health?.alert.level === "error" ? "bad" : health?.alert.level === "warning" ? "warn" : "ok";

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">پشتیبان‌گیری کامل سیستم</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            یک نسخه از تمام پایگاه‌داده — همهٔ کسب‌وکارها، تنظیمات پلت‌فرمن و خودِ ساختار —
            با زمان‌بندی خودتان؛ و بازیابی همان نسخه روی سروری دیگر، فقط با وارد کردن آدرس.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => void load()} disabled={busy !== null}>
            <RefreshCw className="me-1.5 h-4 w-4" />
            تازه‌سازی
          </Button>
          {canRun ? (
            <Button onClick={() => void runNow()} disabled={busy !== null}>
              {busy === "run" ? (
                <Loader2 className="me-1.5 h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <Wand2 className="me-1.5 h-4 w-4" />
              )}
              پشتیبان‌گیری فوری
            </Button>
          ) : null}
        </div>
      </div>

      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {note ? <InfoBox>{note}</InfoBox> : null}

      {loading || !health || !config ? (
        <Card>
          <SkeletonRows rows={4} label="در حال بارگذاری وضعیت پشتیبان‌گیری" />
        </Card>
      ) : (
        <>
          <HealthCard health={health} config={config} />

          {canConfigure ? (
            <ConfigCard
              config={config}
              busy={busy}
              onSave={(patch, key) => void saveConfig(patch, key)}
            />
          ) : null}

          {canShare ? (
            <ServingCard
              config={config}
              tokens={tokens}
              busy={busy}
              onSave={(patch, key) => void saveConfig(patch, key)}
              onReload={() => void load()}
            />
          ) : null}

          <RestoreCard
            peers={peers}
            local={local}
            cloud={cloud}
            canVerify={canVerify}
            canRestore={canRestore}
            canPeerManage={canPeerManage}
            confirmPhrase={confirmPhrase}
            busy={busy}
            setBusy={setBusy}
            presetArtifact={presetArtifact}
            onPresetConsumed={consumePreset}
            onReload={() => void load()}
          />

          <HistoryCard
            runs={runs}
            local={local}
            restores={restores}
            health={health}
            tone={alertTone}
            onPickLocal={setPresetArtifact}
            onChanged={() => void load()}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ۱ — health
// ---------------------------------------------------------------------------

function HealthCard({ health, config }: { health: Health; config: Config }) {
  const level = health.alert.level;
  const tone = level === "error" ? "bad" : level === "warning" ? "warn" : "ok";
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="وضعیت پشتیبان‌گیری کل سیستم"
        value={ALERT_LABELS[health.alert.reason] ?? ALERT_LABELS[level] ?? "—"}
        tone={tone}
        hint={
          level === "ok"
            ? `آخرین نسخه: ${fmtDate(health.localLastSuccessAt)}`
            : health.localLastError
              ? health.localLastError.slice(0, 120)
              : undefined
        }
        icon={<Database className="h-4 w-4" />}
      />
      <StatCard
        label="زمان‌بندی"
        value={health.enabled ? `هر ${toPersianDigits(health.intervalHours)} ساعت` : "غیرفعال"}
        tone={health.enabled ? "neutral" : "warn"}
        hint={
          health.enabled
            ? `ساعت ${toPersianDigits(health.anchorTime)} — ${health.timezone} · نگهداری ${toPersianDigits(
                config.localRetention,
              )} نسخه`
            : "برای فعال‌سازی به بخش تنظیمات بروید"
        }
      />
      <StatCard
        label="نسخه‌های قابل بازیابی روی دیسک"
        value={toPersianDigits(health.artifactsOnDisk)}
        hint={health.newestArtifact ? `تازه‌ترین: ${health.newestArtifact}` : "هنوز نسخه‌ای روی دیسک نیست"}
      />
      <StatCard
        label="ارسال به سرور دیگر"
        value={health.servingEnabled ? "فعال" : "خاموش"}
        tone={health.servingEnabled ? "warn" : "neutral"}
        hint={
          health.cloudEnabled
            ? "فضای ابری هم روشن است"
            : health.servingEnabled
              ? "هر سروری که کلید درست را داشته باشد می‌تواند بردارد"
              : "تا روشن نشود، هیچ آدرسی پاسخ نمی‌دهد"
        }
        icon={<ShieldAlert className="h-4 w-4" />}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ۲ — settings
// ---------------------------------------------------------------------------

const INTERVALS = [1, 2, 3, 4, 6, 8, 12, 24];

function ConfigCard({
  config,
  busy,
  onSave,
}: {
  config: Config;
  busy: string | null;
  onSave: (patch: Record<string, unknown>, key: string) => void;
}) {
  const [form, setForm] = useState(config);
  const [clearSecrets, setClearSecrets] = useState<{ passphrase: boolean; cloudSecret: boolean }>({
    passphrase: false,
    cloudSecret: false,
  });
  useEffect(() => setForm(config), [config]);

  const dirty =
    form.enabled !== config.enabled ||
    form.intervalHours !== config.intervalHours ||
    form.anchorTime !== config.anchorTime ||
    form.timezone !== config.timezone ||
    form.directory !== config.directory ||
    form.secondaryDirectory !== config.secondaryDirectory ||
    form.localRetention !== config.localRetention ||
    form.encryptLocal !== config.encryptLocal ||
    form.servingEnabled !== config.servingEnabled ||
    form.allowInsecurePeers !== config.allowInsecurePeers ||
    form.cloud.enabled !== config.cloud.enabled ||
    form.cloud.endpoint !== config.cloud.endpoint ||
    form.cloud.region !== config.cloud.region ||
    form.cloud.bucket !== config.cloud.bucket ||
    form.cloud.prefix !== config.cloud.prefix ||
    form.cloud.accessKeyId !== config.cloud.accessKeyId ||
    form.cloud.retention !== config.cloud.retention ||
    Boolean(form.passphrase) ||
    Boolean(form.cloud.secretAccessKey) ||
    clearSecrets.passphrase ||
    clearSecrets.cloudSecret;

  const patch = (): Record<string, unknown> => ({
    enabled: form.enabled,
    intervalHours: Number(form.intervalHours),
    anchorTime: form.anchorTime,
    timezone: form.timezone,
    directory: form.directory.trim(),
    secondaryDirectory: form.secondaryDirectory.trim(),
    localRetention: Number(form.localRetention),
    encryptLocal: form.encryptLocal,
    servingEnabled: form.servingEnabled,
    allowInsecurePeers: form.allowInsecurePeers,
    // An untouched secret is simply absent from the body, which the API reads as
    // "keep what is stored"; an explicit "" clears it.
    ...(form.passphrase ? { passphrase: form.passphrase } : clearSecrets.passphrase ? { passphrase: "" } : {}),
    cloud: {
      enabled: form.cloud.enabled,
      endpoint: form.cloud.endpoint.trim(),
      region: form.cloud.region.trim(),
      bucket: form.cloud.bucket.trim(),
      prefix: form.cloud.prefix.trim(),
      accessKeyId: form.cloud.accessKeyId.trim(),
      retention: Number(form.cloud.retention),
      ...(form.cloud.secretAccessKey
        ? { secretAccessKey: form.cloud.secretAccessKey }
        : clearSecrets.cloudSecret
          ? { secretAccessKey: "" }
          : {}),
    },
  });

  return (
    <Card title="تنظیمات پشتیبان‌گیری">
      {(config.warnings ?? []).length > 0 ? (
        <InfoBox>
          <ul className="list-inside list-disc space-y-1">
            {config.warnings!.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </InfoBox>
      ) : null}

      <div className="grid gap-x-4 gap-y-0 md:grid-cols-2">
        <div>
          <Toggle
            label="پشتیبان‌گیری خودکار از کل سیستم"
            checked={form.enabled}
            onChange={(v) => setForm({ ...form, enabled: v })}
          />
          <Field label="بازه (ساعت)">
            <select
              className={selectClass}
              value={String(form.intervalHours)}
              onChange={(e) => setForm({ ...form, intervalHours: Number(e.target.value) })}
            >
              {INTERVALS.map((h) => (
                <option key={h} value={h} className="bg-popover">
                  هر {toPersianDigits(h)} ساعت
                </option>
              ))}
            </select>
          </Field>
          <Field label="ساعت شروع (به وقت همان منطقه)" hint="مثلاً 03:30 یعنی هر شب، نیم ساعت پس از سه‌بام">
            <input className={inputClass} value={form.anchorTime} onChange={(e) => setForm({ ...form, anchorTime: e.target.value.trim() })} />
          </Field>
          <Field label="منطقهٔ زمانی" hint="نام IANA؛ مثل Asia/Tehran یا Europe/Berlin">
            <input className={inputClass} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value.trim() })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="نگهداری نسخه روی دیسک">
              <PersianNumberInput
                inputMode="numeric"
                allowDecimal={false}
                allowNegative={false}
                className={inputClass}
                value={String(form.localRetention)}
                onChange={(e) => setForm({ ...form, localRetention: Number(e.target.value) })}
              />
            </Field>
            <Field label="نگهداری نسخه در ابر">
              <PersianNumberInput
                inputMode="numeric"
                allowDecimal={false}
                allowNegative={false}
                className={inputClass}
                value={String(form.cloud.retention)}
                onChange={(e) => setForm({ ...form, cloud: { ...form.cloud, retention: Number(e.target.value) } })}
              />
            </Field>
          </div>
        </div>

        <div>
          <Field
            label="پوشهٔ مقصد"
            hint={
              config.directory
                ? "خالی بگذارید تا مسیر پیش‌فرض سرور استفاده شود"
                : "خالی = پوشهٔ backups/platform در کنار برنامه"
            }
          >
            <input
              className={inputClass}
              dir="ltr"
              placeholder="/mnt/nas/pos-platform"
              value={form.directory}
              onChange={(e) => setForm({ ...form, directory: e.target.value })}
            />
          </Field>
          <Field label="پوشهٔ دوم (USB یا NAS) — اختیاری" hint="کپی نشدن به آن، خودِ پشتیبان را ناموفق می‌کند">
            <input
              className={inputClass}
              dir="ltr"
              placeholder="/mnt/usb"
              value={form.secondaryDirectory}
              onChange={(e) => setForm({ ...form, secondaryDirectory: e.target.value })}
            />
          </Field>

          <Toggle
            label="رمزگذاری نسخه‌های محلی"
            checked={form.encryptLocal}
            onChange={(v) => setForm({ ...form, encryptLocal: v })}
            hint="با عبارت عبورِ همین سرور؛ بدون آن، نسخه روی دیسک خواناست"
          />
          <Field
            label={config.hasPassphrase ? "عبارت عبور (برای تغییر، نو را بنویسید)" : "عبارت عبور رمزنگاری"}
            hint="بازیابی بدون این عبارت ممکن نیست. آن را جای دیگری هم ذخیره کنید."
          >
            <input
              type="password"
              className={inputClass}
              dir="ltr"
              autoComplete="new-password"
              placeholder={config.hasPassphrase ? "••••••••  (ذخیره شده)" : "دست‌کم ۸ نویسه"}
              value={form.passphrase}
              onChange={(e) => setForm({ ...form, passphrase: e.target.value })}
            />
          </Field>
          {config.hasPassphrase || clearSecrets.passphrase ? (
            <button
              type="button"
              className="mb-3 text-xs text-muted-foreground underline decoration-border hover:text-foreground"
              onClick={() => setClearSecrets((s) => ({ ...s, passphrase: !s.passphrase }))}
            >
              {clearSecrets.passphrase ? "لغو پاک‌کردن عبارت عبور" : "پاک کردن عبارت عبور ذخیره‌شده"}
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <Toggle
          label="ارسال نسخه‌ها به فضای ابری (S3)"
          checked={form.cloud.enabled}
          onChange={(v) => setForm({ ...form, cloud: { ...form.cloud, enabled: v } })}
          hint="همان فایل رمزشده در هر فضای سازگار با S3: آروان، Backblaze، MinIO روی NAS"
        />
        <div className="mt-3 grid gap-x-4 md:grid-cols-2">
          <Field label="Endpoint">
            <input className={inputClass} dir="ltr" placeholder="https://s3.ir-thr-at1.arvanstorage.ir" value={form.cloud.endpoint} onChange={(e) => setForm({ ...form, cloud: { ...form.cloud, endpoint: e.target.value } })} />
          </Field>
          <Field label="Bucket">
            <input className={inputClass} dir="ltr" value={form.cloud.bucket} onChange={(e) => setForm({ ...form, cloud: { ...form.cloud, bucket: e.target.value } })} />
          </Field>
          <Field label="Region">
            <input className={inputClass} dir="ltr" value={form.cloud.region} onChange={(e) => setForm({ ...form, cloud: { ...form.cloud, region: e.target.value } })} />
          </Field>
          <Field label="پیشوند کلیدها">
            <input className={inputClass} dir="ltr" value={form.cloud.prefix} onChange={(e) => setForm({ ...form, cloud: { ...form.cloud, prefix: e.target.value } })} />
          </Field>
          <Field label="Access key id">
            <input className={inputClass} dir="ltr" value={form.cloud.accessKeyId} onChange={(e) => setForm({ ...form, cloud: { ...form.cloud, accessKeyId: e.target.value } })} />
          </Field>
          <Field label={form.cloud.hasSecretAccessKey ? "Secret key (برای تغییر، نو را بنویسید)" : "Secret key"}>
            <input type="password" className={inputClass} dir="ltr" autoComplete="new-password" placeholder={form.cloud.hasSecretAccessKey ? "••••••••  (ذخیره شده)" : ""} value={form.cloud.secretAccessKey} onChange={(e) => setForm({ ...form, cloud: { ...form.cloud, secretAccessKey: e.target.value } })} />
          </Field>
        </div>
        {form.cloud.hasSecretAccessKey ? (
          <button
            type="button"
            className="text-xs text-muted-foreground underline decoration-border hover:text-foreground"
            onClick={() => setClearSecrets((s) => ({ ...s, cloudSecret: !s.cloudSecret }))}
          >
            {clearSecrets.cloudSecret ? "لغو پاک‌کردن کلید محرمانه" : "پاک کردن کلید محرمانهٔ ذخیره‌شده"}
          </button>
        ) : null}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Button onClick={() => onSave(patch(), "config")} disabled={!dirty || busy === "config"}>
          {busy === "config" ? <Loader2 className="me-1.5 h-4 w-4 animate-spin motion-reduce:animate-none" /> : null}
          ذخیرهٔ تنظیمات
        </Button>
        {dirty ? (
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => { setForm(config); setClearSecrets({ passphrase: false, cloudSecret: false }); }}>
            بازگردانی تغییرات این فرم
          </button>
        ) : null}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ۳ — serving (the OLD server's half of the address feature)
// ---------------------------------------------------------------------------

function ServingCard({
  config,
  tokens,
  busy,
  onSave,
  onReload,
}: {
  config: Config;
  tokens: TokenRow[];
  busy: string | null;
  onSave: (patch: Record<string, unknown>, key: string) => void;
  onReload: () => void;
}) {
  const [label, setLabel] = useState("");
  const [days, setDays] = useState("30");
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function issue() {
    setError(null);
    const res = await api<{ token?: string; error?: string }>("/api/platform/backup/tokens", {
      method: "POST",
      body: JSON.stringify({ label, expiresInDays: Number(days) || null }),
    });
    if (res.ok && res.data.token) {
      setIssued(res.data.token);
      setLabel("");
      onReload();
    } else {
      setError(text(res.data.error));
    }
  }

  async function revoke(id: string) {
    await api(`/api/platform/backup/tokens/${id}`, { method: "DELETE" });
    onReload();
  }

  return (
    <Card title="دسترسی سرور دیگر به این نسخه‌ها">
      <InfoBox>
        با روشن کردن این گزینه، سروری که آدرس همین سرور و یکی از کلیدهای زیر را داشته باشد
        می‌تواند فهرست نسخه‌ها را ببیند و فایل پشتیبان را بردارد — نه بیشتر. هیچ ورود دیگری
        از این مسیر باز نمی‌شود و تا این کلیدها را نسازید، حتی با آدرس درست چیزی دریافت نمی‌کنید.
      </InfoBox>

      <Toggle
        label="اجازهٔ دریافت نسخه‌ها توسط سرور دیگر"
        checked={config.servingEnabled}
        onChange={(v) => onSave({ servingEnabled: v, allowInsecurePeers: config.allowInsecurePeers }, "serving")}
        hint={
          config.servingEnabled
            ? "روشن است؛ هر کلید فعال، دسترسی کامل به همهٔ نسخه‌ها دارد"
            : "خاموش = مسیرها ۴۰۴ پاسخ می‌دهند، انگار وجود ندارند"
        }
      />
      {busy === "serving" ? <p className="text-xs text-muted-foreground">در حال ذخیره…</p> : null}

      {issued ? (
        <div className="mb-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
          <p className="mb-2 text-xs text-emerald-800/80 dark:text-emerald-200/80">
            همین حالا کپی کنید — این تنها بار است که کلید کامل نشان داده می‌شود. در سرور جدید، در
            بخش «بازیابی از آدرس»، همان را در فیلد کلید وارد کنید.
          </p>
          <div className="flex items-center gap-2">
            <code dir="ltr" className="min-w-0 flex-1 truncate rounded-lg bg-muted px-2 py-1.5 text-xs">
              {issued}
            </code>
            <CopyButton value={issued} />
          </div>
          <button type="button" className="mt-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => setIssued(null)}>
            دیدم، پنهانش کن
          </button>
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field label="نام کلید" hint="مثلاً «سرور جدید – مهاجرت ۱۴۰۵»">
            <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
        </div>
        <div className="w-32">
          <Field label="انقضا (روز)">
            <PersianNumberInput className={inputClass} inputMode="numeric" allowDecimal={false} allowNegative={false} value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        </div>
        <Button onClick={() => void issue()} disabled={!label.trim() || busy === "issue"}>
          {busy === "issue" ? <Loader2 className="me-1.5 h-4 w-4 animate-spin motion-reduce:animate-none" /> : null}
          ساخت کلید
        </Button>
      </div>
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      {tokens.length === 0 ? (
        <EmptyState title="هنوز کلیدی نساخته‌اید" hint="بدون کلید، حتی سروری که آدرسش را می‌دانید چیزی دریافت نمی‌کند." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="py-2 text-start font-medium">نام</th>
                <th className="py-2 text-start font-medium">کلید</th>
                <th className="py-2 text-start font-medium">ساخته</th>
                <th className="py-2 text-start font-medium">آخرین استفاده</th>
                <th className="py-2 text-start font-medium">بار</th>
                <th className="py-2 text-start font-medium">انقضا</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => {
                return (
                  <tr key={t.id} className="border-b border-border last:border-0">
                    <td className="py-2">{t.label}</td>
                    <td className="py-2 font-mono text-xs text-muted-foreground" dir="ltr">{t.hint}</td>
                    <td className="py-2 text-xs text-muted-foreground">{fmtDate(t.createdAt)}</td>
                    <td className="py-2 text-xs text-muted-foreground">{t.lastUsedAt ? fmtDate(t.lastUsedAt) : "هرگز"}</td>
                    <td className="py-2 text-xs tabular-nums text-muted-foreground">{toPersianDigits(t.uses)}</td>
                    <td className="py-2 text-xs text-muted-foreground">{t.expiresAt ? fmtDate(t.expiresAt, true) : "ندارد"}</td>
                    <td className="py-2 text-end">
                      {t.revokedAt ? (
                        <span className="text-xs text-muted-foreground">لغو شده</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void revoke(t.id)}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-red-700/80 dark:text-red-300/80 transition-colors hover:bg-red-500/10"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          لغو
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ۴ — restore (the NEW server's half)
// ---------------------------------------------------------------------------
//
// Issue #807: all four sources the audit named are selectable here, and each
// one posts the identity the server expects:
//
//   local  — an artifact this server itself wrote (from the run history)
//   cloud  — an object key inside the configured bucket/prefix (validated
//            against the prefix server-side; the browser cannot name an
//            arbitrary key)
//   peer   — an address registered in the peer table, with its token
//   url    — a bare download address; the artifact name is derived from the
//            address itself, so there is no second name to mistype

const SOURCE_TABS: { id: "local" | "cloud" | "peer" | "url"; label: string; hint: string }[] = [
  { id: "local", label: "دیسک این سرور", hint: "نسخهٔ پشتیبانی که خودِ این سرور نوشته است" },
  { id: "cloud", label: "فضای ابری (S3)", hint: "شیء داخل باکت و پیشوند تنظیم‌شدهٔ همین سرور" },
  { id: "peer", label: "سرور مقابل", hint: "از سروری که آدرس و کلیدش ثبت شده است" },
  { id: "url", label: "آدرس مستقیم", hint: "پیوند مستقیم به فایل پشتیبان روی NAS یا فضای ابری" },
];

function RestoreCard({
  peers,
  local,
  cloud,
  canVerify,
  canRestore,
  canPeerManage,
  confirmPhrase,
  busy,
  setBusy,
  presetArtifact,
  onPresetConsumed,
  onReload,
}: {
  peers: PeerRow[];
  local: ArtifactRow[];
  cloud: ArtifactRow[];
  canVerify: boolean;
  canRestore: boolean;
  canPeerManage: boolean;
  confirmPhrase: string;
  busy: string | null;
  setBusy: (v: string | null) => void;
  /** An artifact picked in the history card's list, pre-selected here. */
  presetArtifact: string | null;
  onPresetConsumed: () => void;
  onReload: () => void;
}) {
  const [source, setSource] = useState<"local" | "cloud" | "peer" | "url">(
    local.some((a) => a.exists) ? "local" : "url",
  );
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string>(peers[0]?.id ?? "");
  const [check, setCheck] = useState<{ manifest: PeerManifest; warnings: string[] } | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<string>("");
  const [url, setUrl] = useState<string>("");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [result, setResult] = useState<{ status: string; summary?: unknown; notice?: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const peer = useMemo(() => peers.find((p) => p.id === selected) ?? null, [peers, selected]);
  useEffect(() => {
    setSelected((cur) => (cur && peers.some((p) => p.id === cur) ? cur : (peers[0]?.id ?? "")));
  }, [peers]);
  // A new check replaces the list the operator may have picked from, so the
  // stale selection is cleared rather than left pointing at an artifact that is
  // no longer on screen.
  useEffect(() => {
    setCheck(null);
    setCheckError(null);
    setResult(null);
    setActionError(null);
    setArtifact("");
  }, [selected]);

  // Switching source invalidates whatever was selected in the previous one.
  useEffect(() => {
    setResult(null);
    setActionError(null);
    setArtifact("");
    setCheck(null);
    setCheckError(null);
  }, [source]);

  const localChoices = useMemo(() => local.filter((a) => a.exists), [local]);
  const cloudChoices = useMemo(() => cloud, [cloud]);

  // Issue #807: one restore implementation. A "restore this one" button in the
  // artifact list only *preselects* this form; it no longer opens a second copy
  // of the same flow with the same confirm phrase and the same endpoint.
  useEffect(() => {
    if (!presetArtifact) return;
    setSource("local");
    setArtifact(presetArtifact);
    setResult(null);
    setActionError(null);
    setConfirm("");
    onPresetConsumed();
    if (typeof document !== "undefined") {
      document.getElementById("platform-restore-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [presetArtifact, onPresetConsumed]);

  async function addPeer() {
    setFormError(null);
    const res = await api<{ peer?: PeerRow; error?: string }>("/api/platform/backup/peers", {
      method: "POST",
      body: JSON.stringify({ label, baseUrl, token, enabled: true }),
    });
    if (res.ok) {
      setLabel("");
      setBaseUrl("");
      setToken("");
      onReload();
      if (res.data.peer) setSelected(res.data.peer.id);
    } else {
      setFormError(text((res.data as { error?: string }).error));
    }
  }

  async function removePeer(id: string) {
    await api(`/api/platform/backup/peers/${id}`, { method: "DELETE" });
    onReload();
  }

  async function togglePeer(id: string, enabled: boolean) {
    await api(`/api/platform/backup/peers/${id}`, { method: "PUT", body: JSON.stringify({ enabled }) });
    onReload();
  }

  async function runCheck() {
    if (!peer) return;
    setBusy("check");
    setCheckError(null);
    const res = await api<{ manifest?: PeerManifest; warnings?: string[]; error?: string }>(
      `/api/platform/backup/peers/${peer.id}/check`,
      { method: "POST" },
    );
    if (res.ok && res.data.manifest) {
      const list = res.data.manifest.artifacts ?? [];
      setCheck({ manifest: res.data.manifest, warnings: res.data.warnings ?? [] });
      setArtifact(list[0]?.artifact ?? "");
    } else {
      setCheck(null);
      setCheckError(text(res.data.error));
    }
    setBusy(null);
  }

  /**
   * What this source contributes to the request body. A cloud restore sends the
   * selected object key explicitly alongside the artifact name; a URL restore
   * sends the address and lets the server derive (and cross-check) the name.
   */
  function requestBody(apply: boolean): Record<string, unknown> {
    const shared = {
      apply,
      ...(passphrase ? { passphrase } : {}),
      ...(apply ? { confirm } : {}),
    };
    if (source === "local") return { source, artifact, ...shared };
    // The cloud row's `artifact` is the full object key, and it travels as
    // both fields: the server validates the key against the configured prefix
    // and the artifact name against the key's last segment.
    if (source === "cloud") return { source, artifact, objectKey: artifact, ...shared };
    if (source === "url") return { source, url: url.trim(), ...shared };
    return { source, peerId: peer?.id ?? "", artifact, ...shared };
  }


  /** Whether the current source has something to restore from. */
  const ready =
    source === "local"
      ? Boolean(artifact)
      : source === "cloud"
        ? Boolean(artifact)
        : source === "url"
          ? Boolean(url.trim())
          : Boolean(peer && artifact);

  async function restore(apply: boolean) {
    if (!ready) return;
    setBusy(apply ? "apply" : "verify");
    setActionError(null);
    setResult(null);
    const res = await api<{ status?: string; summary?: unknown; notice?: string; error?: string; detail?: string }>(
      "/api/platform/backup/restore",
      { method: "POST", body: JSON.stringify(requestBody(apply)) },
    );
    setBusy(null);
    if (res.ok) {
      setResult({ status: res.data.status ?? "verified", summary: res.data.summary, notice: res.data.notice });
      setConfirm("");
      onReload();
    } else {
      setActionError(text(res.data.error, res.data.detail));
    }
  }

  const chosen = check?.manifest.artifacts.find((a) => a.artifact === artifact) ?? null;

  return (
    <div id="platform-restore-card">
    <Card title="بازیابی کامل سیستم">
      <InfoBox>
        نسخه را از هر جایی که هست انتخاب کنید — دیسک همین سرور، باکت ابری، سرور قدیم، یا یک
        پیوند مستقیم — و اول «اعتبارسنجی» کنید: فایل در یک پایگاه‌دادهٔ موقت بازمی‌گردد و هیچ
        چیزی در این سرور تغییر نمی‌کند. «بازگردانی کامل» همان فایل را جای پایگاه‌دادهٔ جاری
        می‌گذارد و برگشت‌پذیر نیست.
      </InfoBox>

      <div className="mb-4 flex flex-wrap gap-2">
        {SOURCE_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            title={tab.hint}
            onClick={() => setSource(tab.id)}
            className={`rounded-xl border px-3 py-1.5 text-xs transition-colors ${
              source === tab.id
                ? "border-sky-400/50 bg-sky-500/10 text-foreground"
                : "border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {source === "local" ? (
        <Field label="نسخهٔ روی دیسک این سرور">
          {localChoices.length === 0 ? (
            <EmptyState title="نسخه‌ای روی دیسک نیست" hint="از همین صفحه یک پشتیبان فوری بگیرید یا از منابع دیگر انتخاب کنید." />
          ) : (
            <select className={selectClass} value={artifact} onChange={(e) => setArtifact(e.target.value)}>
              <option value="">— انتخاب نسخه —</option>
              {localChoices.map((a) => (
                <option key={a.artifact} value={a.artifact} className="bg-popover">
                  {a.artifact} — {bytes(a.sizeBytes)}
                  {a.encrypted ? " (رمزشده)" : ""}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}

      {source === "cloud" ? (
        <Field label="شیء داخل فضای ابری (باکت و پیشوند تنظیم‌شده)">
          {cloudChoices.length === 0 ? (
            <EmptyState
              title="شیئی در فهرست ابری نیست"
              hint="اگر بارگذاری ابری خاموش است یا باکت در دسترس نیست، این فهرست خالی می‌ماند."
            />
          ) : (
            <select className={selectClass} value={artifact} onChange={(e) => setArtifact(e.target.value)}>
              <option value="">— انتخاب شیء —</option>
              {cloudChoices.map((a) => (
                <option key={a.artifact} value={a.artifact} className="bg-popover">
                  {a.artifact.split("/").at(-1)} — {bytes(a.sizeBytes)}
                  {a.encrypted ? " (رمزشده)" : ""}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}

      {source === "url" ? (
        <Field label="پیوند مستقیم به فایل پشتیبان" hint="بخش آخر آدرس باید نام یک فایل پشتیبان باشد؛ همان نام، مبنای اعتبارسنجی است">
          <input
            className={inputClass}
            dir="ltr"
            value={url}
            onChange={(e) => setUrl(e.target.value.trim())}
            placeholder="https://nas.example.com/backups/pos-backup-20260101-033000-abcd1234.dump.enc"
          />
        </Field>
      ) : null}

      {source === "peer" ? (
        <>
          <div className="grid gap-x-4 md:grid-cols-3">
            <Field label="نام سرور مقابل">
              <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="سرور قدیم" />
            </Field>
            <Field label="آدرس (با http:// یا https://)">
              <input className={inputClass} dir="ltr" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value.trim())} placeholder="https://pos.example.com" />
            </Field>
            <Field label="کلید دسترسی آن سرور">
              <input className={inputClass} dir="ltr" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value.trim())} placeholder="POS1-…" />
            </Field>
          </div>
          {formError ? <ErrorBox>{formError}</ErrorBox> : null}
          {canPeerManage ? (
            <Button onClick={() => void addPeer()} disabled={!label.trim() || !baseUrl.trim() || busy === "add-peer"}>
              {busy === "add-peer" ? <Loader2 className="me-1.5 h-4 w-4 animate-spin motion-reduce:animate-none" /> : null}
              افزودن این سرور
            </Button>
          ) : (
            <InfoBox>افزودن یا تغییر سرور به دسترسی «مدیریت سرورهای مقابل» نیاز دارد.</InfoBox>
          )}

          {peers.length === 0 ? (
            <div className="mt-4">
              <EmptyState
                title="هنوز سروری ثبت نشده"
                hint={
                  canPeerManage
                    ? "برای بازیابی، اول آدرس سروری که نسخه‌ها آن‌جا هستند را ثبت کنید."
                    : "ثبت سرور به دسترسی «مدیریت سرورهای مقابل» نیاز دارد."
                }
              />
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <div className="space-y-1.5">
                {peers.map((p) => (
                  <label
                    key={p.id}
                    className={`flex cursor-pointer flex-wrap items-center gap-2 rounded-xl border px-3 py-2 transition-colors ${
                      selected === p.id ? "border-sky-400/50 bg-sky-500/10" : "border-border hover:bg-muted"
                    }`}
                  >
                    <input type="radio" name="peer" className="accent-sky-500" checked={selected === p.id} onChange={() => setSelected(p.id)} />
                    <span className="min-w-0 flex-1 truncate text-sm">{p.label}</span>
                    <code dir="ltr" className="truncate text-xs text-muted-foreground">{p.baseUrl}</code>
                    {!p.hasToken ? <span className="text-xs text-amber-700 dark:text-amber-300">کلید ندارد</span> : null}
                    {!p.secure ? <span className="text-xs text-amber-700 dark:text-amber-300">http</span> : null}
                    <span className="text-xs text-muted-foreground">
                      {p.lastCheckAt ? `بررسی: ${fmtDate(p.lastCheckAt)}` : "بررسی نشده"}
                      {p.lastCheckStatus === "failed" ? " · ناموفق" : ""}
                    </span>
                    {canPeerManage ? (
                      <>
                        {/* Both live inside the row's <label>, so each one has to stop the
                            label from also activating its radio — otherwise "delete this
                            server" silently re-selects the row you are deleting. */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            void togglePeer(p.id, !p.enabled);
                          }}
                          className="text-xs text-muted-foreground hover:text-foreground"
                        >
                          {p.enabled ? "غیرفعال" : "فعال"}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            void removePeer(p.id);
                          }}
                          aria-label={`حذف ${p.label}`}
                          className="text-muted-foreground transition-colors hover:text-red-700 dark:hover:text-red-300"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    ) : null}
                  </label>
                ))}
              </div>

              {peer && !peer.enabled ? (
                <InfoBox>این سرور غیرفعال است؛ برای بررسی یا بازیابی اول آن را فعال کنید.</InfoBox>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" onClick={() => void runCheck()} disabled={!peer || busy === "check" || !canPeerManage}>
                  {busy === "check" ? <Loader2 className="me-1.5 h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Unplug className="me-1.5 h-4 w-4" />}
                  بررسی اتصال و خواندن فهرست
                </Button>
                {check ? (
                  <span className="text-xs text-muted-foreground">
                    {toPersianDigits(check.manifest.artifacts.length)} نسخه · {toPersianDigits(check.manifest.schemaMigrations)} مهاجرت ·
                    Postgres {toPersianDigits(check.manifest.pgServerMajor)} · {toPersianDigits(check.manifest.businessCount)} کسب‌وکار
                  </span>
                ) : null}
              </div>
              {!canPeerManage ? (
                <InfoBox>
                  خواندن فهرست سرور مقابل و کلیدهایش به دسترسی «مدیریت سرورهای مقابل» نیاز دارد؛
                  بازگردانی از سرور مقابل هم از همین مسیر انجام می‌شود.
                </InfoBox>
              ) : null}
              {checkError ? <ErrorBox>{checkError}</ErrorBox> : null}

              {check && check.warnings.length > 0 ? (
                <InfoBox>
                  <ul className="list-inside list-disc space-y-1">
                    {check.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </InfoBox>
              ) : null}

              {check && canVerify ? (
                <div className="rounded-xl border border-border bg-muted p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">نسخه</span>
                    <select className={`${selectClass} h-9 w-auto min-w-[22rem]`} value={artifact} onChange={(e) => setArtifact(e.target.value)}>
                      {check.manifest.artifacts.map((a) => (
                        <option key={a.artifact} value={a.artifact} className="bg-popover">
                          {a.artifact} — {bytes(a.sizeBytes)}
                          {a.encrypted ? " (رمزشده)" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  {chosen?.sha256 ? (
                    <p className="mb-2 text-[11px] text-muted-foreground" dir="ltr">
                      sha256: {chosen.sha256.slice(0, 32)}…
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </>
      ) : null}

      <div className="mt-4 grid gap-x-3 md:grid-cols-2">
        <Field label="عبارت عبور (اگر این سرور آن را ذخیره نکرده)" hint="برای همین یک بار استفاده می‌شود و جایی ذخیره نمی‌شود">
          <input type="password" className={inputClass} dir="ltr" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </Field>
        {canRestore ? (
          <Field label={confirmPhrase ? `برای بازگردانی این را دقیق بنویسید: ${confirmPhrase}` : "در حال خواندن عبارت تأیید…"}>
            <input className={inputClass} dir="rtl" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={() => void restore(false)} disabled={!ready || !canVerify || busy === "verify"}>
          {busy === "verify" ? <Loader2 className="me-1.5 h-4 w-4 animate-spin motion-reduce:animate-none" /> : <ShieldAlert className="me-1.5 h-4 w-4" />}
          اعتبارسنجی در پایگاه‌دادهٔ موقت
        </Button>
        {canRestore ? (
          <Button
            variant="danger"
            onClick={() => void restore(true)}
            disabled={!ready || !confirmPhrase || confirm.trim() !== confirmPhrase || busy === "apply"}
          >
            {busy === "apply" ? <Loader2 className="me-1.5 h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Download className="me-1.5 h-4 w-4" />}
            بازگردانی کامل روی این سرور
          </Button>
        ) : (
          <span className="text-[11px] text-muted-foreground">بازگردانی کامل فقط برای نقش «مدیر ارشد» است.</span>
        )}
      </div>
      {actionError ? <ErrorBox>{actionError}</ErrorBox> : null}
      {result ? <RestoreResult result={result} /> : null}

      <p className="mt-3 text-[11px] text-muted-foreground">
        سروری که http دارد فقط وقتی بررسی می‌شود که «اجازهٔ اتصال ناامن» در تنظیمات روشن باشد؛
        آدرس‌های داخلی (LAN) هم به «اجازهٔ سرورهای شبکهٔ داخلی» نیاز دارند. آدرس‌های metadata و
        link-local هرگز پذیرفته نمی‌شوند.
      </p>
    </Card>
    </div>
  );
}

function RestoreResult({ result }: { result: { status?: string; summary?: unknown; notice?: string } }) {
  const summary = result.summary as
    | { migrations?: number; latestMigration?: string; tables?: { name: string; rows: number }[] }
    | undefined;
  return (
    <div className={`mt-3 rounded-xl border p-3 ${result.status === "applied" ? "border-amber-500/30 bg-amber-500/10" : "border-emerald-500/30 bg-emerald-500/10"}`}>
      <p className="text-sm font-medium text-foreground">
        {result.status === "applied" ? "بازگردانی انجام شد" : "اعتبارسنجی موفق بود — چیزی تغییر نکرد"}
      </p>
      {summary ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{toPersianDigits(summary.migrations ?? 0)} مهاجرت</span>
          {summary.latestMigration ? <span dir="ltr">تازه‌ترین: {summary.latestMigration}</span> : null}
          {(summary.tables ?? []).map((t) => (
            <span key={t.name} dir="ltr">
              {t.name}: {toPersianDigits(t.rows)}
            </span>
          ))}
        </div>
      ) : null}
      {result.notice ? <p className="mt-2 text-xs leading-6 text-amber-800/80 dark:text-amber-200/80">{result.notice}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ۵ — history
// ---------------------------------------------------------------------------

function HistoryCard({
  runs,
  local,
  restores,
  health,
  tone,
  onPickLocal,
  onChanged,
}: {
  runs: RunRow[];
  local: ArtifactRow[];
  restores: RestoreRun[];
  health: Health;
  tone: "neutral" | "ok" | "warn" | "bad";
  /** Hands a local artifact to the one restore form above this card. */
  onPickLocal: (artifact: string) => void;
  onChanged: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked by the browser; the value is on screen */
    }
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card title="اجرای پشتیبان‌گیری‌ها">
        {runs.length === 0 ? (
          <EmptyState
            title={health.enabled ? "هنوز اجرایی ثبت نشده" : "پشتیبان‌گیری خودکار روشن نیست"}
            hint={
              tone === "bad"
                ? "آخرین اجرا ناموفق بود؛ متن خطا در همین جدول است."
                : "«پشتیبان‌گیری فوری» اولین نسخه را همین حالا می‌سازد."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="py-2 text-start font-medium">شروع</th>
                  <th className="py-2 text-start font-medium">نوع</th>
                  <th className="py-2 text-start font-medium">وضعیت</th>
                  <th className="py-2 text-start font-medium">حجم</th>
                  <th className="py-2 text-start font-medium">فایل</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-border align-top last:border-0">
                    <td className="py-2 text-xs text-muted-foreground">{fmtDate(r.startedAt)}</td>
                    <td className="py-2 text-xs">
                      {r.kind === "local" ? "محلی" : "ابر"} · {TRIGGER_LABELS[r.trigger] ?? r.trigger}
                    </td>
                    <td className="py-2 text-xs">
                      <RunBadge status={r.status} />
                      {r.status === "failed" && r.error ? (
                        <span className="mt-1 block max-w-[18rem] truncate text-[11px] text-red-700/70 dark:text-red-300/70" title={r.error}>
                          {r.error.slice(0, 90)}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 text-xs tabular-nums text-muted-foreground">{bytes(r.sizeBytes)}</td>
                    <td className="py-2">
                      {r.artifact ? (
                        <button
                          type="button"
                          onClick={() => void copy(r.artifact!)}
                          className="inline-flex max-w-[16rem] items-center gap-1 truncate font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                          title="کپی نام فایل"
                        >
                          <span dir="ltr" className="truncate">{r.artifact}</span>
                          {copied === r.artifact ? <Check className="h-3 w-3 text-emerald-700 dark:text-emerald-300" /> : <Copy className="h-3 w-3" />}
                        </button>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="space-y-3">
        <Card title="نسخه‌های روی این دیسک">
          {local.length === 0 ? (
            <EmptyState title="هیچ فایلی در پوشهٔ پشتیبان‌گیری نیست" hint="با «پشتیبان‌گیری فوری» یک نسخه بسازید." />
          ) : (
            <ul className="space-y-1.5">
              {local.map((a) => (
                <li key={a.artifact} className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <code dir="ltr" className="min-w-0 flex-1 truncate text-foreground">{a.artifact}</code>
                    <span className="tabular-nums text-muted-foreground">{bytes(a.sizeBytes)}</span>
                    {a.encrypted ? <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">رمزشده</span> : null}
                    {a.exists ? null : <span className="rounded-full border border-amber-500/30 px-1.5 text-[10px] text-amber-700 dark:text-amber-300">حذف‌شده</span>}
                    {a.exists ? (
                      <button
                        type="button"
                        onClick={() => onPickLocal(a.artifact)}
                        className="rounded-lg border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        بازیابی این نسخه
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="تاریخچهٔ بازگردانی‌ها">
          {restores.length === 0 ? (
            <EmptyState title="هنوز بازگردانی‌ای انجام نشده" hint="هر «اعتبارسنجی» و هر «بازگردانی کامل» همین‌جا ثبت می‌شود." />
          ) : (
            <ul className="space-y-1.5">
              {restores.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted-foreground">{fmtDate(r.startedAt)}</span>
                  <span className="text-foreground">{r.mode === "apply" ? "بازگردانی کامل" : "اعتبارسنجی"}</span>
                  <span className="text-muted-foreground">{SOURCE_LABELS[r.source] ?? r.source}</span>
                  <code dir="ltr" className="min-w-0 flex-1 truncate text-muted-foreground">{r.artifact}</code>
                  <RunBadge status={r.status} />
                  {r.error ? <span className="w-full truncate text-[11px] text-red-700/70 dark:text-red-300/70">{r.error.slice(0, 120)}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

/**
 * The console's `StatusBadge` labels business lifecycle states; a run has its
 * own three, and the same rule applies to them — an operator never reads a raw
 * English enum in this UI.
 */
function RunBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    running: { label: "در حال اجرا", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30" },
    success: { label: "موفق", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30" },
    failed: { label: "ناموفق", cls: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30" },
    ok: { label: "موفق", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30" },
  };
  const s = map[status] ?? { label: status, cls: "bg-muted text-muted-foreground border-border" };
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}

const TRIGGER_LABELS: Record<string, string> = {
  scheduled: "خودکار",
  manual: "دستی",
  peer: "درخواست سرور دیگر",
};

const SOURCE_LABELS: Record<string, string> = {
  local: "از دیسک این سرور",
  cloud: "از فضای ابری",
  peer: "از سرور مقابل",
  url: "از آدرس مستقیم",
};

/** A labelled switch — the console's own idiom (no native checkbox styling). */
function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="mb-4 flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        className="mt-1 h-4 w-4 shrink-0 accent-sky-500"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          /* clipboard blocked; the value is on screen for a manual copy */
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
      {label ?? (copied ? "کپی شد" : "کپی")}
    </button>
  );
}
