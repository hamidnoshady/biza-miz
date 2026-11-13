"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { VEHICLE_STATE_LABELS, type VehicleState } from "@/lib/automotive";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { SearchField } from "../filters";
import { EmptyState, SectionCard, SectionCardSkeleton } from "../page-chrome";
import { api, Field, inputClass } from "../ui";

type Car = { serialId: string; stockNumber: string; displayName: string; state: VehicleState; askingPriceRial: number };
type Listing = { vehicles: Car[]; total: number; locations: { id: string; name: string }[]; activeLocationId: string | null };
type Detail = Car & { locationId: string; priceRevision: string; purchaseCostRial?: number; effectiveCostRial?: number; minimumPriceRial?: number | null; wholesalePriceRial?: number | null; promotionalPriceRial?: number | null };
type History = { id: string; changedAt: string; previousAskingPriceRial: number; askingPriceRial: number; reason: string | null };
type DetailResponse = { vehicle: Detail; canSeeCost: boolean; canSeePriceHistory: boolean; priceHistory: History[] };
const PAGE_SIZE = 20;

/** The dealership API remains the authority for each physical vehicle and its history. */
export function AutomotivePrices({ canEdit }: { canEdit: boolean }) {
  const money = useMoney();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [reload, setReload] = useState(0);
  const [listing, setListing] = useState<Listing | null>(null);
  const [listError, setListError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [detailError, setDetailError] = useState(false);
  const [detailVersion, setDetailVersion] = useState(0);
  const [price, setPrice] = useState("");
  const [reason, setReason] = useState("");
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const saving = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setListing(null); setListError(false);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE), q: query });
    void api<Listing>(`/api/automotive/vehicles?${params}`, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.ok || !Array.isArray(result.data?.vehicles) || typeof result.data.total !== "number" || !Array.isArray(result.data.locations)) setListError(true);
      else setListing(result.data);
    });
    return () => controller.abort();
  }, [query, page, reload]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setDetail(null); setDetailError(false);
    void api<DetailResponse>(`/api/automotive/vehicles/${encodeURIComponent(selected)}`, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      const vehicle = result.data?.vehicle;
      if (!result.ok || !vehicle || vehicle.serialId !== selected || vehicle.locationId !== selectedBranch || (typeof vehicle.priceRevision !== "string" || !/^(0|[1-9]\d{0,18})$/.test(vehicle.priceRevision)) || !Array.isArray(result.data.priceHistory)) setDetailError(true);
      else { setDetail(result.data); setNeedsRefresh(false); }
    });
    return () => controller.abort();
  }, [selected, selectedBranch, detailVersion]);

  function select(id: string) {
    if (!listing?.activeLocationId) return;
    setSelectedBranch(listing.activeLocationId); setSelected(id); setPrice(""); setReason(""); setMessage(""); setNotice(""); setReview(false); setNeedsRefresh(false);
    setDetailVersion((v) => v + 1);
  }
  function refreshDetail() { setMessage(""); setReview(false); setDetailVersion((v) => v + 1); }
  function reviewPrice(event: React.FormEvent) {
    event.preventDefault();
    const parsed = money.tryParse(price);
    if (!parsed.ok) { setMessage(money.problemMessage(parsed.problem)); return; }
    if (!detail || needsRefresh) return;
    if (parsed.rial === detail.vehicle.askingPriceRial) { setMessage("قیمت جدید با قیمت فعلی یکسان است."); return; }
    setMessage(""); setReview(true);
  }
  async function save() {
    if (saving.current || !detail || !selected || needsRefresh) return;
    const parsed = money.tryParse(price);
    if (!parsed.ok) { setMessage(money.problemMessage(parsed.problem)); setReview(false); return; }
    saving.current = true; setBusy(true); setMessage("");
    let result: { ok: boolean; data: { ok?: boolean; error?: string; message?: string } };
    try {
      result = await api(`/api/automotive/vehicles/${encodeURIComponent(selected)}/price`, {
        method: "POST",
        body: JSON.stringify({ askingPriceRial: parsed.rial, expectedPriceRevision: detail.vehicle.priceRevision, expectedLocationId: selectedBranch, reason: reason.trim() || null }),
      });
    } catch {
      saving.current = false; setBusy(false); setReview(false); setNeedsRefresh(true);
      setMessage("نتیجهٔ ثبت مشخص نیست. ابتدا قیمت و تاریخچهٔ فعلی را دوباره دریافت کنید.");
      return;
    }
    saving.current = false; setBusy(false); setReview(false);
    if (result.ok && result.data?.ok === true) {
      setPrice(""); setReason(""); setNotice("قیمت ثبت شد و تاریخچهٔ خودرو به‌روزرسانی شد.");
      setReload((v) => v + 1); setDetailVersion((v) => v + 1);
    } else {
      setNeedsRefresh(true);
      setMessage(result.data?.error === "price_conflict" ? "قیمت خودرو از زمان بررسی تغییر کرده است. ابتدا اطلاعات تازه را دریافت و دوباره بررسی کنید." : result.data?.error === "branch_changed" ? "شعبهٔ فعال تغییر کرده است. فهرست را دوباره دریافت و خودرو را انتخاب کنید." : "ثبت تأیید نشد یا نتیجه مشخص نیست. ابتدا قیمت و تاریخچهٔ فعلی را دوباره دریافت کنید.");
    }
  }

  const pageCount = Math.max(1, Math.ceil((listing?.total ?? 0) / PAGE_SIZE));
  const branchName = listing?.locations.find((location) => location.id === listing.activeLocationId)?.name;
  const parsed = money.tryParse(price);
  return (
    <div className="space-y-4">
      <SectionCard title="قیمت پیشنهادی خودروها" description={branchName ? `شعبهٔ فعال: ${branchName}` : "خودروهای شعبهٔ فعال"}>
        <fieldset disabled={busy}><SearchField label="جستجوی خودرو" value={query} onChange={(value) => { setQuery(value); setPage(0); setSelected(null); }} /></fieldset>
        {listError ? <div role="alert" className="mt-3 space-y-2 text-sm"><p>فهرست قیمت دریافت نشد.</p><Button variant="outline" onClick={() => setReload((v) => v + 1)}>تلاش دوباره</Button></div> : !listing ? <SectionCardSkeleton rows={3} /> : listing.vehicles.length === 0 ? <EmptyState>خودرویی در این صفحه پیدا نشد.</EmptyState> : <ul className="divide-y divide-border/80">{listing.vehicles.map((car) => <li key={car.serialId} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0 text-sm"><h3 className="break-words font-semibold">{car.displayName}</h3><p><bdi dir="ltr">{car.stockNumber}</bdi> · {VEHICLE_STATE_LABELS[car.state] ?? car.state} · {money.format(car.askingPriceRial)}</p></div><Button type="button" variant="outline" disabled={busy} onClick={() => select(car.serialId)} aria-label={`جزئیات قیمت ${car.stockNumber}`}>جزئیات قیمت</Button></li>)}</ul>}
        {listing && pageCount > 1 ? <div className="mt-3 flex flex-wrap items-center gap-2"><Button variant="outline" disabled={busy || page === 0} onClick={() => { setPage(page - 1); setSelected(null); }}>قبلی</Button><span>صفحهٔ {toPersianDigits(page + 1)} از {toPersianDigits(pageCount)}</span><Button variant="outline" disabled={busy || page + 1 >= pageCount} onClick={() => { setPage(page + 1); setSelected(null); }}>بعدی</Button></div> : null}
      </SectionCard>
      {selected ? <SectionCard title="جزئیات قیمت خودرو" description="قیمت پیشنهادی با بهای خرید و بهای موجودی یکسان نیست.">
        {detailError ? <div role="alert" className="space-y-2"><p>جزئیات قیمت دریافت نشد.</p><Button variant="outline" onClick={refreshDetail}>تلاش دوباره</Button></div> : !detail ? <SectionCardSkeleton rows={3} /> : <div className="space-y-4 text-sm">
          <h3 className="font-semibold">{detail.vehicle.displayName} · <bdi dir="ltr">{detail.vehicle.stockNumber}</bdi></h3>
          <p>قیمت پیشنهادی فعلی: {money.format(detail.vehicle.askingPriceRial)}</p>
          {detail.canSeeCost ? <div className="space-y-1"><p>بهای خرید: {detail.vehicle.purchaseCostRial == null ? "تعیین نشده" : money.format(detail.vehicle.purchaseCostRial)}</p><p>بهای تمام‌شده: {detail.vehicle.effectiveCostRial == null ? "تعیین نشده" : money.format(detail.vehicle.effectiveCostRial)}</p><p>حداقل قیمت: {detail.vehicle.minimumPriceRial == null ? "تعیین نشده" : money.format(detail.vehicle.minimumPriceRial)}</p><p>قیمت عمده: {detail.vehicle.wholesalePriceRial == null ? "تعیین نشده" : money.format(detail.vehicle.wholesalePriceRial)} · قیمت تبلیغاتی: {detail.vehicle.promotionalPriceRial == null ? "تعیین نشده" : money.format(detail.vehicle.promotionalPriceRial)}</p></div> : null}
          {notice ? <p role="status">{notice}</p> : null}{message ? <p role="alert">{message}</p> : null}
          {needsRefresh ? <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={refreshDetail}>دریافت قیمت و تاریخچهٔ فعلی</Button><Button variant="outline" onClick={() => { setSelected(null); setReload((v) => v + 1); }}>بازخوانی فهرست شعبه</Button></div> : null}
          {canEdit && detail.vehicle.state !== "sold" && detail.vehicle.state !== "archived" ? <form onSubmit={reviewPrice} className="max-w-lg"><fieldset disabled={busy || needsRefresh}><Field label={`قیمت پیشنهادی جدید (${money.unitLabel})`}><PersianNumberInput className={inputClass} inputMode="decimal" value={price} onChange={(event) => { setPrice(event.target.value); setReview(false); }} /></Field><Field label="دلیل تغییر (اختیاری)"><input className={inputClass} value={reason} maxLength={500} onChange={(event) => { setReason(event.target.value); setReview(false); }} /></Field><Button type="submit">بررسی تغییر</Button></fieldset>
            {review && parsed.ok ? <div className="mt-3 space-y-3" role="group" aria-label="بازبینی تغییر قیمت"><p>تغییر قیمت از {money.format(detail.vehicle.askingPriceRial)} به {money.format(parsed.rial)}؛ سایر قیمت‌ها و بهای خودرو تغییر نمی‌کنند.</p><Button type="button" disabled={busy} onClick={() => void save()}>{busy ? "در حال ثبت…" : "تأیید و ثبت قیمت"}</Button>{" "}<Button type="button" variant="outline" disabled={busy} onClick={() => setReview(false)}>انصراف</Button></div> : null}
          </form> : null}
          {detail.canSeePriceHistory ? <div><h4 className="font-semibold">تاریخچهٔ قیمت</h4>{detail.priceHistory.length === 0 ? <p>تغییری ثبت نشده است.</p> : <ul className="divide-y divide-border/80">{detail.priceHistory.map((entry) => <li key={entry.id} className="py-2">{formatJalali(entry.changedAt)} · {money.format(entry.previousAskingPriceRial)} ← {money.format(entry.askingPriceRial)}{entry.reason ? ` · ${entry.reason}` : ""}</li>)}</ul>}</div> : null}
        </div>}
      </SectionCard> : null}
    </div>
  );
}
