"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { normalizeListSearch } from "@/lib/product-list";
import type { WatchItemAttributes } from "@/lib/watch-attributes-service";
import { SearchField } from "../filters";
import { EmptyState, SectionCard, SectionCardSkeleton } from "../page-chrome";
import { api, Field, inputClass } from "../ui";
import { PURITY_LABELS, WEIGHT_ITEM_STATUS_LABELS, type WeightItem } from "../jewelry/jewelry-manager";
import { SERIAL_STATUS_LABELS, type SerialUnit } from "../watch/watch-manager";

interface Model {
  id: string;
  name: string;
  sku: string | null;
  isActive: boolean;
  attributes: WatchItemAttributes | null;
}
type Catalogue = { kind: "jewelry"; items: WeightItem[] } | { kind: "watch"; models: Model[]; units: SerialUnit[] };
const PAGE_SIZE = 20;

/** A projection of the native branch APIs — never a second product master. */
export function SpecialistCatalogue({ industry, canEdit }: { industry: "jewelry" | "watch"; canEdit: boolean }) {
  const [data, setData] = useState<Catalogue | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState("");
  const [order, setOrder] = useState<"ascending" | "descending">("ascending");
  const money = useMoney();
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(false);
    if (industry === "jewelry") {
      const response = await api<{ items?: WeightItem[] }>("/api/jewelry/items", { signal });
      if (signal?.aborted) return;
      if (!response.ok || !Array.isArray(response.data.items)) setError(true);
      else setData({ kind: "jewelry", items: response.data.items });
    } else {
      const [models, units] = await Promise.all([
        api<{ items?: Model[] }>("/api/watch/items", { signal }),
        api<{ units?: SerialUnit[] }>("/api/watch/units", { signal }),
      ]);
      if (signal?.aborted) return;
      if (!models.ok || !units.ok || !Array.isArray(models.data.items) || !Array.isArray(units.data.units)) setError(true);
      else setData({ kind: "watch", models: models.data.items, units: units.data.units });
    }
    setLoading(false);
  }, [industry]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = normalizeListSearch(search);
    if (data.kind === "jewelry") return data.items
      .filter((item) => (!status || item.status === status) && normalizeListSearch(`${item.name} ${item.sku ?? ""} ${item.consignorName ?? ""}`).includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name, "fa") * (order === "ascending" ? 1 : -1));
    const unitNames = new Map<string, string[]>();
    const unitStatuses = new Map<string, Set<string>>();
    for (const unit of data.units) {
      unitNames.set(unit.itemId, [...(unitNames.get(unit.itemId) ?? []), unit.serialNumber]);
      const statuses = unitStatuses.get(unit.itemId) ?? new Set<string>();
      statuses.add(unit.status);
      unitStatuses.set(unit.itemId, statuses);
    }
    return data.models
      .filter((model) => (!status || unitStatuses.get(model.id)?.has(status)) && normalizeListSearch(`${model.name} ${model.sku ?? ""} ${model.attributes?.referenceNo ?? ""} ${(unitNames.get(model.id) ?? []).join(" ")}`).includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name, "fa") * (order === "ascending" ? 1 : -1));
  }, [data, search, status, order]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  return (
    <SectionCard title={industry === "watch" ? "مدل‌های ساعت" : "قطعات طلا و جواهر"} description="اطلاعات شعبهٔ فعال از سامانهٔ اصلی این صنف خوانده می‌شود.">
      {loading ? <SectionCardSkeleton rows={4} /> : error ? (
        <div role="alert" className="space-y-2 text-sm"><p>فهرست دریافت نشد؛ اتصال و دسترسی را بررسی کنید.</p><Button variant="outline" onClick={() => void load()}>تلاش دوباره</Button></div>
      ) : (
        <div className="min-w-0 space-y-4">
          <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <SearchField label={industry === "watch" ? "جستجوی مدل، کد یا سریال" : "جستجوی نام، کد یا امانت‌گذار"} value={search} onChange={(value) => { setSearch(value); setPage(0); }} />
            <Field label={industry === "watch" ? "وضعیت دستگاه در مدل" : "وضعیت قطعه"}>
              <select className={inputClass} value={status} onChange={(event) => { setStatus(event.target.value); setPage(0); }}>
                <option value="">همهٔ وضعیت‌ها</option>
                {Object.entries(industry === "watch" ? SERIAL_STATUS_LABELS : WEIGHT_ITEM_STATUS_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </Field>
            <Field label="ترتیب نام">
              <select className={inputClass} value={order} onChange={(event) => { setOrder(event.target.value as "ascending" | "descending"); setPage(0); }}><option value="ascending">صعودی</option><option value="descending">نزولی</option></select>
            </Field>
          </div>
          {visible.length === 0 ? <EmptyState>{search || status ? "موردی مطابق جستجو پیدا نشد." : "هنوز کالایی در این شعبه ثبت نشده است."}</EmptyState> : (
            <ul className="divide-y divide-border/80">
              {data?.kind === "jewelry" ? (visible as WeightItem[]).map((item) => (
                <li key={item.id} className="min-w-0 space-y-2 py-4">
                  <div className="flex flex-wrap items-baseline gap-2"><h3 className="break-words font-semibold">{item.name}</h3>{item.sku ? <span dir="ltr" className="break-all text-sm text-muted-foreground">{item.sku}</span> : null}<span className="text-sm">{item.isActive ? WEIGHT_ITEM_STATUS_LABELS[item.status] : "غیرفعال"}</span></div>
                  <p className="text-sm text-muted-foreground">{PURITY_LABELS[item.purity]} · وزن خالص {formatQuantity(item.netWeight)} گرم · ناخالص {formatQuantity(item.grossWeight)} گرم{item.consignorName ? ` · امانی: ${item.consignorName}` : ""}</p>
                  {item.stoneCost > 0 ? <p className="text-sm">بهای سنگ‌ها: {money.format(item.stoneCost)}</p> : null}
                </li>
              )) : data?.kind === "watch" ? (visible as Model[]).map((model) => {
                const units = data.units.filter((unit) => unit.itemId === model.id);
                const stock = units.filter((unit) => unit.status === "in_stock").length;
                return <li key={model.id} className="min-w-0 space-y-2 py-4">
                  <div className="flex flex-wrap items-baseline gap-2"><h3 className="break-words font-semibold">{model.name}</h3>{model.sku ? <span dir="ltr" className="break-all text-sm text-muted-foreground">{model.sku}</span> : null}{!model.isActive ? <span>غیرفعال</span> : null}</div>
                  <p className="text-sm text-muted-foreground">{toPersianDigits(stock)} دستگاه موجود · {toPersianDigits(units.length)} دستگاه ثبت‌شده{model.attributes?.referenceNo ? <> · رفرنس <bdi dir="ltr">{model.attributes.referenceNo}</bdi></> : null}</p>
                  <details className="text-sm"><summary className="cursor-pointer font-medium">مشخصات مدل و دستگاه‌ها</summary><div className="mt-2 space-y-2">
                    {model.attributes?.caseMaterial ? <p>جنس قاب: {model.attributes.caseMaterial}</p> : null}
                    {model.attributes?.dialColor ? <p>رنگ صفحه: {model.attributes.dialColor}</p> : null}
                    {units.length === 0 ? <p>دستگاهی برای این مدل ثبت نشده است.</p> : <ul className="space-y-2">{units.map((unit) => <li key={unit.id} className="min-w-0 rounded-lg border border-border p-2"><bdi dir="ltr" className="break-all">{unit.serialNumber}</bdi> · {SERIAL_STATUS_LABELS[unit.status]} · بهای دستگاه: {unit.unitCost == null ? "تعیین نشده" : money.format(unit.unitCost)} · گارانتی: {toPersianDigits(unit.warrantyMonths)} ماه{unit.warrantyEnd ? ` · پایان: ${formatJalali(unit.warrantyEnd)}` : ""}</li>)}</ul>}
                  </div></details>
                </li>;
              }) : null}
            </ul>
          )}
          {pageCount > 1 ? <div className="flex flex-wrap items-center gap-2"><Button variant="outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>قبلی</Button><span aria-live="polite">صفحهٔ {toPersianDigits(currentPage + 1)} از {toPersianDigits(pageCount)}</span><Button variant="outline" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>بعدی</Button></div> : null}
          {canEdit ? <Link className={buttonVariants({ variant: "outline" })} href={industry === "watch" ? "/accounting/watch" : "/accounting/jewelry"}>مدیریت تخصصی {industry === "watch" ? "ساعت" : "طلا و جواهر"}</Link> : null}
        </div>
      )}
    </SectionCard>
  );
}
