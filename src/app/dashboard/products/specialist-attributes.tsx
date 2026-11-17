"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatPersianNumericText, formatQuantity, toPersianDigits } from "@/lib/digits";
import { normalizeListSearch } from "@/lib/product-list";
import {
  VEHICLE_BODY_TYPE_LABELS, VEHICLE_CONDITION_LABELS, VEHICLE_DRIVETRAIN_LABELS,
  VEHICLE_FUEL_TYPE_LABELS, VEHICLE_TRANSMISSION_LABELS,
  type VehicleBodyType, type VehicleCondition, type VehicleDrivetrain,
  type VehicleFuelType, type VehicleTransmission,
} from "@/lib/automotive";
import type { WatchItemAttributes } from "@/lib/watch-attributes-service";
import { PURITY_LABELS, type ItemStone, type WeightItem } from "../jewelry/jewelry-manager";
import { SearchField } from "../filters";
import { EmptyState, SectionCard, SectionCardSkeleton } from "../page-chrome";
import { api } from "../ui";

type Industry = "jewelry" | "watch" | "automotive";
type Model = { id: string; name: string; sku: string | null; isActive: boolean; attributes: WatchItemAttributes | null };
type Vehicle = { serialId: string; displayName: string; stockNumber: string; locationId: string };
type Listing = { kind: "watch"; items: Model[] } | { kind: "jewelry"; items: WeightItem[] } | { kind: "automotive"; items: Vehicle[]; total: number; activeLocationId: string; branchName: string };
type VehicleDetail = Vehicle & { condition: VehicleCondition; vehicleYearCalendar: "jalali" | "gregorian"; modelYear: number | null; productionYear: number | null; vin: string | null; chassisNumber: string | null; engineNumber: string | null; plateNumber: string | null; bodyType: VehicleBodyType | null; transmission: VehicleTransmission | null; fuelType: VehicleFuelType | null; drivetrain: VehicleDrivetrain | null; engineSpec: string | null; exteriorColor: string | null; interiorColor: string | null; mileageKm: number | null; priorOwners: number | null };
type Detail = { kind: "jewelry"; stones: ItemStone[] } | { kind: "automotive"; vehicle: VehicleDetail };
const PAGE_SIZE = 20;
/** Keep exact measured weights; database quantities may have nine decimal places. */
function exactQuantity(value: string): string {
  const trimmed = value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
  return formatPersianNumericText(trimmed);
}
const MOVEMENTS: Record<string, string> = { automatic: "اتوماتیک", quartz: "کوارتز", manual: "کوکی", solar: "سولار", kinetic: "کینتیک", smart: "هوشمند" };
const GENDERS: Record<string, string> = { men: "مردانه", women: "زنانه", unisex: "یونیسکس" };

/** Trade-owned attributes only: no variant definitions or mutation APIs. */
export function SpecialistAttributes({ industry }: { industry: Industry }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [reload, setReload] = useState(0);
  const [listing, setListing] = useState<Listing | null>(null);
  const [listError, setListError] = useState(false);
  const [selection, setSelection] = useState<{ id: string; branch?: string } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState(false);
  const [detailReload, setDetailReload] = useState(0);

  const serverQuery = industry === "automotive" ? query : "";
  const serverPage = industry === "automotive" ? page : 0;
  useEffect(() => {
    const controller = new AbortController();
    setListing(null); setListError(false);
    async function load() {
      if (industry === "automotive") {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(serverPage * PAGE_SIZE), q: serverQuery });
        const res = await api<{ vehicles?: Vehicle[]; total?: number; activeLocationId?: string; locations?: { id: string; name: string }[] }>(`/api/automotive/vehicles?${params}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok || !Array.isArray(res.data?.vehicles) || typeof res.data.total !== "number" || !res.data.activeLocationId || !Array.isArray(res.data.locations)) { setListError(true); return; }
        const branchName = res.data.locations.find((location) => location.id === res.data.activeLocationId)?.name;
        if (!branchName || res.data.vehicles.some((vehicle) => vehicle.locationId !== res.data.activeLocationId)) { setListError(true); return; }
        setListing({ kind: "automotive", items: res.data.vehicles, total: res.data.total, activeLocationId: res.data.activeLocationId, branchName });
      } else {
        const res = await api<{ items?: Model[] | WeightItem[] }>(`/api/${industry}/items`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok || !Array.isArray(res.data?.items)) { setListError(true); return; }
        if (industry === "watch") setListing({ kind: "watch", items: res.data.items as Model[] });
        else setListing({ kind: "jewelry", items: res.data.items as WeightItem[] });
      }
    }
    void load();
    return () => controller.abort();
  }, [industry, serverPage, serverQuery, reload]);

  useEffect(() => {
    if (!selection || industry === "watch") return;
    const controller = new AbortController();
    setDetail(null); setDetailError(false);
    async function load() {
      const id = encodeURIComponent(selection!.id);
      if (industry === "jewelry") {
        const res = await api<{ item?: { id: string }; stones?: ItemStone[] }>(`/api/jewelry/items/${id}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok || res.data?.item?.id !== selection!.id || !Array.isArray(res.data.stones)) setDetailError(true);
        else setDetail({ kind: "jewelry", stones: res.data.stones });
      } else {
        const res = await api<{ vehicle?: VehicleDetail }>(`/api/automotive/vehicles/${id}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok || res.data?.vehicle?.serialId !== selection!.id || res.data.vehicle.locationId !== selection!.branch) setDetailError(true);
        else setDetail({ kind: "automotive", vehicle: res.data.vehicle });
      }
    }
    void load();
    return () => controller.abort();
  }, [selection, industry, detailReload]);

  const filtered = useMemo(() => {
    if (!listing || listing.kind === "automotive") return [];
    const needle = normalizeListSearch(query);
    return listing.items.filter((item) => normalizeListSearch(`${item.name} ${item.sku ?? ""} ${"attributes" in item ? item.attributes?.referenceNo ?? "" : ""}`).includes(needle));
  }, [listing, query]);
  const total = listing?.kind === "automotive" ? listing.total : filtered.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visible = listing?.kind === "automotive" ? listing.items : filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const selectedWatch = listing?.kind === "watch" ? listing.items.find((item) => item.id === selection?.id) : null;
  const selectedGold = listing?.kind === "jewelry" ? listing.items.find((item) => item.id === selection?.id) : null;
  function changeQuery(value: string) { setQuery(value); setPage(0); setSelection(null); }
  function select(id: string) { setDetail(null); setDetailError(false); setSelection({ id, branch: listing?.kind === "automotive" ? listing.activeLocationId : undefined }); }
  return <div className="space-y-4">
    <SectionCard title="فهرست مشخصات" description={listing?.kind === "automotive" ? `شعبهٔ فعال: ${listing.branchName}` : "اطلاعات اختصاصی کالاهای شعبهٔ فعال"}>
      <SearchField label="جستجوی مشخصات محصول" value={query} onChange={changeQuery} />
      {listError ? <div role="alert" className="mt-3 space-y-2"><p>فهرست مشخصات دریافت نشد.</p><Button variant="outline" onClick={() => setReload((n) => n + 1)}>تلاش دوباره</Button></div> : !listing ? <SectionCardSkeleton rows={3} /> : visible.length === 0 ? <EmptyState>کالایی در این صفحه پیدا نشد.</EmptyState> : <ul className="divide-y divide-border/80">{visible.map((item) => {
        const id = "serialId" in item ? item.serialId : item.id;
        const name = "displayName" in item ? item.displayName : item.name;
        const code = "stockNumber" in item ? item.stockNumber : item.sku;
        return <li key={id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0"><h3 className="break-words font-semibold">{name}</h3>{code ? <bdi dir="ltr" className="break-all text-sm text-muted-foreground">{code}</bdi> : null}</div><Button variant="outline" onClick={() => select(id)} aria-label={`مشخصات ${name}${code ? ` ${code}` : ""}`}>مشاهدهٔ مشخصات</Button></li>;
      })}</ul>}
      {listing && pages > 1 ? <div className="mt-3 flex flex-wrap items-center gap-2"><Button variant="outline" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); setSelection(null); }}>قبلی</Button><span aria-live="polite">صفحهٔ {toPersianDigits(currentPage + 1)} از {toPersianDigits(pages)}</span><Button variant="outline" disabled={currentPage + 1 >= pages} onClick={() => { setPage(currentPage + 1); setSelection(null); }}>بعدی</Button></div> : null}
    </SectionCard>
    {selection ? <SectionCard title="مشخصات ثبت‌شده" description="این اطلاعات از مدل تخصصی خوانده می‌شود و در این صفحه قابل ویرایش نیست.">
      {selectedWatch ? <WatchFacts model={selectedWatch} /> : selectedGold ? <div className="space-y-2 text-sm"><h3 className="font-semibold">{selectedGold.name}</h3><p>عیار: {PURITY_LABELS[selectedGold.purity] ?? "تعیین نشده"}</p><p>وزن خالص: {exactQuantity(selectedGold.netWeight)} گرم · وزن ناخالص: {exactQuantity(selectedGold.grossWeight)} گرم</p>{detailError ? <Retry onRetry={() => setDetailReload((n) => n + 1)} /> : !detail ? <SectionCardSkeleton rows={2} /> : detail.kind === "jewelry" ? <div><h4 className="font-semibold">سنگ‌ها</h4>{detail.stones.length ? <ul>{detail.stones.map((stone) => <li key={stone.id}>{stone.stoneType} · {exactQuantity(stone.carat)} قیراط</li>)}</ul> : <p>سنگی ثبت نشده است.</p>}</div> : null}</div> : industry === "automotive" ? detailError ? <Retry onRetry={() => setDetailReload((n) => n + 1)} /> : !detail ? <SectionCardSkeleton rows={3} /> : detail.kind === "automotive" ? <VehicleFacts vehicle={detail.vehicle} /> : null : null}
    </SectionCard> : null}
  </div>;
}

function Retry({ onRetry }: { onRetry: () => void }) { return <div role="alert" className="space-y-2"><p>جزئیات دریافت نشد؛ شعبه و دسترسی را بررسی کنید.</p><Button variant="outline" onClick={onRetry}>تلاش دوباره</Button></div>; }
function WatchFacts({ model }: { model: Model }) {
  const a = model.attributes;
  return <div className="space-y-2 text-sm"><h3 className="font-semibold">{model.name}</h3>{!a ? <p>مشخصاتی برای این مدل ثبت نشده است.</p> : <dl className="grid gap-2 sm:grid-cols-2">
    <Fact label="رفرنس" value={a.referenceNo} /><Fact label="نوع موتور" value={a.movement ? MOVEMENTS[a.movement] : null} /><Fact label="جنس قاب" value={a.caseMaterial} /><Fact label="قطر قاب" value={a.caseDiameterMm == null ? null : `${formatQuantity(a.caseDiameterMm)} میلی‌متر`} /><Fact label="ابعاد قاب" value={a.caseDimensionsMm?.length ? `${a.caseDimensionsMm.map((dimension) => formatQuantity(dimension)).join(" × ")} میلی‌متر` : null} /><Fact label="رنگ قاب" value={a.caseColor} /><Fact label="شکل قاب" value={a.caseShape} /><Fact label="مقاومت در برابر آب" value={a.waterResistanceM == null ? null : `${formatQuantity(a.waterResistanceM)} متر`} /><Fact label="رنگ صفحه" value={a.dialColor} /><Fact label="جنس بند" value={a.braceletMaterial} /><Fact label="رنگ بند" value={a.braceletColor} /><Fact label="نوع قفل" value={a.claspType} /><Fact label="دسته‌بندی" value={a.gender ? GENDERS[a.gender] : null} />
  </dl>}</div>;
}
function Fact({ label, value }: { label: string; value?: string | null }) { return <div className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="break-words">{value || "ثبت نشده"}</dd></div>; }
function VehicleFacts({ vehicle: v }: { vehicle: VehicleDetail }) {
  return <div className="space-y-2 text-sm"><h3 className="font-semibold">{v.displayName} · <bdi dir="ltr">{v.stockNumber}</bdi></h3><dl className="grid gap-2 sm:grid-cols-2">
    <Fact label="وضعیت خودرو" value={VEHICLE_CONDITION_LABELS[v.condition]} /><Fact label="سال مدل" value={v.modelYear == null ? null : v.vehicleYearCalendar === "jalali" ? toPersianDigits(v.modelYear) : "سال شمسی ثبت نشده"} /><Fact label="سال تولید" value={v.productionYear == null ? null : v.vehicleYearCalendar === "jalali" ? toPersianDigits(v.productionYear) : "سال شمسی ثبت نشده"} /><Fact label="شناسهٔ خودرو (VIN)" value={v.vin} /><Fact label="شمارهٔ شاسی" value={v.chassisNumber} /><Fact label="شمارهٔ موتور" value={v.engineNumber} /><Fact label="پلاک" value={v.plateNumber} /><Fact label="نوع بدنه" value={v.bodyType ? VEHICLE_BODY_TYPE_LABELS[v.bodyType] : null} /><Fact label="گیربکس" value={v.transmission ? VEHICLE_TRANSMISSION_LABELS[v.transmission] : null} /><Fact label="سوخت" value={v.fuelType ? VEHICLE_FUEL_TYPE_LABELS[v.fuelType] : null} /><Fact label="محور محرک" value={v.drivetrain ? VEHICLE_DRIVETRAIN_LABELS[v.drivetrain] : null} /><Fact label="مشخصات موتور" value={v.engineSpec} /><Fact label="رنگ بیرونی" value={v.exteriorColor} /><Fact label="رنگ داخلی" value={v.interiorColor} /><Fact label="کارکرد" value={v.mileageKm == null ? null : `${formatQuantity(v.mileageKm)} کیلومتر`} /><Fact label="تعداد مالکان قبلی" value={v.priorOwners == null ? null : toPersianDigits(v.priorOwners)} />
  </dl></div>;
}
