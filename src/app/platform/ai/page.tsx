"use client";

/**
 * Super-admin AI console.
 *
 * Ownership boundaries:
 * - This page: LiteLLM connection and business virtual-key lifecycle only.
 * - LiteLLM: upstream providers, model deployments, routing, retries, fallback
 *   and provider/MCP behaviour.
 * - Plan/Billing: prices, wallet balance, included AI allowance, top-ups,
 *   overage and monetisation.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Loader2Icon } from "lucide-react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { api, Button, Card, ErrorBox, Field, InfoBox, inputClass, errorMessage, useCan, PlatformPageSkeleton } from "../ui";

interface GatewayConfig {
  enabled: boolean;
  baseUrl: string;
  chatModel: string;
  embeddingModel: string;
  virtualKeysEnabled: boolean;
  hasMasterKey: boolean;
}

interface LocationSummary {
  id: string;
  businessId: string;
  name: string;
}

interface BusinessGateway {
  businessId: string;
  locationId: string | null;
  keyAlias: string | null;
  syncedAt: string | null;
  syncError: string | null;
  hasVirtualKey: boolean;
  effectiveModel: string;
}

interface GatewayProbeStage {
  key: string;
  label: string;
  ok: boolean;
  skipped?: boolean;
  status: number | null;
  model: string | null;
  message: string | null;
  detail: string | null;
}

interface GatewayStatus {
  ok: boolean;
  latencyMs: number | null;
  models: string[];
  error: string | null;
  stages: GatewayProbeStage[];
}

interface RuntimeReadiness {
  ready: boolean;
  reason: string | null;
  gatewayReady: boolean;
  authenticationReady: boolean;
  virtualKeyRequired: boolean;
  virtualKeyReady: boolean;
  modelReady: boolean;
}

interface TenantReadiness extends RuntimeReadiness {
  businessId: string;
  entitled: boolean;
}

interface GatewayData {
  gateway: GatewayConfig | null;
  provider: string;
  platformModel: string;
  platformBaseUrl: string;
  providerIsGateway: boolean;
  active: boolean;
  runtimeReadiness: RuntimeReadiness;
  tenantReadiness: TenantReadiness[];
  status: GatewayStatus | null;
  gateways: BusinessGateway[];
  businesses: BusinessSummary[];
  locations: LocationSummary[];
  error?: string;
}

interface BusinessSummary {
  businessId: string;
  businessName: string;
  aiEntitled: boolean;
}

function fmtDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

const READINESS_REASON_FA: Record<string, string> = {
  platform_disabled: "هوش مصنوعی پلتفرم غیرفعال است",
  gateway_disabled: "دروازه LiteLLM غیرفعال است",
  missing_base_url: "نشانی Base URL تنظیم نشده است",
  invalid_base_url: "نشانی Base URL معتبر نیست",
  missing_runtime_credential: "اعتبارنامهٔ اجرای درخواست موجود نیست",
  tenant_virtual_key_missing: "کلید مجازی این کسب‌وکار صادر نشده است",
  missing_model: "مدل گفت‌وگو تنظیم نشده است",
  invalid_max_output_tokens: "سقف توکن خروجی معتبر نیست",
  configuration_load_failed: "خواندن تنظیمات/ساختار پایگاه داده ناموفق بود؛ مهاجرت‌ها و لاگ سرور را بررسی کنید",
};

function readinessText(readiness: RuntimeReadiness | undefined): string {
  if (!readiness) return "نامشخص";
  return readiness.ready ? "آماده" : (readiness.reason ? READINESS_REASON_FA[readiness.reason] ?? readiness.reason : "نیازمند تنظیم");
}

function stageText(stage: GatewayProbeStage): string {
  if (stage.skipped) return "رد شد";
  return stage.ok ? "موفق" : "ناموفق";
}

export default function PlatformAiPage() {
  const can = useCan();
  const [data, setData] = useState<GatewayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<GatewayConfig | null>(null);
  const [masterKey, setMasterKey] = useState("");
  const [selectedBusinessId, setSelectedBusinessId] = useState("");
  const [selectedLocationId, setSelectedLocationId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const result = await api<GatewayData>("/api/platform/ai/gateway");
    if (!result.ok) {
      setError(result.data.error === "ai_configuration_load_failed"
        ? "خواندن تنظیمات هوش مصنوعی ناموفق بود؛ اجرای مهاجرت‌های پایگاه داده و لاگ سرور را بررسی کنید."
        : result.data.error ? errorMessage(result.data.error) : "خواندن تنظیمات دروازه ممکن نشد.");
      setLoading(false);
      return;
    }
    setData(result.data);
    setDraft(result.data.gateway);
    setSelectedBusinessId((current) =>
      current && (result.data.businesses ?? []).some((b) => b.businessId === current) ? current : "",
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const businessLocations = useMemo(
    () => (data?.locations ?? []).filter((loc) => loc.businessId === selectedBusinessId),
    [data?.locations, selectedBusinessId],
  );

  const selectedRow = useMemo(() => {
    if (!data?.gateways || !selectedBusinessId) return null;
    const loc = selectedLocationId || null;
    return data.gateways.find((row) => row.businessId === selectedBusinessId && row.locationId === loc) ?? null;
  }, [data?.gateways, selectedBusinessId, selectedLocationId]);

  const selectedReadiness = useMemo(
    () => data?.tenantReadiness?.find((item) => item.businessId === selectedBusinessId),
    [data?.tenantReadiness, selectedBusinessId],
  );

  const keyRows = useMemo(() => {
    const businesses = data?.businesses ?? [];
    const gateways = data?.gateways ?? [];
    return businesses.map((business) => {
      const key = gateways.find((row) => row.businessId === business.businessId && row.locationId === null);
      const readiness = data?.tenantReadiness?.find((item) => item.businessId === business.businessId) ?? null;
      return { business, key: key ?? null, readiness };
    });
  }, [data?.businesses, data?.gateways, data?.tenantReadiness]);

  async function write(body: Record<string, unknown>, key: string, method: "PUT" | "POST" = "POST") {
    setBusy(key);
    setError("");
    setNotice("");
    const result = await api<{
      error?: string;
      detail?: string | null;
      gateway?: { syncError?: string | null };
      status?: GatewayStatus;
    }>("/api/platform/ai/gateway", { method, body: JSON.stringify(body) });
    setBusy("");
    if (!result.ok) {
      const message = result.data.error ? errorMessage(result.data.error) : "انجام عملیات ممکن نشد.";
      setError(result.data.detail ? `${message} — ${result.data.detail}` : message);
      if (result.data.status) setData((current) => (current ? { ...current, status: result.data.status ?? null } : current));
      return false;
    }
    if (result.data.status) setData((current) => (current ? { ...current, status: result.data.status ?? null } : current));
    if (result.data.gateway?.syncError) {
      setError(result.data.gateway.syncError);
      await load();
      return false;
    }
    setNotice("تغییرات ذخیره شد.");
    await load();
    return true;
  }

  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    await write(
      {
        action: "config",
        gateway: { ...draft, masterKey: masterKey || undefined },
      },
      "config",
      "PUT",
    );
    setMasterKey("");
  }

  async function probe() {
    if (!draft) return;
    setBusy("probe");
    setError("");
    setNotice("");
    const result = await api<{ status: GatewayStatus; error?: string }>("/api/platform/ai/gateway", {
      method: "PUT",
      body: JSON.stringify({ action: "probe", gateway: { ...draft, masterKey: masterKey || undefined } }),
    });
    setBusy("");
    if (!result.ok) {
      setError(result.data.error ? errorMessage(result.data.error) : "بررسی ارتباط ممکن نشد.");
      return;
    }
    setData((current) => (current ? { ...current, status: result.data.status } : current));
  }

  if (loading) return <PlatformPageSkeleton />;

  const status = data?.status;
  const canManageAi = can("ai.config.manage");

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 sm:space-y-6">
      <header>
        <h1 className="text-xl font-bold">تنظیمات هوش مصنوعی (LiteLLM)</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          این صفحه فقط اتصال فنی LiteLLM و چرخهٔ عمر کلیدهای مجازی کسب‌وکارها را مدیریت می‌کند. مدل‌ها، ارائه‌دهنده‌ها، مسیر‌یابی و fallback در LiteLLM تنظیم می‌شوند؛ قیمت، اعتبار و درآمد در بخش Plan/Billing است.
        </p>
      </header>

      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <Card title="LiteLLM Connection">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">وضعیت اجرای پلتفرم</dt>
            <dd className="mt-1 font-medium">{readinessText(data?.runtimeReadiness)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">مدل گفت‌وگو</dt>
            <dd className="mt-1 font-medium" dir="ltr">{draft?.chatModel || data?.platformModel || "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">کلید مدیر</dt>
            <dd className="mt-1 font-medium">{draft?.hasMasterKey ? "ثبت شده" : "ثبت نشده"}</dd>
          </div>
          <div className="sm:col-span-3">
            <dt className="text-muted-foreground">Base URL</dt>
            <dd className="mt-1 font-medium" dir="ltr">{draft?.baseUrl ?? data?.platformBaseUrl ?? "—"}</dd>
          </div>
        </dl>

        {status ? (
          <div className="mt-4 rounded-lg border border-border bg-card p-3 text-sm">
            <p className={status.ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}>
              {status.ok ? "تست اتصال موفق بود" : status.error ?? "تست اتصال ناموفق بود"}
              {status.latencyMs !== null ? ` · ${status.latencyMs}ms` : ""}
            </p>
            <div className="mt-3 grid gap-2">
              {(status.stages ?? []).map((stage) => (
                <div key={stage.key} className="rounded-md border border-border p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>{stage.label}</strong>
                    <span className={stage.ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}>{stageText(stage)}</span>
                    {stage.status ? <span dir="ltr">HTTP {stage.status}</span> : null}
                    {stage.model ? <span dir="ltr">Model: {stage.model}</span> : null}
                  </div>
                  {stage.message ? <p className="mt-1 text-xs text-muted-foreground">{stage.message}</p> : null}
                  {stage.detail ? <p className="mt-1 text-xs text-muted-foreground" dir="ltr">{stage.detail}</p> : null}
                </div>
              ))}
            </div>
            {status.models.length > 0 ? <p className="mt-2 text-xs text-muted-foreground" dir="ltr">{status.models.join("، ")}</p> : null}
          </div>
        ) : null}

        {canManageAi && draft ? (
          <form onSubmit={saveConfig} className="mt-4 grid gap-4 lg:grid-cols-2">
            <label className="flex items-center gap-2 text-sm text-foreground lg:col-span-2">
              <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
              Enabled
            </label>
            <Field label="Base URL">
              <input className={inputClass} dir="ltr" value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
            </Field>
            <Field label="Master key" hint={draft.hasMasterKey ? "کلید ذخیره شده است؛ برای حفظ آن خالی بگذارید." : "کلید مدیر LiteLLM را وارد کنید."}>
              <input className={inputClass} dir="ltr" type="password" value={masterKey} onChange={(event) => setMasterKey(event.target.value)} autoComplete="off" />
            </Field>
            <Field label="Default chat model alias" hint="باید دقیقاً در /model/info LiteLLM وجود داشته باشد، مانند pos-chat.">
              <input className={inputClass} dir="ltr" placeholder="pos-chat" value={draft.chatModel} onChange={(event) => setDraft({ ...draft, chatModel: event.target.value })} />
            </Field>
            <Field label="Embedding model alias" hint="اگر RAG/embeddings فعال است، alias مدل بردارسازی را وارد کنید.">
              <input className={inputClass} dir="ltr" placeholder="pos-embed" value={draft.embeddingModel} onChange={(event) => setDraft({ ...draft, embeddingModel: event.target.value })} />
            </Field>
            <label className="flex items-center gap-2 text-sm text-foreground lg:col-span-2">
              <input type="checkbox" checked={draft.virtualKeysEnabled} onChange={(event) => setDraft({ ...draft, virtualKeysEnabled: event.target.checked })} />
              صدور و استفاده از کلید مجازی برای کسب‌وکارها
            </label>
            <div className="flex flex-wrap gap-2 lg:col-span-2">
              <Button type="submit" disabled={busy === "config"}>{busy === "config" ? "در حال ذخیره…" : "Save"}</Button>
              <Button type="button" variant="ghost" onClick={() => void probe()} disabled={Boolean(busy)}>
                {busy === "probe" ? <Loader2Icon className="animate-spin" /> : "Test connection"}
              </Button>
            </div>
          </form>
        ) : null}
      </Card>

      <Card title="Business Virtual Keys">
        <p className="mb-3 text-sm text-muted-foreground">
          کلیدهای مجازی secret هستند و نمایش داده نمی‌شوند. هر ردیف فقط alias، وضعیت همگام‌سازی و آمادگی runtime را نشان می‌دهد.
        </p>
        {!data?.active ? (
          <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            runtime هنوز آماده نیست: {readinessText(data?.runtimeReadiness)}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 mb-4">
          <Field label="کسب‌وکار">
            <SearchableSelect
              value={selectedBusinessId}
              onChange={(value) => { setSelectedBusinessId(value); setSelectedLocationId(""); }}
              options={(data?.businesses ?? []).map((business) => ({ value: business.businessId, label: business.businessName }))}
            />
          </Field>
          {businessLocations.length > 0 ? (
            <Field label="شعبه (اختیاری)">
              <SearchableSelect
                value={selectedLocationId}
                onChange={setSelectedLocationId}
                options={[{ value: "", label: "کل کسب‌وکار (پیش‌فرض)" }, ...businessLocations.map((loc) => ({ value: loc.id, label: loc.name }))]}
              />
            </Field>
          ) : null}
        </div>

        {selectedBusinessId ? (
          <div className="space-y-4 border-t border-border pt-4">
            <div className={`rounded-lg border p-3 text-sm ${selectedReadiness?.ready && selectedReadiness.entitled ? "border-emerald-300 bg-emerald-50 dark:bg-emerald-500/10" : "border-amber-300 bg-amber-50 dark:bg-amber-500/10"}`}>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <p>AI entitlement: <strong>{selectedReadiness?.entitled ? "فعال" : "غیرفعال"}</strong></p>
                <p>کلید مجازی: <strong>{selectedReadiness?.virtualKeyRequired ? (selectedReadiness.virtualKeyReady ? "آماده" : "نیازمند صدور/رفع خطا") : "الزامی نیست"}</strong></p>
                <p>Runtime: <strong>{selectedReadiness?.ready && selectedReadiness.entitled ? "آماده" : "نیازمند تنظیم"}</strong></p>
              </div>
              {selectedReadiness && (!selectedReadiness.ready || !selectedReadiness.entitled) ? (
                <p className="mt-2 text-xs text-muted-foreground">علت: {!selectedReadiness.entitled ? "دسترسی ai_assistant فعال نشده است" : readinessText(selectedReadiness)}</p>
              ) : null}
            </div>
            <div className="grid gap-2 text-sm sm:grid-cols-3">
              <p>مدل مؤثر: <strong dir="ltr" className="font-medium">{selectedRow?.effectiveModel ?? draft?.chatModel ?? "—"}</strong></p>
              <p>وضعیت کلید: {selectedRow?.hasVirtualKey ? "صادر شده" : "صادر نشده"}</p>
              <p>Key alias: <span dir="ltr">{selectedRow?.keyAlias ?? "—"}</span></p>
              <p>آخرین همگام‌سازی: {fmtDate(selectedRow?.syncedAt ?? null)}</p>
            </div>
            {selectedRow?.syncError ? <ErrorBox>{selectedRow.syncError}</ErrorBox> : null}
            {canManageAi ? (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void write({ action: "sync_key", businessId: selectedBusinessId, locationId: selectedLocationId || null }, "sync")} disabled={Boolean(busy)}>
                  {busy === "sync" ? <Loader2Icon className="animate-spin" /> : "Provision"}
                </Button>
                <Button variant="ghost" onClick={() => void write({ action: "verify_key", businessId: selectedBusinessId, locationId: selectedLocationId || null }, "verify")} disabled={Boolean(busy) || !selectedRow?.hasVirtualKey}>
                  {busy === "verify" ? <Loader2Icon className="animate-spin" /> : "Verify"}
                </Button>
                <Button variant="ghost" onClick={() => void write({ action: "rotate_key", businessId: selectedBusinessId, locationId: selectedLocationId || null }, "rotate")} disabled={Boolean(busy)}>
                  {busy === "rotate" ? <Loader2Icon className="animate-spin" /> : "Rotate/recreate"}
                </Button>
                <Button variant="danger" onClick={() => void write({ action: "revoke_key", businessId: selectedBusinessId, locationId: selectedLocationId || null }, "revoke")} disabled={Boolean(busy) || !selectedRow?.hasVirtualKey}>
                  {busy === "revoke" ? <Loader2Icon className="animate-spin" /> : "Revoke"}
                </Button>
              </div>
            ) : null}
          </div>
        ) : <p className="text-sm text-muted-foreground">یک کسب‌وکار را انتخاب کنید.</p>}

        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-right text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-2 pr-1">کسب‌وکار</th>
                <th className="py-2">AI entitlement</th>
                <th className="py-2">Key status</th>
                <th className="py-2">Key alias</th>
                <th className="py-2">Last synced</th>
                <th className="py-2">Runtime readiness</th>
                <th className="py-2">Technical error</th>
              </tr>
            </thead>
            <tbody>
              {keyRows.map(({ business, key, readiness }) => (
                <tr key={business.businessId} className="border-b border-border">
                  <td className="py-2 pr-1 font-medium text-foreground">{business.businessName}</td>
                  <td className="py-2">{business.aiEntitled ? "فعال" : "غیرفعال"}</td>
                  <td className="py-2">{key?.hasVirtualKey ? (key.syncError ? "خطای همگام‌سازی" : "صادر شده") : "صادر نشده"}</td>
                  <td className="py-2" dir="ltr">{key?.keyAlias ?? "—"}</td>
                  <td className="py-2">{fmtDate(key?.syncedAt ?? null)}</td>
                  <td className="py-2">{readiness?.ready && business.aiEntitled ? "آماده" : readinessText(readiness ?? undefined)}</td>
                  <td className="py-2 text-xs text-rose-700 dark:text-rose-300">{key?.syncError ?? "—"}</td>
                </tr>
              ))}
              {keyRows.length === 0 ? (
                <tr><td colSpan={7} className="py-6 text-center text-muted-foreground">هنوز کسب‌وکاری ثبت نشده است.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
