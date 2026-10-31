"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";

interface Preview { connectionId: string; storeName: string; name: string; action: string; reviewToken: string; payload: Record<string, unknown> }
/** Nothing is selected or published by saving a local product. */
export function ProductPublicationPanel({ localId }: { localId: string }) {
  const [open, setOpen] = useState(false);
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [remoteId, setRemoteId] = useState("");
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const money = useMoney();
  async function show() {
    setOpen(!open);
    if (open) return;
    const result = await api<{ stores?: { id: string; name: string }[]; error?: string }>("/api/products/publications");
    if (!result.ok) setError("اجازهٔ مدیریت اتصال یا دریافت فروشگاه‌ها در دسترس نیست.");
    else setStores(result.data.stores ?? []);
  }
  async function submit(confirm: boolean) {
    setBusy(true); setError(""); setNotice("");
    const result = await api<{ previews?: Preview[]; error?: string }>("/api/products/publications", { method: "POST", body: JSON.stringify({ localId, confirm,
      stores: selected.map((connectionId) => ({ connectionId, ...(remoteId ? { remoteId } : {}), ...(confirm ? { reviewToken: previews.find((p) => p.connectionId === connectionId)?.reviewToken } : {}) })) }) });
    setBusy(false);
    if (!result.ok) {
      setPreviews([]);
      setError(`انتشار انجام نشد؛ قیمت فروش، نگاشت ویژگی‌ها، وضعیت اتصال و تازه بودن بازبینی را بررسی کنید. (${result.data.error ?? "خطای ارتباط"})`);
    } else if (confirm) { setPreviews([]); setNotice("در صف ارسال قرار گرفت. پیوند نهایی فقط پس از تأیید فروشگاه ثبت می‌شود؛ وضعیت ارسال را در مدیریت وردپرس بررسی کنید."); }
    else setPreviews(result.data.previews ?? []);
  }
  return <div className="space-y-2">
    <Button type="button" size="sm" variant="outline" onClick={() => void show()} aria-expanded={open}>انتشار / پیوند فروشگاه</Button>
    {open ? <div className="space-y-3">
      <p className="text-xs text-muted-foreground">ارسال اختیاری است؛ فروشگاه‌ها را انتخاب و نتیجه را بازبینی کنید. موجودی از مسیر همگام‌سازی مستقل ارسال می‌شود.</p>
      <ErrorBox>{error}</ErrorBox>
      {stores.length === 0 && !error ? <p className="text-sm text-muted-foreground">فروشگاه فعال در این شعبه وجود ندارد.</p> : null}
      {stores.map((store) => <label key={store.id} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={selected.includes(store.id)} onChange={(e) => { setSelected((ids) => e.target.checked ? [...ids, store.id] : ids.filter((id) => id !== store.id)); setRemoteId(""); setPreviews([]); }} />{store.name}</label>)}
      <Field label="شناسهٔ محصول موجود در فروشگاه (اختیاری، فقط پیوند)"><input className={inputClass} value={remoteId} inputMode="numeric" disabled={busy || selected.length !== 1} onChange={(e) => { setRemoteId(e.target.value); setPreviews([]); }} /></Field>
      {previews.map((preview) => <div key={preview.connectionId} className="space-y-1 text-sm">
        <p>{preview.storeName} · {preview.name} · {preview.action === "create" ? "ساخت محصول" : preview.action === "link" ? "پیوند بدون تغییر محتوا" : "به‌روزرسانی محصول"}</p>
        <p className="text-xs text-muted-foreground">{String(preview.payload.sku)} · {preview.payload.status === "publish" ? "منتشرشده" : preview.payload.status === "private" ? "خصوصی" : "پیش‌نویس"} · {preview.payload.__children ? `خانواده با ${toPersianDigits((preview.payload.__children as unknown[]).length)} تنوع` : "محصول ساده"}</p>
        {[preview.payload, ...((preview.payload.__children ?? []) as Record<string, unknown>[])].map((product, index) => <div key={index} className="space-y-1 text-xs text-muted-foreground">
          <p>{String(product.name)} · {String(product.sku)} {product.__priceRial ? `· ${money.formatText(String(product.__priceRial))}` : ""}</p>
          {((product.attributes ?? []) as { id: number; option?: string; options?: string[] }[]).map((attribute) => <p key={attribute.id}>ویژگی {toPersianDigits(attribute.id)}: {attribute.option ?? attribute.options?.join("، ")}</p>)}
        </div>)}
        <p className="text-xs text-muted-foreground">{String(preview.payload.description ?? "")}</p>
        <p className="text-xs text-muted-foreground">قیمت و ویژگی‌ها با تنظیمات تأییدشدهٔ همین اتصال ارسال می‌شوند.</p>
      </div>)}
      <Button type="button" size="sm" disabled={busy || selected.length === 0} onClick={() => void submit(previews.length > 0)}>{busy ? "در حال بررسی…" : previews.length ? "تأیید و ارسال موارد بازبینی‌شده" : "بازبینی انتشار / پیوند"}</Button>
      {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
    </div> : null}
  </div>;
}
