"use client";

/**
 * Issue #866 — the taxpayer's own settings: the profile, the branches' memory
 * identifiers, and the «شناسه کالا/خدمت» of each product. Visible to the members
 * who hold `tax.manage_settings` (the administrator, by default).
 *
 * Credentials are write-only. A stored key is never read back into this screen:
 * the form shows that one exists, and a blank field keeps it. Clearing it is an
 * explicit action.
 */
import { TaxArchiveSettings } from "./tax-archive-settings";
import { useCallback, useEffect, useState } from "react";
import { LoadingSkeleton, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { api, ErrorBox, InfoBox, inputClass, PrimaryButton, SecondaryButton, errorMessageOrRaw } from "@/app/dashboard/ui";
import { TAX_ENVIRONMENT_LABELS, TAX_ITEM_CODE_PATTERN } from "@/lib/tax-invoice";
import type { ProductNeedingCode, TaxSettingsView } from "@/lib/tax-invoice-service";

export interface TaxLocation {
  id: string;
  name: string;
}

type Reply = { error?: string; message?: string };

/** The server's Persian `message` when it sent one, else the mapped error code. */
function errorText(data: unknown): string {
  const reply = (data ?? {}) as Reply;
  return reply.message ?? errorMessageOrRaw(reply.error);
}

export function TaxInvoiceSettings({ onSaved }: { onSaved: () => void }) {
  const [settings, setSettings] = useState<TaxSettingsView | null>(null);
  const [products, setProducts] = useState<ProductNeedingCode[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [environment, setEnvironment] = useState<"sandbox" | "production">("sandbox");
  const [submissionMode, setSubmissionMode] = useState<"direct" | "tsp">("direct");
  const [taxpayerId, setTaxpayerId] = useState("");
  const [taxpayerName, setTaxpayerName] = useState("");
  const [referencePrefix, setReferencePrefix] = useState("");
  const [secret, setSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [tspUsername, setTspUsername] = useState("");
  const [certificatePem, setCertificatePem] = useState("");
  const [units, setUnits] = useState<Record<string, { memoryId: string; unitCode: string }>>({});
  const [codes, setCodes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const [settingsRes, productsRes] = await Promise.all([
      api<TaxSettingsView>("/api/ledger/tax-invoices/settings"),
      api<{ products: ProductNeedingCode[] }>("/api/ledger/tax-invoices/item-codes"),
    ]);
    if (!settingsRes.ok) {
      setError(errorText(settingsRes.data));
      return;
    }
    const data = settingsRes.data;
    setSettings(data);
    setEnabled(data.profile.enabled);
    setEnvironment(data.profile.environment);
    setSubmissionMode(data.profile.submissionMode);
    setTaxpayerId(data.profile.taxpayerId ?? "");
    setTaxpayerName(data.profile.taxpayerName ?? "");
    setReferencePrefix(data.profile.referencePrefix);
    setUnits(
      Object.fromEntries(
        data.units.map((unit) => [unit.locationId, { memoryId: unit.memoryId ?? "", unitCode: unit.unitCode ?? "" }]),
      ),
    );
    if (productsRes.ok) setProducts(productsRes.data.products);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveProfile = async (clearCredentials = false) => {
    setBusy(true);
    setError("");
    setNotice("");
    // A blank field keeps what is stored; a null clears both keys.
    const typed = secret !== "" || certificatePem !== "" || webhookSecret !== "" || tspUsername !== "";
    const credentials = clearCredentials ? null : typed ? { ...(secret ? { secret } : {}), ...(certificatePem ? { certificatePem } : {}), ...(webhookSecret ? { webhookSecret } : {}), ...(tspUsername ? { tspUsername } : {}) } : undefined;
    const res = await api<TaxSettingsView>("/api/ledger/tax-invoices/settings", {
      method: "PUT",
      body: JSON.stringify({
        profile: {
          enabled,
          environment,
          submissionMode,
          taxpayerId,
          taxpayerName,
          referencePrefix,
          ...(credentials !== undefined ? { credentials } : {}),
        },
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorText(res.data));
      return;
    }
    setSecret("");
    setCertificatePem("");
    setWebhookSecret("");
    setTspUsername("");
    setNotice(clearCredentials ? "کلیدهای ارسال پاک شدند." : "تنظیمات مؤدی ذخیره شد.");
    setSettings(res.data);
    onSaved();
  };

  const saveUnits = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    const res = await api<TaxSettingsView>("/api/ledger/tax-invoices/settings", {
      method: "PUT",
      body: JSON.stringify({
        units: Object.entries(units).map(([locationId, value]) => ({
          locationId,
          memoryId: value.memoryId.trim() || null,
          unitCode: value.unitCode.trim() || null,
        })),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorText(res.data));
      return;
    }
    setSettings(res.data);
    setNotice("شناسه‌های حافظه مالیاتی شعبه‌ها ذخیره شد.");
    onSaved();
  };

  const saveCodes = async () => {
    const entries = Object.entries(codes).filter(([, value]) => value.trim() !== "");
    const invalid = entries.find(([, value]) => !TAX_ITEM_CODE_PATTERN.test(value.trim()));
    if (invalid) {
      setError("شناسه کالا/خدمت باید دقیقاً ۱۳ رقم باشد.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const payload = entries.map(([key, value]) => {
      const [productKind, productId] = key.split(":") as ["menu_item" | "item", string];
      return { productKind, productId, code: value.trim() };
    });
    const res = await api<Reply>("/api/ledger/tax-invoices/item-codes", { method: "PUT", body: JSON.stringify({ codes: payload }) });
    setBusy(false);
    if (!res.ok) {
      setError(errorText(res.data));
      return;
    }
    setCodes({});
    setNotice(`${payload.length} شناسه کالا/خدمت ذخیره شد.`);
    await load();
    onSaved();
  };

  if (!settings) return error ? <ErrorBox>{error}</ErrorBox> : <LoadingSkeleton rows={3} label="در حال بارگذاری تنظیمات" />;

  return (
    <div className="space-y-5">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <SectionCard
        title="مؤدی و محیط ارسال"
        description="شناسهٔ مؤدی و روش ارسال. کلیدهای ارسال پس از ذخیره نمایش داده نمی‌شوند."
        actions={<StatusBadge tone={settings.profile.credentialsConfigured ? "positive" : "neutral"}>{settings.profile.credentialsConfigured ? "کلید ذخیره شده است" : "کلیدی ذخیره نشده"}</StatusBadge>}
      >
        <div className="space-y-4">
          {environment === "sandbox" ? (
            <InfoBox>
              محیط آزمایشی به سازمان امور مالیاتی چیزی نمی‌فرستد؛ پذیرش‌ها را یک شبیه‌ساز می‌دهد و هر رکورد با برچسب «آزمایشی» نشان داده می‌شود.
            </InfoBox>
          ) : (
            <ErrorBox>ارسال زنده به سامانه مودیان هنوز فعال نشده است؛ رکوردهای عملیاتی تا فعال‌سازی خطا می‌گیرند و چیزی ارسال نمی‌شود.</ErrorBox>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 rounded border-border text-primary focus-visible:ring-ring/50" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            صدور صورتحساب مؤدی برای این کسب‌وکار فعال باشد
          </label>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">محیط</span>
              <select className={inputClass} value={environment} onChange={(e) => setEnvironment(e.target.value as "sandbox" | "production")}>
                <option value="sandbox">{TAX_ENVIRONMENT_LABELS.sandbox}</option>
                <option value="production">{TAX_ENVIRONMENT_LABELS.production}</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">روش ارسال</span>
              <select className={inputClass} value={submissionMode} onChange={(e) => setSubmissionMode(e.target.value as "direct" | "tsp")}>
                <option value="direct">مستقیم، توسط خود مؤدی</option>
                <option value="tsp">غیرمستقیم، از طریق شرکت معتمد</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">پیشوند شماره ارجاع (حروف و عدد لاتین)</span>
              <input className={inputClass} dir="ltr" maxLength={8} value={referencePrefix} onChange={(e) => setReferencePrefix(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">شناسه مؤدی</span>
              <input className={inputClass} dir="ltr" maxLength={32} value={taxpayerId} onChange={(e) => setTaxpayerId(e.target.value)} />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs text-muted-foreground">نام مؤدی</span>
              <input className={inputClass} maxLength={200} value={taxpayerName} onChange={(e) => setTaxpayerName(e.target.value)} />
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">کلید ارسال (فقط برای نوشتن؛ خالی بماند تا همان بماند)</span>
              <input className={inputClass} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">گواهی (PEM؛ فقط برای نوشتن)</span>
              <textarea className={inputClass} rows={3} dir="ltr" autoComplete="off" value={certificatePem} onChange={(e) => setCertificatePem(e.target.value)} />
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">کلید وب‌هوک شرکت معتمد (حداقل ۳۲ نویسه، فقط نوشتن)</span>
              <input className={inputClass} type="password" autoComplete="off" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">شناسه شرکت معتمد برای توکن (فقط نوشتن)</span>
              <input className={inputClass} autoComplete="off" value={tspUsername} onChange={(e) => setTspUsername(e.target.value)} />
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <PrimaryButton disabled={busy} type="button" onClick={() => void saveProfile(false)}>
              ذخیرهٔ مؤدی
            </PrimaryButton>
            {settings.profile.credentialsConfigured ? (
              <SecondaryButton disabled={busy} onClick={() => void saveProfile(true)}>
                پاک کردن کلیدها
              </SecondaryButton>
            ) : null}
          </div>
        </div>
      </SectionCard>

      <TaxArchiveSettings />

      <SectionCard
        title="حافظهٔ مالیاتی شعبه‌ها"
        description="هر شعبه به یک حافظهٔ مالیاتی وصل است. کد واحد اختیاری است و در شماره ارجاع به کار می‌رود."
        actions={<PrimaryButton disabled={busy} type="button" onClick={() => void saveUnits()}>ذخیرهٔ شعبه‌ها</PrimaryButton>}
      >
        <DataTable caption="حافظهٔ مالیاتی شعبه‌ها">
          <DataTableHead>
            <Th>شعبه</Th>
            <Th>شناسه حافظه مالیاتی</Th>
            <Th>کد واحد</Th>
          </DataTableHead>
          <DataTableBody>
            {settings.units.map((unit) => (
              <DataTableRow key={unit.locationId}>
                <Td>{unit.locationName}</Td>
                <Td>
                  <input
                    className={inputClass}
                    dir="ltr"
                    maxLength={64}
                    value={units[unit.locationId]?.memoryId ?? ""}
                    onChange={(e) =>
                      setUnits((prev) => ({ ...prev, [unit.locationId]: { memoryId: e.target.value, unitCode: prev[unit.locationId]?.unitCode ?? "" } }))
                    }
                  />
                </Td>
                <Td>
                  <input
                    className={inputClass}
                    dir="ltr"
                    maxLength={32}
                    value={units[unit.locationId]?.unitCode ?? ""}
                    onChange={(e) =>
                      setUnits((prev) => ({ ...prev, [unit.locationId]: { memoryId: prev[unit.locationId]?.memoryId ?? "", unitCode: e.target.value } }))
                    }
                  />
                </Td>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      </SectionCard>

      <SectionCard
        title="شناسه کالا/خدمت"
        description="هر کالای فروخته‌شده به یک شناسه ۱۳ رقمی نیاز دارد. فروشی که قلمی بدون شناسه دارد آماده‌سازی نمی‌شود."
        actions={
          products && products.length > 0 ? (
            <PrimaryButton disabled={busy || Object.values(codes).every((value) => value.trim() === "")} type="button" onClick={() => void saveCodes()}>
              ذخیرهٔ شناسه‌ها
            </PrimaryButton>
          ) : null
        }
      >
        {products === null ? (
          <LoadingSkeleton rows={3} label="در حال بارگذاری تنظیمات" />
        ) : products.length === 0 ? (
          <p className="text-sm text-muted-foreground">همهٔ کالاهای فروخته‌شده شناسه دارند.</p>
        ) : (
          <DataTable caption="کالاهای بدون شناسه">
            <DataTableHead>
              <Th>کالا</Th>
              <Th numeric>تعداد فروش</Th>
              <Th>شناسه ۱۳ رقمی</Th>
            </DataTableHead>
            <DataTableBody>
              {products.map((product) => {
                const key = `${product.productKind}:${product.productId}`;
                const value = codes[key] ?? "";
                const invalid = value.trim() !== "" && !TAX_ITEM_CODE_PATTERN.test(value.trim());
                return (
                  <DataTableRow key={key}>
                    <Td>{product.name}</Td>
                    <Td numeric>{product.soldLines}</Td>
                    <Td>
                      <input
                        className={inputClass}
                        dir="ltr"
                        inputMode="numeric"
                        maxLength={13}
                        aria-invalid={invalid || undefined}
                        value={value}
                        onChange={(e) => setCodes((prev) => ({ ...prev, [key]: e.target.value.replace(/\D/g, "") }))}
                      />
                    </Td>
                  </DataTableRow>
                );
              })}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>
    </div>
  );
}
