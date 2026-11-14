"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { barcodeEntryError, classifyBarcode, normalizeBarcode } from "@/lib/barcode";
import { printLabel } from "@/lib/printing/client";
import { printerErrorMessage } from "@/lib/printing/errors";
import { normalizeListSearch } from "@/lib/product-list";
import { SearchField } from "../filters";
import { EmptyState, SectionCard, SectionCardSkeleton } from "../page-chrome";
import { api, Field, inputClass } from "../ui";

type Item = { id: string; name: string; sku: string | null };
type Barcode = { id: string; itemId: string; code: string };

/** Assign supplied codes and print persisted item barcodes through native services. */
export function SpecialistLabelPrinter({ industry, canPrint, canAssign, locationId }: { industry: "jewelry" | "watch"; canPrint: boolean; canAssign: boolean; locationId: string | null }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [listError, setListError] = useState(false);
  const [listVersion, setListVersion] = useState(0);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Item | null>(null);
  const [barcodes, setBarcodes] = useState<Barcode[] | null>(null);
  const [codeError, setCodeError] = useState(false);
  const [codeVersion, setCodeVersion] = useState(0);
  const [manualCode, setManualCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const inFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setListError(false); setItems(null);
    void api<{ items?: Item[] }>(`/api/${industry}/items`, { signal: controller.signal }).then((res) => {
      if (controller.signal.aborted) return;
      if (!res.ok || !Array.isArray(res.data?.items)) setListError(true);
      else setItems(res.data.items);
    });
    return () => controller.abort();
  }, [industry, listVersion]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setBarcodes(null); setCodeError(false);
    void api<{ barcodes?: Barcode[] }>(`/api/barcodes?itemId=${encodeURIComponent(selected.id)}`, { signal: controller.signal }).then((res) => {
      if (controller.signal.aborted) return;
      if (!res.ok || !Array.isArray(res.data?.barcodes) || res.data.barcodes.some((code) => code.itemId !== selected.id)) setCodeError(true);
      else setBarcodes(res.data.barcodes);
    });
    return () => controller.abort();
  }, [selected, codeVersion]);
  const filtered = useMemo(() => {
    const needle = normalizeListSearch(search);
    return (items ?? []).filter((item) => normalizeListSearch(`${item.name} ${item.sku ?? ""}`).includes(needle));
  }, [items, search]);
  async function print(code: string) {
    if (!canPrint || !selected || busy || uncertain || inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage("");
    try {
      // The document is an item and one of its persisted codes, never client-built label data.
      const result = await printLabel(null, { itemId: selected.id, code }, { requestId: `product-label:${crypto.randomUUID()}` });
      if (result.ok) setMessage("درخواست به چاپگر ارسال شد؛ خروجی چاپگر را بررسی کنید.");
      else if (result.ambiguous) { setUncertain(true); setMessage("نتیجهٔ ارسال نامشخص است و ممکن است برچسب چاپ شده باشد؛ پیش از چاپ دوباره، چاپگر و تاریخچهٔ چاپ را بررسی کنید."); }
      else setMessage(printerErrorMessage(result.error));
    } catch {
      setUncertain(true); setMessage("نتیجهٔ ارسال نامشخص است؛ پیش از چاپ دوباره، چاپگر و تاریخچهٔ چاپ را بررسی کنید.");
    } finally { inFlight.current = false; setBusy(false); }
  }
  async function assign(event: React.FormEvent) {
    event.preventDefault();
    if (!canAssign || !locationId || !selected || busy || uncertain || inFlight.current) return;
    const code = normalizeBarcode(manualCode);
    const error = barcodeEntryError(code);
    if (error || !classifyBarcode(code)) { setMessage(error ?? "بارکد معتبر ۱۲ یا ۱۳ رقمی وارد کنید."); return; }
    inFlight.current = true; setBusy(true); setMessage("");
    try {
      // A caller-supplied, unique code makes a retry deterministic. Never
      // silently mint a second random code after an uncertain response.
      const res = await api<{ ok?: boolean; error?: string }>("/api/barcodes", {
        method: "POST", body: JSON.stringify({ itemId: selected.id, code, expectedLocationId: locationId }),
      });
      if (res.ok && res.data?.ok === true) { setManualCode(""); setMessage("بارکد ثبت شد؛ فهرست بارکدها بازخوانی می‌شود."); setCodeVersion((n) => n + 1); }
      else if (res.data?.error === "location_changed") { setMessage("شعبهٔ فعال تغییر کرده است؛ صفحه را دوباره باز کنید."); setUncertain(true); }
      else { setMessage("ثبت تأیید نشد یا نتیجه مشخص نیست؛ فهرست بارکدها را بررسی کنید. ثبت دوبارهٔ همان کد تکراری نخواهد ساخت."); setUncertain(true); setCodeVersion((n) => n + 1); }
    } catch {
      setMessage("نتیجهٔ ثبت مشخص نیست؛ فهرست بارکدها را بررسی کنید."); setUncertain(true); setCodeVersion((n) => n + 1);
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <SectionCard title="بارکد و برچسب کالای ثبت‌شده" description={industry === "watch" ? "برچسب بر اساس مدل ساعت ساخته می‌شود؛ تنها کدی که با شماره‌سریال ثبت‌شده منطبق باشد ممکن است دستگاه را نیز شناسایی کند. چاپ از مسیر و قالب تنظیم‌شدهٔ شعبه انجام می‌شود." : "برچسب از بارکد و مشخصات واقعی قطعه در شعبهٔ فعال ساخته می‌شود. چاپ از مسیر و قالب تنظیم‌شدهٔ شعبه انجام می‌شود."}>
    <fieldset disabled={busy || uncertain} className="space-y-3">
      <SearchField label="جستجوی کالا برای بارکد و برچسب" value={search} onChange={(value) => { setSearch(value); setSelected(null); setManualCode(""); setMessage(""); }} />
      {listError ? <div role="alert" className="space-y-2"><p>فهرست کالا دریافت نشد.</p><Button variant="outline" onClick={() => setListVersion((n) => n + 1)}>تلاش دوباره</Button></div> : !items ? <SectionCardSkeleton rows={2} /> : filtered.length === 0 ? <EmptyState>کالایی پیدا نشد.</EmptyState> : <ul className="max-h-64 overflow-y-auto divide-y divide-border/80">{filtered.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><span className="break-words">{item.name}{item.sku ? <> · <bdi dir="ltr">{item.sku}</bdi></> : null}</span><Button variant="outline" aria-label={`انتخاب ${item.name}${item.sku ? ` ${item.sku}` : ""}`} onClick={() => { setBarcodes(null); setCodeError(false); setSelected({ ...item }); setManualCode(""); setMessage(""); }}>انتخاب</Button></li>)}</ul>}
      {selected ? <div className="space-y-2"><h3 className="font-semibold">بارکدهای {selected.name}</h3>{codeError ? <div role="alert"><p>بارکدها دریافت نشدند؛ شعبه و دسترسی را بررسی کنید.</p><Button variant="outline" onClick={() => setCodeVersion((n) => n + 1)}>تلاش دوباره</Button></div> : !barcodes ? <SectionCardSkeleton rows={2} /> : barcodes.length === 0 ? <EmptyState>برای این کالا بارکدی ثبت نشده است.</EmptyState> : <ul className="divide-y divide-border/80">{barcodes.map((barcode) => <li key={barcode.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><bdi dir="ltr">{barcode.code}</bdi>{canPrint && classifyBarcode(barcode.code) ? <Button onClick={() => void print(barcode.code)} aria-label={`چاپ برچسب ${selected.name} ${barcode.code}`}>{busy ? "در حال ارسال…" : "چاپ برچسب"}</Button> : canPrint ? <span className="text-sm text-muted-foreground">چاپ این کد فقط متن است و میلهٔ قابل اسکن ندارد.</span> : null}</li>)}</ul>}{canAssign ? locationId ? <form onSubmit={assign} className="max-w-md space-y-2"><Field label="ثبت بارکد ۱۲ یا ۱۳ رقمی"><input className={inputClass} inputMode="numeric" dir="ltr" value={manualCode} onChange={(event) => setManualCode(event.target.value)} /></Field><p className="text-xs text-muted-foreground">کد موجود روی کالا را وارد کنید؛ در این صفحه کد جدید خودکار ساخته نمی‌شود.</p><Button type="submit">ثبت بارکد کالا</Button></form> : <p>شعبهٔ فعال مشخص نیست؛ صفحه را پس از انتخاب شعبه باز کنید.</p> : null}</div> : null}
    </fieldset>
    {message ? <p role={uncertain ? "alert" : "status"} className="mt-3 text-sm">{message}</p> : null}
    {uncertain ? <Button className="mt-3" variant="outline" onClick={() => { setUncertain(false); setMessage(""); }}>نتیجه را بررسی کردم</Button> : null}
  </SectionCard>;
}
