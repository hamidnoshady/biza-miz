"use client";

/**
 * «وردپرس و ووکامرس» — the «اتصال‌های فنی» hub's tab for the store
 * connection. It preserves the connection workflows from the old standalone
 * `/dashboard/integrations` page and extends them for the second
 * way a store can now connect.
 *
 * The two modes are presented as a choice up front rather than as an advanced
 * option, because they are genuinely different setups: the plugin mode asks
 * for an address and hands back one token to paste into WordPress; the REST
 * mode asks for consumer keys the owner has to mint in WP admin first and then
 * a webhook to configure by hand. Most people want the first; a store that
 * cannot install plugins needs the second.
 *
 * Only the connection lives here — create, test, sync triggers, the per-store
 * sync preferences, token rotation, pause and delete. Managing the store
 * itself (products, orders, customers, taxonomies, content, media, the queue)
 * is «مدیریت وب‌سایت»'s WordPress manager, which links here for the
 * connection.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useFeatureLocked } from "@/components/feature-lock";
import { api, ErrorBox, errorMessageOrRaw, InfoBox, inputClass } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";
import { formatDateTime } from "./format";
import { SyncSettingsSection } from "./woo-store-sections";

type LinkMode = "rest_api" | "plugin";

interface Connection {
  id: string;
  name: string;
  baseUrl: string;
  linkMode: LinkMode;
  currencyUnit: "rial" | "toman";
  /** Phase 38 — what the connection pulls, and when it last pulled it. */
  syncCategories: boolean;
  autoPullOrders: boolean;
  orderLookbackDays: number;
  status: "active" | "paused" | "error";
  lastSyncAt: string | null;
  lastCatalogueSyncAt: string | null;
  lastOrderSyncAt: string | null;
  lastError: string | null;
  webhookPath: string;
  hasLinkToken: boolean;
  linkTokenSetAt: string | null;
  pluginVersion: string | null;
  pluginSiteUrl: string | null;
  lastPluginSeenAt: string | null;
  inbox: Record<string, number>;
  outbox: Record<string, number>;
}

interface AuditEntry {
  id: string;
  action: string;
  entityType: string | null;
  remoteId: string | null;
  error: string | null;
  createdAt: string;
}

interface OutboxJob {
  id: string;
  entityType: string;
  remoteId: string;
  status: "pending" | "processing" | "sent" | "failed" | "dead";
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
}

const ACTION_LABELS: Record<string, string> = {
  "connection.created": "اتصال ایجاد شد",
  "connection.updated": "اتصال ویرایش شد",
  "connection.deleted": "اتصال حذف شد",
  "connection.test_ok": "تست اتصال موفق",
  "connection.test_failed": "تست اتصال ناموفق",
  "connection.link_token_rotated": "توکن افزونه تعویض شد",
  "plugin.handshake": "افزونهٔ وردپرس متصل شد",
  "order.imported": "سفارش وارد شد",
  "refund.imported": "برگشت وجه وارد شد",
  "products.synced": "همگام‌سازی محصولات",
  "orders.synced": "همگام‌سازی سفارش‌ها",
  "orders.pull_failed": "خطا در بازخوانی سفارش‌ها",
  "taxonomy.sync_failed": "خطا در دریافت دسته‌بندی‌ها",
  "product.variations_failed": "خطا در دریافت تنوع‌ها",
  "customers.synced": "همگام‌سازی مشتریان",
  "reconciliation.run": "مغایرت‌گیری",
  "outbox.dead_lettered": "خطای دائمی ارسال",
};

const OUTBOX_TYPE_LABELS: Record<string, string> = {
  stock: "ارسال موجودی",
  price: "ارسال قیمت",
  catalogue_export: "همگام‌سازی محصولات",
  customer_export: "همگام‌سازی مشتریان",
  // Phase 38 — operations, not just numbers.
  product_update: "به‌روزرسانی محصول",
  order_status: "تغییر وضعیت سفارش",
  refund_create: "ثبت برگشت وجه",
  orders_export: "بازخوانی سفارش‌ها",
};

const OUTBOX_STATUS_LABELS: Record<string, string> = {
  pending: "در انتظار",
  processing: "در حال انجام",
  sent: "ارسال شده",
  failed: "ناموفق",
  dead: "خطای دائمی",
};

/**
 * In plugin mode the store is reachable only through the plugin's own run, so
 * a pending queue with no recent contact means the plugin (or its cron) is
 * not running — the queue is real, it is just not being drained.
 */
const PLUGIN_STALE_MS = 15 * 60 * 1000;

/** A secret shown exactly once. Deliberately loud: there is no second chance to read it. */
function ShowOnceSecret({ title, value, note, onDone }: { title: string; value: string; note: string; onDone: () => void }) {
  return (
    <div className="rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 p-4 text-sm">
      <p className="font-semibold text-amber-900 dark:text-amber-200">{title}</p>
      <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">{note}</p>
      <code dir="ltr" className="mt-2 block select-all break-all rounded-lg bg-white/70 p-2 font-mono text-amber-900 dark:text-amber-200">
        {value}
      </code>
      <Button
        type="button"
        size="sm"
        className="mt-2 bg-amber-500 dark:bg-amber-400 text-amber-950 hover:bg-amber-600 dark:hover:bg-amber-300"
        onClick={() => {
          void navigator.clipboard.writeText(value).catch(() => undefined);
          onDone();
        }}
      >
        کپی و بستن
      </Button>
    </div>
  );
}

export function WpConnectionPanel() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditFor, setAuditFor] = useState<string | null>(null);
  const [outboxJobs, setOutboxJobs] = useState<OutboxJob[]>([]);
  const [outboxFor, setOutboxFor] = useState<string | null>(null);
  // The per-store sync preferences, one open at a time. The store's own
  // working surfaces (catalogue, taxonomies, orders) used to open here too;
  // they are «مدیریت وب‌سایت»'s sections now, so this panel links there
  // instead of rendering a second copy of them.
  const [syncFor, setSyncFor] = useState<string | null>(null);
  const locked = useFeatureLocked();

  const [form, setForm] = useState({
    name: "",
    baseUrl: "",
    linkMode: "plugin" as LinkMode,
    consumerKey: "",
    consumerSecret: "",
    wpUsername: "",
    wpApplicationPassword: "",
    currencyUnit: "toman" as "rial" | "toman",
  });

  const load = useCallback(async () => {
    // Locked preview: /api/integrations/* answers `feature_disabled`, so asking
    // would only replace the (accurate) "no store connected yet" empty state
    // with a load error.
    if (locked) {
      setConnections([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { ok, data } = await api<{ connections?: Connection[] }>("/api/integrations/overview");
    if (ok) setConnections(data.connections ?? []);
    else setMessage({ kind: "error", text: "بارگذاری اتصال‌ها ممکن نشد." });
    setLoading(false);
  }, [locked]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadAudit = useCallback(
    async (connectionId: string) => {
      if (auditFor === connectionId) {
        setAuditFor(null);
        setAudit([]);
        return;
      }
      setAuditFor(connectionId);
      const { data } = await api<{ entries?: AuditEntry[] }>(`/api/integrations/connections/${connectionId}/audit`);
      setAudit(data.entries ?? []);
    },
    [auditFor],
  );

  const loadOutbox = useCallback(
    async (connectionId: string) => {
      if (outboxFor === connectionId) {
        setOutboxFor(null);
        setOutboxJobs([]);
        return;
      }
      setOutboxFor(connectionId);
      const { data } = await api<{ jobs?: OutboxJob[] }>(`/api/integrations/connections/${connectionId}/outbox`);
      setOutboxJobs(data.jobs ?? []);
    },
    [outboxFor],
  );

  async function call<T extends Record<string, unknown>>(path: string, method = "POST", body?: unknown): Promise<T | null> {
    setBusy(path);
    setMessage(null);
    const { ok, data } = await api<T & { error?: string; queued?: boolean }>(path, {
      method,
      body: body ? JSON.stringify(body) : undefined,
    });
    setBusy(null);
    if (!ok) {
      setMessage({ kind: "error", text: errorMessageOrRaw(data.error) || "عملیات ناموفق بود." });
      await load();
      return null;
    }
    // "queued" is what a plugin-mode action returns: the app cannot reach the
    // store itself, so the work waits for the plugin's next run. Saying so is
    // the difference between "nothing happened" and "it is on its way".
    if (data.queued) setMessage({ kind: "ok", text: "درخواست در صف قرار گرفت و در اجرای بعدی افزونه انجام می‌شود." });
    else setMessage({ kind: "ok", text: "انجام شد." });
    await load();
    return data;
  }

  async function createConnection() {
    const data = await call<{ webhookSecret?: string; linkToken?: string | null }>(
      "/api/integrations/connections?provider=woocommerce",
      "POST",
      form,
    );
    if (!data) return;
    if (data.linkToken) setLinkToken(data.linkToken);
    else if (data.webhookSecret) setWebhookSecret(data.webhookSecret);
    setForm({ ...form, name: "", baseUrl: "", consumerKey: "", consumerSecret: "", wpUsername: "", wpApplicationPassword: "" });
  }

  async function rotateToken(id: string) {
    const data = await call<{ linkToken?: string }>(`/api/integrations/connections/${id}/link-token`, "POST");
    if (data?.linkToken) setLinkToken(data.linkToken);
  }

  // The origin is shown to copy into the WordPress plugin settings, so it must
  // be the browser's own — but reading it while rendering would answer one
  // value on the server and another on the client, and React hydrates the
  // difference into a full client re-render. Fill it in after mount instead.
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  return (
    <div className="space-y-6">
      {message?.kind === "ok" ? <InfoBox>{message.text}</InfoBox> : null}
      {message?.kind === "error" ? <ErrorBox>{message.text}</ErrorBox> : null}

      {linkToken ? (
        <ShowOnceSecret
          title="توکن اتصال افزونهٔ وردپرس"
          note="این توکن فقط همین یک بار نمایش داده می‌شود. آن را در تنظیمات افزونه در وردپرس، کنار آدرس همین سامانه، وارد کنید."
          value={linkToken}
          onDone={() => setLinkToken(null)}
        />
      ) : null}

      {webhookSecret ? (
        <ShowOnceSecret
          title="کلید وب‌هوک ووکامرس"
          note="این کلید فقط همین یک بار نمایش داده می‌شود. در ووکامرس، هنگام ساخت وب‌هوک، در فیلد Secret وارد شود."
          value={webhookSecret}
          onDone={() => setWebhookSecret(null)}
        />
      ) : null}

      <SectionCard title="افزودن فروشگاه">
        <p className="mb-3 text-xs leading-5 text-muted-foreground">
          روش پیشنهادی «افزونهٔ وردپرس» است: فقط یک توکن می‌گیرید و آن را در وردپرس وارد می‌کنید؛ خودِ افزونه
          هر دو جهت همگام‌سازی را انجام می‌دهد و نیازی به باز بودن فروشگاه از بیرون ندارد.
        </p>

        <div className="mb-3 flex flex-wrap gap-2">
          {(
            [
              { key: "plugin" as const, label: "با افزونهٔ وردپرس (پیشنهادی)" },
              { key: "rest_api" as const, label: "با کلیدهای REST ووکامرس" },
            ]
          ).map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setForm({ ...form, linkMode: option.key })}
              aria-pressed={form.linkMode === option.key}
              className={`min-h-9 rounded-lg border px-3 text-xs font-medium transition-colors ${
                form.linkMode === option.key
                  ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 text-amber-950 dark:text-amber-200"
                  : "border-border text-muted-foreground hover:bg-muted"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <input
            className={inputClass}
            placeholder="نام فروشگاه"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className={inputClass}
            dir="ltr"
            placeholder="https://shop.example.com"
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          />
          {form.linkMode === "rest_api" ? (
            <>
              <input
                className={inputClass}
                dir="ltr"
                placeholder="Consumer Key (ck_…)"
                value={form.consumerKey}
                onChange={(e) => setForm({ ...form, consumerKey: e.target.value })}
              />
              <input
                className={inputClass}
                dir="ltr"
                placeholder="Consumer Secret (cs_…)"
                value={form.consumerSecret}
                onChange={(e) => setForm({ ...form, consumerSecret: e.target.value })}
              />
              <input
                className={inputClass}
                dir="ltr"
                placeholder="WordPress username برای wp/v2 (اختیاری)"
                value={form.wpUsername}
                onChange={(e) => setForm({ ...form, wpUsername: e.target.value })}
              />
              <input
                className={inputClass}
                dir="ltr"
                type="password"
                autoComplete="off"
                placeholder="WordPress Application Password برای محتوا/رسانه"
                value={form.wpApplicationPassword}
                onChange={(e) => setForm({ ...form, wpApplicationPassword: e.target.value })}
              />
              <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">
                کلیدهای ووکامرس فقط برای wc/v3 استفاده می‌شوند. برای نوشته‌ها، برگه‌ها، رسانه و طبقه‌بندی‌های wp/v2، یک Application Password جداگانه از پروفایل کاربر وردپرس وارد کنید؛ این رمز پس از ذخیره نمایش داده نمی‌شود.
              </p>
            </>
          ) : null}
          <select
            className={inputClass}
            value={form.currencyUnit}
            onChange={(e) => setForm({ ...form, currencyUnit: e.target.value as "rial" | "toman" })}
          >
            <option value="toman">واحد قیمت فروشگاه: تومان</option>
            <option value="rial">واحد قیمت فروشگاه: ریال</option>
          </select>
          <Button type="button" onClick={createConnection} disabled={busy !== null}>
            {form.linkMode === "plugin" ? "ساخت اتصال و توکن افزونه" : "اتصال و ذخیره"}
          </Button>
        </div>
      </SectionCard>

      <SectionCard title="فروشگاه‌های متصل">
        {loading ? (
          <LoadingSkeleton rows={3} />
        ) : connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز فروشگاهی متصل نشده است.</p>
        ) : (
          <ul className="space-y-3">
            {connections.map((c) => {
              const queueCount = (c.outbox.pending ?? 0) + (c.outbox.failed ?? 0) + (c.outbox.processing ?? 0);
              const lastSeenAt = c.lastPluginSeenAt ? new Date(c.lastPluginSeenAt).getTime() : 0;
              // Plugin mode: the plugin is the queue manager. A pending queue
              // with no recent contact means it is not running, and the "در صف"
              // number is honest but stuck — say so out loud.
              const pluginSeenStale =
                c.linkMode === "plugin" && (lastSeenAt === 0 || Date.now() - lastSeenAt > PLUGIN_STALE_MS);
              const pluginStale = pluginSeenStale && queueCount > 0;
              return (
              <li key={c.id} className="rounded-xl border border-border/80 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{c.name}</span>
                  <span className="text-xs text-muted-foreground" dir="ltr">
                    {c.baseUrl}
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground/80">
                    {c.linkMode === "plugin" ? "افزونهٔ وردپرس" : "کلیدهای REST"}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      c.status === "active"
                        ? "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-200"
                        : c.status === "error"
                          ? "bg-red-100 dark:bg-red-500/20 text-red-800 dark:text-red-200"
                          : "bg-muted text-foreground/80"
                    }`}
                  >
                    {c.status === "active" ? "فعال" : c.status === "paused" ? "متوقف" : "خطا"}
                  </span>
                  {c.lastError ? <span className="text-xs text-red-600 dark:text-red-400">{c.lastError}</span> : null}
                </div>

                {c.linkMode === "plugin" ? (
                  <div className="mt-2 space-y-1 rounded-xl bg-muted p-2 text-xs text-muted-foreground">
                    <div>
                      آدرس این سامانه برای افزونه: <span dir="ltr" className="select-all font-mono">{origin}</span>
                    </div>
                    <div className={pluginSeenStale ? "text-amber-700 dark:text-amber-300" : ""}>
                      آخرین ارتباط افزونه: {formatDateTime(c.lastPluginSeenAt)}
                      {c.pluginVersion ? ` • نسخهٔ افزونه ${c.pluginVersion}` : ""}
                    </div>
                    {!c.lastPluginSeenAt ? (
                      <div className="text-amber-700 dark:text-amber-300">
                        افزونه هنوز متصل نشده است. در وردپرس، آدرس بالا و توکن را وارد و «آزمایش اتصال» را بزنید.
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-1 text-xs text-muted-foreground" dir="ltr">
                    {origin}
                    {c.webhookPath}
                  </div>
                )}

                {pluginStale ? (
                  <div className="mt-2 rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 p-2 text-xs leading-5 text-amber-900 dark:text-amber-200">
                    <p className="font-semibold">این صف منتظر افزونهٔ وردپرس است.</p>
                    <p>
                      در حالت افزونه، سامانه به فروشگاه دسترسی مستقیم ندارد و خودِ افزونه صف را تخلیه می‌کند. بیش از ۱۵
                      دقیقه است افزونه با سامانه در تماس نبوده؛ اگر در وردپرس فعال است، کرون آن را بررسی کنید — کرون داخلی
                      وردپرس فقط هنگام بازدید از سایت اجرا می‌شود. برای همگام‌سازی بدون وقفه، یک کرون واقعی در هاست تنظیم
                      کنید: <code dir="ltr" className="font-mono">wp cron event run --due-now</code>
                    </p>
                  </div>
                ) : null}

                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => call(`/api/integrations/connections/${c.id}/test`)}
                    disabled={busy !== null}
                  >
                    تست اتصال
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => call(`/api/integrations/connections/${c.id}/sync/products`)}
                    disabled={busy !== null}
                  >
                    همگام‌سازی محصولات
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => call(`/api/integrations/connections/${c.id}/sync/orders`)}
                    disabled={busy !== null}
                  >
                    همگام‌سازی سفارش‌ها
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => call(`/api/integrations/connections/${c.id}/sync/customers`)}
                    disabled={busy !== null}
                  >
                    همگام‌سازی مشتریان
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => call(`/api/integrations/connections/${c.id}/sync/inventory`)}
                    disabled={busy !== null}
                  >
                    ارسال موجودی و قیمت
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => call(`/api/integrations/connections/${c.id}/reconcile`)}
                    disabled={busy !== null}
                  >
                    مغایرت‌گیری
                  </Button>
                  {c.linkMode === "plugin" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => rotateToken(c.id)}
                      disabled={busy !== null}
                    >
                      تعویض توکن افزونه
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() =>
                      call(`/api/integrations/connections/${c.id}`, "PATCH", {
                        status: c.status === "active" ? "paused" : "active",
                      })
                    }
                    disabled={busy !== null}
                  >
                    {c.status === "active" ? "توقف" : "فعال‌سازی"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => void loadAudit(c.id)}
                    disabled={busy !== null}
                  >
                    گزارش رویدادها
                  </Button>
                  <Button type="button" variant="outline" size="xs" onClick={() => void loadOutbox(c.id)} disabled={busy !== null}>
                    کارهای در صف
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    aria-pressed={syncFor === c.id}
                    onClick={() => setSyncFor(syncFor === c.id ? null : c.id)}
                    disabled={busy !== null}
                  >
                    تنظیمات همگام‌سازی
                  </Button>
                  <Button type="button" variant="outline" size="xs" asChild>
                    <Link href="/websites/wp">مدیریت فروشگاه</Link>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => call(`/api/integrations/connections/${c.id}`, "DELETE")}
                    disabled={busy !== null}
                  >
                    حذف
                  </Button>
                </div>

                <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>
                    دریافتی: {c.inbox.processed ?? 0} | خطا: {c.inbox.failed ?? 0}
                  </span>
                  <span>
                    ارسال: {c.outbox.sent ?? 0} | در صف: {(c.outbox.pending ?? 0) + (c.outbox.failed ?? 0) + (c.outbox.processing ?? 0)} | خطای دائمی:{" "}
                    {c.outbox.dead ?? 0}
                  </span>
                  <span>آخرین همگام‌سازی: {formatDateTime(c.lastSyncAt)}</span>
                </div>

                {c.linkMode === "plugin" ? (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    صف این فروشگاه توسط خودِ افزونهٔ وردپرس (هر ۵ دقیقه) تخلیه می‌شود؛ اگر «در صف» ثابت ماند، افزونه در
                    حال اجرا نیست.
                  </p>
                ) : null}

                {syncFor === c.id ? (
                  <SyncSettingsSection connection={c} busy={busy !== null} call={call} />
                ) : null}

                {auditFor === c.id ? (
                  <div className="mt-2 max-h-48 overflow-y-auto rounded-xl bg-muted p-2 text-xs">
                    {audit.map((a) => (
                      <div key={a.id} className="flex flex-wrap justify-between gap-2 border-b border-border py-1">
                        <span>{ACTION_LABELS[a.action] ?? a.action}</span>
                        <span className="text-muted-foreground">{a.remoteId ?? a.entityType ?? ""}</span>
                        <span className="text-muted-foreground">{formatDateTime(a.createdAt)}</span>
                        {a.error ? <span className="text-red-600 dark:text-red-400">{a.error}</span> : null}
                      </div>
                    ))}
                    {audit.length === 0 ? <p>رویدادی ثبت نشده است.</p> : null}
                  </div>
                ) : null}

                {outboxFor === c.id ? (
                  <div className="mt-2 max-h-56 overflow-y-auto rounded-xl bg-muted p-2 text-xs">
                    {outboxJobs.length === 0 ? (
                      <p>صف خالی است.</p>
                    ) : (
                      <ul className="space-y-1">
                        {outboxJobs.map((job) => (
                          <li
                            key={job.id}
                            className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-1"
                          >
                            <span>
                              {OUTBOX_TYPE_LABELS[job.entityType] ?? job.entityType}
                              {job.entityType !== "catalogue_export" && job.entityType !== "customer_export" ? (
                                <span className="text-muted-foreground" dir="ltr">
                                  {" "}
                                  #{job.remoteId}
                                </span>
                              ) : null}
                            </span>
                            <span className="flex items-center gap-2">
                              <span
                                className={
                                  job.status === "dead"
                                    ? "text-red-600 dark:text-red-400"
                                    : job.status === "failed"
                                      ? "text-amber-700 dark:text-amber-300"
                                      : job.status === "sent"
                                        ? "text-emerald-700 dark:text-emerald-300"
                                        : ""
                                }
                              >
                                {OUTBOX_STATUS_LABELS[job.status] ?? job.status}
                                {job.attempts > 0 ? ` (${job.attempts} تلاش)` : ""}
                              </span>
                              <span className="text-muted-foreground">{formatDateTime(job.createdAt)}</span>
                            </span>
                            {job.lastError ? (
                              <span className="w-full text-red-600 dark:text-red-400" dir="ltr">
                                {job.lastError}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="نصب افزونهٔ وردپرس">
        <ol className="list-inside list-decimal space-y-1 text-xs leading-6 text-muted-foreground">
          <li>
            فایل{" "}
            <a
              href="https://updates.eshobe.app/wordpress/pos-accounting-connector/pos-accounting-connector.zip"
              className="font-medium text-primary hover:underline"
              dir="ltr"
            >
              pos-accounting-connector.zip
            </a>{" "}
            را دانلود کنید (نه کل مخزن گیت‌هاب و نه فایل update.json) و در وردپرس از «افزونه‌ها ← افزودن ← بارگذاری افزونه» نصب کنید.
          </li>
          <li>
            در پیشخوان وردپرس، منوی «اشوبه» را باز کنید؛ در بخش «اتصال» (در نصب تازه، راهنمای راه‌اندازی
            خودش نمایش داده می‌شود) آدرس <span dir="ltr" className="font-mono">{origin}</span> و توکنی که
            اینجا ساخته‌اید را وارد کنید.
          </li>
          <li>«آزمایش اتصال از وردپرس» را بزنید؛ پس از موفقیت، همگام‌سازی خودکار هر پنج دقیقه اجرا می‌شود.</li>
        </ol>
        <InfoBox>
          افزونه هیچ‌گاه به پایگاه‌دادهٔ این سامانه وصل نمی‌شود؛ همهٔ ارتباط‌ها امضاشده (HMAC-SHA256) و دارای
          مهر زمانی و شمارهٔ یک‌بارمصرف است.
        </InfoBox>
        <InfoBox>
          کرون داخلی وردپرس فقط هنگام بازدید از سایت اجرا می‌شود؛ در فروشگاه کم‌تردد، همگام‌سازی تا مراجعهٔ بعدی به تعویق
          می‌افتد. برای اجرای دقیق هر ۵ دقیقه، یک کرون واقعی در هاست تنظیم کنید:{" "}
          <code dir="ltr" className="font-mono">wp cron event run --due-now</code> (یا بازدید دوره‌ای از
          wp-cron.php).
        </InfoBox>
      </SectionCard>
    </div>
  );
}
