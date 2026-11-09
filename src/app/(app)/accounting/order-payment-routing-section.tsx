"use client";

import { useEffect, useState, type FormEvent } from "react";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessageOrRaw, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import type { FinancialAccountKind } from "@/lib/financial-accounts";
import { paymentSourceKindForSettlement } from "@/lib/order-payment-routing";
import type { WebsitePaymentRoute } from "@/lib/order-payment-routing-service";

const ENDPOINT = "/api/ledger/order-payment-sources";

interface SettingsView {
  mode: "enabled" | "disabled" | "peer_unsupported";
  enabled: boolean;
  websiteRoutes: WebsitePaymentRoute[];
  sources: { id: string; name: string; kind: FinancialAccountKind }[];
  connections: { id: string; name: string; provider: WebsitePaymentRoute["provider"] }[];
}

export function OrderPaymentRoutingSection() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [routes, setRoutes] = useState<(WebsitePaymentRoute & { key: string })[]>([]);
  const [approvalReference, setApprovalReference] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api<SettingsView>(`${ENDPOINT}?configure=1`).then(({ ok, data }) => {
      if (!active) return;
      if (!ok || !data) {
        setError("تنظیمات مسیر پرداخت بارگیری نشد.");
        return;
      }
      setView(data);
      setEnabled(data.enabled);
      setRoutes(data.websiteRoutes.map((route) => ({ ...route, key: crypto.randomUUID() })));
    }).catch(() => { if (active) setError("تنظیمات مسیر پرداخت بارگیری نشد."); });
    return () => { active = false; };
  }, []);

  function editRoute(key: string, patch: Partial<WebsitePaymentRoute>) {
    setSaved(false);
    setRoutes((current) => current.map((route) => route.key === key ? { ...route, ...patch } : route));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const { ok, data } = await api<{ error?: string }>(ENDPOINT, {
        method: "PUT",
        body: JSON.stringify({ enabled, approvalReference: approvalReference.trim(),
          websiteRoutes: routes.map(({ key: _key, ...route }) => route) }),
      });
      if (!ok) {
        setError(errorMessageOrRaw(data?.error));
        return;
      }
      setSaved(true);
      setApprovalReference("");
    } catch {
      setError("ذخیره تنظیمات مسیر پرداخت انجام نشد.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard title="مسیر پرداخت‌های شعبه">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {saved ? <p role="status" className="mb-3 text-sm">تنظیمات ثبت شد.</p> : null}
      {view ? (
        <form className="space-y-3" onSubmit={save}>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} disabled={saving || (view.mode === "peer_unsupported" && !enabled)}
              onChange={(event) => { setEnabled(event.target.checked); setSaved(false); }} />
            ثبت حساب واقعی برای پرداخت‌های جدید این شعبه
          </label>
          {view.mode === "peer_unsupported" ? (
            <p className="text-sm text-muted-foreground">فعال‌سازی برای شعبه‌های متصل به دستگاه همگام‌شده در دسترس نیست.</p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            پس از تأیید آمادگی شعبه، برای هر اتصال سایت، روش پرداخت و حساب واقعی آن را مشخص کنید.
          </p>
          {routes.map((route) => (
            <div key={route.key} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2">
              <Field label="اتصال سایت">
                <select required className={inputClass} value={route.connectionId} disabled={saving} onChange={(event) => {
                  const connection = view.connections.find((item) => item.id === event.target.value);
                  if (connection) editRoute(route.key, {
                    connectionId: connection.id, provider: connection.provider,
                    gateway: connection.provider === "cms" ? "default" : "",
                  });
                }}>
                  <option value="">انتخاب کنید</option>
                  {view.connections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </Field>
              {route.provider === "woocommerce" ? <Field label="کد روش پرداخت ووکامرس">
                <input required className={inputClass} dir="ltr" value={route.gateway} maxLength={100} disabled={saving}
                  onChange={(event) => editRoute(route.key, { gateway: event.target.value.trim() })} />
              </Field> : null}
              <Field label="نوع دریافت">
                <select className={inputClass} value={route.settlement} disabled={saving} onChange={(event) =>
                  editRoute(route.key, { settlement: event.target.value as WebsitePaymentRoute["settlement"], financialAccountId: "" })}>
                  <option value="online">درگاه و وجوه در راه</option>
                  <option value="card_to_card">واریز مستقیم به بانک</option>
                  <option value="cash">دریافت نقدی</option>
                </select>
              </Field>
              <Field label="حساب دریافت">
                <select required className={inputClass} value={route.financialAccountId} disabled={saving}
                  onChange={(event) => editRoute(route.key, { financialAccountId: event.target.value })}>
                  <option value="">انتخاب کنید</option>
                  {view.sources.filter((source) => source.kind === paymentSourceKindForSettlement(route.settlement))
                    .map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
                </select>
              </Field>
              <div><SecondaryButton onClick={() => setRoutes((current) => current.filter((row) => row.key !== route.key))} disabled={saving}>حذف مسیر</SecondaryButton></div>
            </div>
          ))}
          {view.connections.length > 0 ? <div><SecondaryButton disabled={saving} onClick={() => {
            setSaved(false);
            setRoutes((current) => [...current, { key: crypto.randomUUID(), provider: "cms",
              connectionId: "", gateway: "default", settlement: "online", financialAccountId: "" }]);
          }}>افزودن مسیر سایت</SecondaryButton></div> : null}
          <Field label="مرجع تأیید یا دلیل تغییر">
            <input required className={inputClass} value={approvalReference} maxLength={240} disabled={saving}
              onChange={(event) => setApprovalReference(event.target.value)} />
          </Field>
          <div className="max-w-xs"><PrimaryButton type="submit" disabled={saving || !approvalReference.trim()}>ذخیره مسیر پرداخت</PrimaryButton></div>
        </form>
      ) : null}
    </SectionCard>
  );
}
