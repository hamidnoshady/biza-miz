"use client";

/**
 * The inline provider connection manager for the first-run «ورود اطلاعات» step
 * (GitHub #1580).
 *
 * The issue's rule is that a business owner must be able to connect an existing
 * website *inside the wizard* — never by being sent to `/settings/connections`,
 * `/websites/wp` or `/websites/cms` before onboarding finishes. This component
 * is therefore UI only: it composes the canonical services and adapters that
 * already own credentials, validation, tests and provider health.
 *
 * It deliberately does **not** create a second connections module or table:
 *
 *   - WooCommerce / WordPress: `POST|GET /api/integrations/connections`
 *     (`integration_connections`; plugin link mode for the WordPress plugin,
 *     REST consumer keys otherwise) and `POST /api/integrations/connections/:id/test`.
 *   - Eshobe CMS: `GET /api/cms/website/state`, `POST /api/cms/website/connect`,
 *     `POST /api/connections/website/test`.
 *
 * Secrets live only in the request body that creates the connection and are
 * never kept in wizard state, never logged and never re-read from an API
 * response. The one-time link token a plugin connection returns is shown once,
 * exactly as the settings hub shows it.
 */
import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  Link2Icon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useMoney } from "@/components/money/money-context";
import { ErrorBox, Field, InfoBox, PrimaryButton, SecondaryButton, api, errorMessage, inputClass } from "../ui";

type Provider = "woocommerce" | "wordpress" | "eshobe";

interface ConnectionSummary {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  linkMode: "plugin" | "rest_api";
  status: "active" | "paused" | "error";
  lastTestAt?: string | null;
  lastTestError?: string | null;
  lastSuccessfulTestAt?: string | null;
}

const PROVIDERS: { key: Provider; label: string; hint: string }[] = [
  {
    key: "woocommerce",
    label: "ووکامرس",
    hint: "محصولات، دسته‌ها، مشتریان و سفارش‌های فروشگاه ووکامرس.",
  },
  {
    key: "wordpress",
    label: "وردپرس",
    hint: "محتوای سایت (نوشته‌ها و برگه‌ها) از طریق افزونهٔ وردپرس.",
  },
  {
    key: "eshobe",
    label: "Eshobe CMS",
    hint: "سایت ساخته‌شده روی Eshobe CMS؛ محصولات و محتوای سایت.",
  },
];

export function SetupConnectionSheet({
  open,
  onOpenChange,
  initialProvider = "woocommerce",
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialProvider?: Provider;
  onConnected?: (connectionId: string, provider: Provider) => void;
}) {
  const [provider, setProvider] = useState<Provider>(initialProvider);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    if (provider === "eshobe") {
      setLoading(true);
      const result = await api<{
        connected?: boolean;
        connection?: { siteDomain?: string; status?: string } | null;
        error?: string;
      }>("/api/cms/website/state");
      setLoading(false);
      if (!result.ok) {
        setError(errorMessage(result.data?.error, undefined, result.status));
        return;
      }
      setError("");
      setConnections(
        result.data.connected && result.data.connection?.siteDomain
          ? [
              {
                id: "cms",
                name: result.data.connection.siteDomain,
                provider: "eshobe",
                baseUrl: "",
                linkMode: "rest_api",
                status:
                  result.data.connection.status === "active" ? "active" : "error",
              },
            ]
          : [],
      );
      return;
    }
    setLoading(true);
    const result = await api<{ connections?: ConnectionSummary[]; error?: string }>(
      "/api/integrations/connections?provider=woocommerce",
    );
    setLoading(false);
    if (!result.ok) {
      setError(errorMessage(result.data?.error, undefined, result.status));
      return;
    }
    setError("");
    setConnections(result.data.connections ?? []);
  }, [provider]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  async function testConnection(id: string) {
    setStatus("");
    setError("");
    const path =
      provider === "eshobe"
        ? "/api/connections/website/test"
        : `/api/integrations/connections/${id}/test`;
    const result = await api<{ ok?: boolean; error?: string; siteName?: string }>(path, {
      method: "POST",
    });
    if (!result.ok || result.data.ok === false) {
      setError(
        errorMessage(result.data?.error, undefined, result.status) ||
          "اتصال برقرار نشد. آدرس و دسترسی‌ها را بررسی کنید.",
      );
      return;
    }
    setStatus(
      provider === "eshobe" && result.data.siteName
        ? `اتصال تأیید شد: ${result.data.siteName}`
        : "اتصال با موفقیت بررسی شد.",
    );
    await load();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto sm:max-w-lg"
      >
        <SheetHeader className="border-b border-border">
          <SheetTitle>اتصال سیستم فعلی</SheetTitle>
          <SheetDescription>
            اتصال از همین‌جا ساخته و بررسی می‌شود؛ لازم نیست مرحلهٔ راه‌اندازی را
            ترک کنید. ورود اولیه پس از اتصال، همیشه با نگاشت، پیش‌نمایش و تأیید
            انجام می‌شود و به‌تنهایی همگام‌سازی دوطرفه را روشن نمی‌کند.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 p-4">
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="سرویس">
            {PROVIDERS.map((entry) => {
              const active = provider === entry.key;
              return (
                <button
                  key={entry.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setProvider(entry.key);
                    setStatus("");
                    setError("");
                  }}
                  className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none ${
                    active
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted/40"
                  }`}
                >
                  {entry.label}
                </button>
              );
            })}
          </div>
          <p className="text-xs leading-6 text-muted-foreground">
            {PROVIDERS.find((entry) => entry.key === provider)?.hint}
          </p>

          <ErrorBox>{error}</ErrorBox>
          <p className="sr-only" role="status" aria-live="polite">
            {status}
          </p>
          {status ? (
            <p className="flex items-start gap-2 rounded-lg border border-emerald-600/30 bg-emerald-500/5 px-3 py-2 text-xs leading-5 text-foreground">
              <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
              {status}
            </p>
          ) : null}

          <section aria-label="اتصال‌های موجود" className="space-y-2">
            <h4 className="text-sm font-semibold text-foreground">اتصال‌های موجود</h4>
            {loading ? (
              <div className="space-y-2" aria-hidden="true">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-3/4" />
              </div>
            ) : connections.length === 0 ? (
              <p className="text-xs leading-6 text-muted-foreground">
                هنوز اتصالی برای این سرویس ثبت نشده است.
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {connections.map((connection) => (
                  <li key={connection.id} className="space-y-2 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {connection.name}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        {connection.status === "active"
                          ? "فعال"
                          : connection.status === "paused"
                            ? "متوقف"
                            : "نیازمند بررسی"}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <SecondaryButton onClick={() => void testConnection(connection.id)}>
                        <RefreshCwIcon className="me-1 size-3.5" aria-hidden="true" />
                        بررسی اتصال
                      </SecondaryButton>
                      {onConnected && connection.id !== "cms" ? (
                        <button
                          type="button"
                          onClick={() => onConnected(connection.id, provider)}
                          className="rounded-lg px-2 py-1 text-xs text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                        >
                          استفاده در همین مرحله
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {provider === "eshobe" ? (
            <EshobeForm onSaved={() => void load()} />
          ) : (
            <WooWordPressForm
              provider={provider}
              onSaved={(connectionId) => {
                void load();
                onConnected?.(connectionId, provider);
              }}
            />
          )}

          <p className="flex items-start gap-2 text-[11px] leading-5 text-muted-foreground">
            <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            اطلاعات اتصال فقط در سرور و با سازوکار محافظت‌شدهٔ همین پلتفرم ذخیره
            می‌شود؛ رمز یا کلید در این صفحه، در حافظهٔ مرورگر یا در سیاهه‌ها
            نگهداری نمی‌شود. اتصال به‌تنهایی اجازهٔ نوشتن روی سایت شما را نمی‌دهد.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function WooWordPressForm({
  provider,
  onSaved,
}: {
  provider: "woocommerce" | "wordpress";
  onSaved: (connectionId: string) => void;
}) {
  const money = useMoney();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [mode, setMode] = useState<"plugin" | "rest_api">(
    provider === "wordpress" ? "plugin" : "rest_api",
  );
  const [consumerKey, setConsumerKey] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [currencyUnit, setCurrencyUnit] = useState<"toman" | "rial">(money.unit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [linkToken, setLinkToken] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    setLinkToken("");
    const result = await api<{
      connection?: { id: string };
      linkToken?: string | null;
      error?: string;
    }>("/api/integrations/connections", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        linkMode: mode,
        consumerKey: mode === "rest_api" ? consumerKey.trim() : "",
        consumerSecret: mode === "rest_api" ? consumerSecret.trim() : "",
        currencyUnit,
        // Onboarding is a one-time import: no ongoing pull/push is enabled
        // here. Sync is a separate, explicit opt-in after activation.
        syncOrders: false,
        syncProducts: false,
        syncCustomers: false,
        pushStock: false,
        pushPrices: false,
      }),
    });
    setBusy(false);
    if (!result.ok || !result.data.connection) {
      setError(errorMessage(result.data?.error, undefined, result.status));
      return;
    }
    setConsumerKey("");
    setConsumerSecret("");
    if (result.data.linkToken) setLinkToken(result.data.linkToken);
    onSaved(result.data.connection.id);
  }

  return (
    <form
      className="space-y-3 rounded-xl border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h4 className="text-sm font-semibold text-foreground">
        {provider === "wordpress" ? "اتصال سایت وردپرسی" : "اتصال فروشگاه ووکامرس"}
      </h4>
      <Field label="نام اتصال">
        <input
          className={inputClass}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="فروشگاه اصلی"
          required
        />
      </Field>
      <Field label="آدرس سایت" hint="بدون اسلش پایانی؛ باید با https منتشر شده باشد.">
        <input
          className={inputClass}
          dir="ltr"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://shop.example.com"
          required
        />
      </Field>
      <Field label="روش اتصال">
        <select
          className={inputClass}
          value={mode}
          onChange={(event) => setMode(event.target.value === "plugin" ? "plugin" : "rest_api")}
        >
          <option value="plugin">افزونهٔ وردپرس (پیشنهادی — بدون رمز فروشگاه)</option>
          <option value="rest_api">کلیدهای REST ووکامرس</option>
        </select>
      </Field>
      {mode === "rest_api" ? (
        <>
          <Field label="Consumer key">
            <input
              className={inputClass}
              dir="ltr"
              value={consumerKey}
              onChange={(event) => setConsumerKey(event.target.value)}
              autoComplete="off"
              required
            />
          </Field>
          <Field label="Consumer secret">
            <input
              className={inputClass}
              dir="ltr"
              type="password"
              value={consumerSecret}
              onChange={(event) => setConsumerSecret(event.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>
        </>
      ) : null}
      <Field
        label="واحد قیمت‌های فروشگاه"
        hint="قیمت‌ها هنگام ورود به ریال صحیح تبدیل می‌شوند؛ انتخاب اشتباه، قیمت را ده برابر می‌کند."
      >
        <select
          className={inputClass}
          value={currencyUnit}
          onChange={(event) => setCurrencyUnit(event.target.value === "rial" ? "rial" : "toman")}
        >
          <option value="toman">تومان</option>
          <option value="rial">ریال</option>
        </select>
      </Field>
      <ErrorBox>{error}</ErrorBox>
      {linkToken ? (
        <InfoBox>
          کد اتصال افزونه ساخته شد. آن را در تنظیمات افزونهٔ وردپرس وارد کنید؛ این
          کد فقط همین یک‌بار نمایش داده می‌شود:{" "}
          <code dir="ltr" className="break-all font-mono text-xs">
            {linkToken}
          </code>
        </InfoBox>
      ) : null}
      <PrimaryButton disabled={busy || !name.trim() || !baseUrl.trim()}>
        <Link2Icon className="me-1 size-4" aria-hidden="true" />
        {busy ? "در حال ساخت اتصال…" : "ساخت اتصال"}
      </PrimaryButton>
    </form>
  );
}

function EshobeForm({ onSaved }: { onSaved: () => void }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [siteDomain, setSiteDomain] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyName, setKeyName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    const result = await api<{ error?: string }>("/api/cms/website/connect", {
      method: "POST",
      body: JSON.stringify({
        baseUrl: baseUrl.trim(),
        siteDomain: siteDomain.trim(),
        apiKey: apiKey.trim(),
        keyName: keyName.trim() || undefined,
      }),
    });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result.data?.error, undefined, result.status));
      return;
    }
    setApiKey("");
    onSaved();
  }

  return (
    <form
      className="space-y-3 rounded-xl border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h4 className="text-sm font-semibold text-foreground">اتصال سایت Eshobe</h4>
      <Field label="آدرس کنترل‌پنل" hint="بدون اسلش پایانی.">
        <input
          className={inputClass}
          dir="ltr"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://cms.eshobe.com"
          required
        />
      </Field>
      <Field label="دامنهٔ سایت" hint="فقط میزبان — مثل acme.ir">
        <input
          className={inputClass}
          dir="ltr"
          value={siteDomain}
          onChange={(event) => setSiteDomain(event.target.value)}
          placeholder="acme.ir"
          required
        />
      </Field>
      <Field label="کلید API سایت" hint="کلید فقط یک‌بار در پنل نمایش داده می‌شود.">
        <input
          className={inputClass}
          dir="ltr"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          autoComplete="new-password"
          required
        />
      </Field>
      <Field label="نام اتصال (اختیاری)">
        <input
          className={inputClass}
          value={keyName}
          onChange={(event) => setKeyName(event.target.value)}
          placeholder="پنل مدیریت"
        />
      </Field>
      <ErrorBox>{error}</ErrorBox>
      <PrimaryButton
        disabled={busy || !baseUrl.trim() || !siteDomain.trim() || !apiKey.trim()}
      >
        <Link2Icon className="me-1 size-4" aria-hidden="true" />
        {busy ? "در حال اتصال…" : "اتصال"}
      </PrimaryButton>
      <p className="flex items-start gap-1.5 text-[11px] leading-5 text-muted-foreground">
        <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        درخواست به کنترل‌پنل فقط با همین کلید انجام می‌شود؛ دسترسی نوشتن روی سایت
        جداگانه و صریح است.
      </p>
    </form>
  );
}
