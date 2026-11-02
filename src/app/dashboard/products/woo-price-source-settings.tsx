"use client";
import { useEffect, useState } from "react";
import { SectionCard, SectionCardSkeleton } from "../page-chrome";
import { api, ErrorBox, Field, InfoBox, inputClass } from "../ui";
import { Button } from "@/components/ui/button";

interface Store { id: string; name: string; priceSource?: string; priceListId?: string | null }
interface List { id: string; name: string; currency: string }
export function WooPriceSourceSettings() {
  const [stores, setStores] = useState<Store[]>([]);
  const [lists, setLists] = useState<List[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void Promise.all([
      api<{ connections?: Store[]; error?: string }>("/api/integrations/connections?provider=woocommerce"),
      api<{ lists?: List[] }>("/api/products/price-lists?limit=1"),
    ]).then(([s, p]) => {
      if (!active) return;
      setLoading(false);
      if (s.ok && p.ok) { setStores(s.data.connections ?? []); setLists((p.data.lists ?? []).filter(l => ["IRR", "IRT"].includes(l.currency))); }
      else if (s.status !== 403) setError("تنظیمات قیمت فروشگاه بارگیری نشد.");
    });
    return () => { active = false; };
  }, []);
  if (loading) return <SectionCardSkeleton rows={2} />;
  if (!stores.length && !error) return null;
  return <SectionCard title="قیمت فروشگاه‌های متصل">
    <InfoBox>هر فروشگاه قیمت فروش پایه یا یک لیست مشخص را دریافت می‌کند. قیمت خالی در لیست انتخابی ارسال نمی‌شود؛ قیمت خرید هرگز ارسال نمی‌شود.</InfoBox>
    <ErrorBox>{error}</ErrorBox>
    {notice ? <p role="status">{notice}</p> : null}
    <div className="space-y-3">{stores.map(store => <div key={store.id} className="flex flex-wrap items-end gap-3">
      <Field label={store.name}><select className={inputClass} disabled={busy} value={store.priceSource === "list" ? store.priceListId ?? "" : "base"}
        onChange={event => setStores(current => current.map(s => s.id === store.id ? { ...s, priceSource: event.target.value === "base" ? "base" : "list", priceListId: event.target.value === "base" ? null : event.target.value } : s))}>
        <option value="base">قیمت فروش پایه</option>{lists.map(list => <option key={list.id} value={list.id}>{list.name}</option>)}
      </select></Field>
      <Button type="button" variant="outline" disabled={busy} onClick={async () => {
        setBusy(true); setError(""); setNotice("");
        const result = await api(`/api/integrations/connections/${store.id}`, { method: "PATCH", body: JSON.stringify({ priceSource: store.priceSource ?? "base", priceListId: store.priceListId ?? null }) });
        setBusy(false);
        if (!result.ok) setError("ذخیره انجام نشد؛ دسترسی مدیریت اتصال و شعبهٔ لیست را بررسی کنید.");
        else setNotice("منبع قیمت ذخیره شد؛ ارسال از صف همگام‌سازی و مطابق کلید ارسال قیمت فروشگاه انجام می‌شود.");
      }}>ذخیرهٔ منبع قیمت</Button>
    </div>)}</div>
  </SectionCard>;
}
