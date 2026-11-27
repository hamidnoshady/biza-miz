"use client";

/**
 * GH #1567 Phase 6C — «بسته‌های سایزی»: build a wholesale size pack from a
 * style's size × colour matrix, see its price, pieces and how many packs the
 * branch can make right now, and review sold packs with their returns.
 *
 * A pack never has stock of its own: availability here is derived from the
 * variants (the same `packAvailability` the server uses), and selling a pack
 * at the till sells its variants.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { PackageIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useMoney } from "@/components/money/money-context";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { packAvailability, packTotals } from "@/lib/fashion-size-packs";
import { sizePackErrorMessage } from "@/lib/fashion-size-pack-messages";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "../data-table";
import { IndustryManagerShell } from "../industry-manager-shell";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "../page-chrome";
import { api, ErrorBox, InfoBox } from "../ui";

export interface PackComponent {
  itemId: string; name: string; sku: string | null; attributes: string; quantity: number; unitPriceRial: number; onHand: string;
}

export interface SizePack {
  id: string; name: string; barcode: string | null; isActive: boolean; version: number; priceRial: number; pieces: number;
  available: number; shortages: { itemId: string; name: string; need: number; onHand: string; missing: string }[];
  components: PackComponent[];
  /** GH #1567 C3 — barcode cleared by migration because an item already scans with it. */
  clearedBarcode?: string | null;
}

/** Shown on a pack whose barcode an item at this branch already used. */
export function clearedBarcodeText(code: string): string {
  return `بارکد ${toPersianDigits(code)} برداشته شد چون کالای دیگری در این شعبه با همین بارکد اسکن می‌شود؛ بارکد تازه‌ای بدهید و بسته را ذخیره کنید.`;
}

interface Style { id: string; name: string; sku: string | null; variants: number }
interface Cell { itemId: string; name: string; sku: string | null; attributes: Record<string, string>; onHand: string; unitPriceRial: number | null }

interface PackSale {
  id: string; orderNumber: string | null; packName: string; packVersion: number; packQuantity: number; totalRial: number; at: string;
  status: "sold" | "partially_returned" | "returned" | "voided";
  components: { itemId: string; name: string; quantity: string; returnedQuantity: string }[];
}

const SALE_STATUS: Record<PackSale["status"], { label: string; tone: "active" | "positive" | "neutral" | "danger" }> = {
  sold: { label: "فروخته‌شده", tone: "positive" },
  partially_returned: { label: "برگشت جزئی", tone: "active" },
  returned: { label: "برگشت کامل", tone: "neutral" },
  voided: { label: "ابطال‌شده", tone: "danger" },
};

const fa = (value: string | number) => toPersianDigits(String(value));

/** Whole, positive integers only (Persian or Latin digits); "" stays empty. */
export function parseCount(raw: string): number | null {
  const text = toLatinDigits(raw).trim();
  if (!/^\d{1,5}$/.test(text)) return null;
  const n = Number(text);
  return n > 0 ? n : null;
}

/**
 * The matrix layout for a style: sizes across, the other axis (colour) down.
 * A one-axis style is a single row.
 */
export function matrixLayout(axes: string[], cells: Cell[]): { sizeAxis: string | null; rowAxis: string | null; columns: string[]; rows: string[] } {
  const sizeAxis = axes.find((a) => a.includes("سایز")) ?? axes[0] ?? null;
  const rowAxis = axes.find((a) => a !== sizeAxis) ?? null;
  const uniq = (axis: string | null) => (axis ? [...new Set(cells.map((c) => c.attributes[axis] ?? "—"))] : ["—"]);
  return { sizeAxis, rowAxis, columns: uniq(sizeAxis), rows: uniq(rowAxis) };
}

type Tab = "packs" | "sales";

export function SizePackManager({ canEdit }: { canEdit: boolean }) {
  const tabs = useMemo(() => [
    { key: "packs" as const, label: "بسته‌ها" },
    { key: "sales" as const, label: "فروش و برگشت بسته‌ها" },
  ], []);
  const [tab, setTab] = useState<Tab>("packs");
  return (
    <IndustryManagerShell idPrefix="size-packs" navLabel="بخش‌های بستهٔ سایزی" tabs={tabs} activeTab={tab} onTabChange={setTab} error="">
      {tab === "packs" ? <PacksSection canEdit={canEdit} /> : <SalesSection />}
    </IndustryManagerShell>
  );
}

function PacksSection({ canEdit }: { canEdit: boolean }) {
  const money = useMoney();
  const [packs, setPacks] = useState<SizePack[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<SizePack | "new" | null>(null);
  const load = useCallback(async () => {
    const res = await api<{ packs?: SizePack[]; error?: string }>("/api/size-packs");
    if (!res.ok) setError(sizePackErrorMessage(res.data.error));
    setPacks(res.data.packs ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function deactivate(pack: SizePack) {
    const res = await api<{ error?: string }>(`/api/size-packs/${pack.id}`, { method: "DELETE" });
    if (!res.ok) { setError(sizePackErrorMessage(res.data.error)); return; }
    void load();
  }

  return (
    <SectionCard
      title="بسته‌های سایزی"
      description="ترکیبی از سایز و رنگ‌های یک یا چند مدل با قیمت عمدهٔ هر عدد. بسته موجودی جدا ندارد؛ موجودی آن از تنوع‌ها محاسبه می‌شود و فروش آن همان تنوع‌ها را از انبار کم می‌کند."
      actions={canEdit ? <Button onClick={() => setEditing("new")}><PlusIcon aria-hidden="true" className="size-4" />بستهٔ تازه</Button> : null}
    >
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {packs === null ? <SectionCardSkeleton /> : packs.length === 0 ? (
        <EmptyState title="بسته‌ای نیست" icon={PackageIcon}>برای فروش عمده، مثلاً «۱ اسمال، ۲ مدیوم، ۲ لارج»، یک بسته بسازید.</EmptyState>
      ) : (
        <DataTable caption="بسته‌های سایزی">
          <DataTableHead><Th>نام</Th><Th>اجزا</Th><Th>تعداد قطعه</Th><Th>قیمت بسته</Th><Th>قابل فروش</Th><Th>وضعیت</Th>{canEdit ? <Th>عملیات</Th> : null}</DataTableHead>
          <DataTableBody>
            {packs.map((p) => (
              <DataTableRow key={p.id}>
                <Td>
                  <span className="block font-medium">{p.name}</span>
                  {p.barcode ? <span className="block text-xs text-muted-foreground" dir="ltr">{p.barcode}</span> : null}
                  {p.clearedBarcode ? <span className="block text-xs text-destructive">{clearedBarcodeText(p.clearedBarcode)}</span> : null}
                </Td>
                <Td><span className="block max-w-xs truncate text-xs">{p.components.map((c) => `${c.attributes || c.name} ×${fa(c.quantity)}`).join("، ")}</span></Td>
                <Td>{fa(p.pieces)}</Td>
                <Td>{money.format(p.priceRial)}</Td>
                <Td>
                  {fa(p.available)} بسته
                  {p.available === 0 && p.shortages.length > 0 ? <span className="block text-xs text-muted-foreground">کمبود: {p.shortages.map((s) => s.name).join("، ")}</span> : null}
                </Td>
                <Td><StatusBadge tone={p.isActive ? "positive" : "neutral"}>{p.isActive ? "فعال" : "غیرفعال"}</StatusBadge></Td>
                {canEdit ? (
                  <Td>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => setEditing(p)}>ویرایش</Button>
                      {p.isActive ? <Button size="sm" variant="ghost" onClick={() => void deactivate(p)}>غیرفعال</Button> : null}
                    </div>
                  </Td>
                ) : null}
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}
      <Sheet open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle>{editing === "new" ? "بستهٔ سایزی تازه" : "ویرایش بسته"}</SheetTitle>
            <SheetDescription>فروش‌های قبلی همان ترکیب و قیمتی را نگه می‌دارند که فروخته شده‌اند.</SheetDescription>
          </SheetHeader>
          {editing ? <PackBuilder pack={editing === "new" ? null : editing} onSaved={() => { setEditing(null); void load(); }} /> : null}
        </SheetContent>
      </Sheet>
    </SectionCard>
  );
}

export function PackBuilder({ pack, onSaved }: { pack: SizePack | null; onSaved: () => void }) {
  const money = useMoney();
  const [name, setName] = useState(pack?.name ?? "");
  const [barcode, setBarcode] = useState(pack?.barcode ?? "");
  const [components, setComponents] = useState<PackComponent[]>(pack?.components ?? []);
  const [styles, setStyles] = useState<Style[] | null>(null);
  const [styleId, setStyleId] = useState("");
  const [matrix, setMatrix] = useState<{ axes: string[]; cells: Cell[] } | null>(null);
  const [stylePrice, setStylePrice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<{ styles?: Style[] }>("/api/size-packs/matrix").then((res) => setStyles(res.data.styles ?? []));
  }, []);
  useEffect(() => {
    if (!styleId) { setMatrix(null); return; }
    void api<{ axes?: string[]; cells?: Cell[]; error?: string }>(`/api/size-packs/matrix?styleId=${styleId}`).then((res) => {
      if (!res.ok) { setError(sizePackErrorMessage(res.data.error)); return; }
      setMatrix({ axes: res.data.axes ?? [], cells: res.data.cells ?? [] });
    });
  }, [styleId]);

  const quantityOf = (itemId: string) => components.find((c) => c.itemId === itemId)?.quantity ?? 0;

  function setCellQuantity(cell: Cell, raw: string) {
    const quantity = raw.trim() === "" ? 0 : parseCount(raw);
    if (quantity === null) return;
    setComponents((list) => {
      const rest = list.filter((c) => c.itemId !== cell.itemId);
      if (quantity === 0) return rest;
      const existing = list.find((c) => c.itemId === cell.itemId);
      let price = existing?.unitPriceRial ?? cell.unitPriceRial ?? 0;
      if (!existing && stylePrice.trim()) {
        try { price = money.parse(stylePrice); } catch { /* keep the catalogue price */ }
      }
      const next: PackComponent = {
        itemId: cell.itemId, name: cell.name, sku: cell.sku, onHand: cell.onHand, quantity, unitPriceRial: price,
        attributes: Object.values(cell.attributes).join(" / "),
      };
      return existing ? list.map((c) => (c.itemId === cell.itemId ? next : c)) : [...rest, next];
    });
  }

  function setPrice(itemId: string, raw: string) {
    let price: number;
    try { price = raw.trim() === "" ? 0 : money.parse(raw); } catch { return; }
    setComponents((list) => list.map((c) => (c.itemId === itemId ? { ...c, unitPriceRial: price } : c)));
  }

  const totals = packTotals(components);
  const availability = packAvailability(components.map((c) => ({
    itemId: c.itemId, name: c.attributes ? `${c.name} (${c.attributes})` : c.name, quantity: c.quantity, onHand: c.onHand,
  })));
  const layout = matrix ? matrixLayout(matrix.axes, matrix.cells) : null;

  async function save() {
    if (!name.trim() || components.length === 0) { setError("نام بسته و دست‌کم یک تنوع لازم است."); return; }
    setBusy(true);
    setError("");
    const res = await api<{ error?: string; detail?: unknown }>(pack ? `/api/size-packs/${pack.id}` : "/api/size-packs", {
      method: pack ? "PUT" : "POST",
      body: JSON.stringify({
        name: name.trim(),
        barcode: barcode.trim() || null,
        components: components.map((c) => ({ itemId: c.itemId, quantity: c.quantity, unitPriceRial: c.unitPriceRial })),
      }),
    });
    setBusy(false);
    if (!res.ok) { setError(sizePackErrorMessage(res.data.error, res.data.detail)); return; }
    onSaved();
  }

  return (
    <div className="space-y-5 px-4 pb-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="pack-name">نام بسته</Label>
          <Input id="pack-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pack-barcode">بارکد بسته (اختیاری)</Label>
          <Input id="pack-barcode" dir="ltr" value={barcode} maxLength={64} onChange={(e) => setBarcode(e.target.value)} />
        </div>
      </div>

      <section aria-labelledby="pack-matrix" className="space-y-3">
        <h3 id="pack-matrix" className="font-medium">افزودن از جدول سایز و رنگ</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>مدل</Label>
            <SearchableSelect ariaLabel="مدل" value={styleId} onChange={setStyleId} loading={styles === null}
              options={(styles ?? []).map((s) => ({ value: s.id, label: s.sku ? `${s.name} (${s.sku})` : s.name }))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pack-style-price">قیمت عمدهٔ هر عدد برای این مدل ({money.unitLabel}، اختیاری)</Label>
            <Input id="pack-style-price" inputMode="numeric" value={stylePrice} onChange={(e) => setStylePrice(e.target.value)} />
          </div>
        </div>
        {styleId && !matrix ? <SectionCardSkeleton rows={3} /> : null}
        {matrix && layout ? (
          matrix.cells.length === 0 ? <InfoBox>این مدل تنوع قابل فروشی ندارد.</InfoBox> : (
            <DataTable caption="جدول تعداد هر سایز و رنگ در یک بسته">
              <DataTableHead>
                <Th>{layout.rowAxis ?? ""}</Th>
                {layout.columns.map((col) => <Th key={col}>{col}</Th>)}
              </DataTableHead>
              <DataTableBody>
                {layout.rows.map((row) => (
                  <DataTableRow key={row}>
                    <Td>{row}</Td>
                    {layout.columns.map((col) => {
                      const cell = matrix.cells.find((c) =>
                        (layout.sizeAxis ? (c.attributes[layout.sizeAxis] ?? "—") === col : true) &&
                        (layout.rowAxis ? (c.attributes[layout.rowAxis] ?? "—") === row : true));
                      if (!cell) return <Td key={col}>—</Td>;
                      const label = `${row !== "—" ? `${row} ` : ""}${col}`;
                      return (
                        <Td key={col}>
                          <Input aria-label={`تعداد ${label} در بسته`} inputMode="numeric" className="w-16"
                            value={quantityOf(cell.itemId) ? fa(quantityOf(cell.itemId)) : ""}
                            onChange={(e) => setCellQuantity(cell, e.target.value)} />
                          <span className="mt-1 block text-xs text-muted-foreground">موجودی {fa(cell.onHand)}</span>
                        </Td>
                      );
                    })}
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          )
        ) : null}
      </section>

      <section aria-labelledby="pack-components" className="space-y-2">
        <h3 id="pack-components" className="font-medium">اجزای بسته</h3>
        {components.length === 0 ? <InfoBox>هنوز تنوعی اضافه نشده است.</InfoBox> : (
          <DataTable caption="اجزای بسته">
            <DataTableHead><Th>تنوع</Th><Th>تعداد</Th><Th>قیمت عمدهٔ هر عدد</Th><Th>جمع</Th><Th>موجودی</Th><Th>حذف</Th></DataTableHead>
            <DataTableBody>
              {components.map((c) => (
                <DataTableRow key={c.itemId}>
                  <Td><span className="block">{c.name}</span><span className="block text-xs text-muted-foreground">{c.attributes}</span></Td>
                  <Td>{fa(c.quantity)}</Td>
                  <Td>
                    <Input aria-label={`قیمت عمدهٔ ${c.attributes || c.name}`} inputMode="numeric" className="w-32"
                      defaultValue={c.unitPriceRial ? money.formatText(String(c.unitPriceRial), { withUnit: false }) : ""}
                      onBlur={(e) => setPrice(c.itemId, e.target.value)} />
                  </Td>
                  <Td>{money.format(c.unitPriceRial * c.quantity)}</Td>
                  <Td>{fa(c.onHand)}</Td>
                  <Td>
                    <Button variant="ghost" size="icon" aria-label={`حذف ${c.attributes || c.name}`}
                      onClick={() => setComponents((list) => list.filter((x) => x.itemId !== c.itemId))}>
                      <Trash2Icon aria-hidden="true" className="size-4" />
                    </Button>
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </section>

      <dl className="grid grid-cols-3 gap-3 text-sm" aria-label="پیش‌نمایش بسته">
        <div><dt className="text-muted-foreground">تعداد قطعه</dt><dd className="font-semibold">{fa(totals.pieces)}</dd></div>
        <div><dt className="text-muted-foreground">قیمت بسته</dt><dd className="font-semibold">{money.format(totals.priceRial)}</dd></div>
        <div><dt className="text-muted-foreground">قابل ساخت از موجودی</dt><dd className="font-semibold">{fa(availability.available)} بسته</dd></div>
      </dl>
      {components.length > 0 && availability.shortages.length > 0 ? (
        <ul className="list-disc space-y-1 ps-5 text-sm" aria-label="کمبود برای یک بسته">
          {availability.shortages.map((s) => <li key={s.itemId}>{s.name}: نیاز {fa(s.need)}، موجود {fa(s.onHand)}، کمبود {fa(s.missing)}</li>)}
        </ul>
      ) : null}
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <Button onClick={save} disabled={busy}>ذخیرهٔ بسته</Button>
    </div>
  );
}

function SalesSection() {
  const money = useMoney();
  const [sales, setSales] = useState<PackSale[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<{ sales?: PackSale[]; error?: string }>("/api/size-packs/sales").then((res) => {
      if (!res.ok) setError(sizePackErrorMessage(res.data.error));
      setSales(res.data.sales ?? []);
    });
  }, []);
  return (
    <SectionCard title="فروش و برگشت بسته‌ها" description="هر فروش با همان ترکیب و قیمتی که فروخته شده ثبت است؛ برگشت هر تنوع از فاکتور فروش انجام می‌شود.">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {sales === null ? <SectionCardSkeleton /> : sales.length === 0 ? (
        <EmptyState title="هنوز بسته‌ای فروخته نشده" icon={PackageIcon}>بسته را در صندوق با بارکد آن یا از فهرست بسته‌ها بفروشید.</EmptyState>
      ) : (
        <DataTable caption="فروش بسته‌ها">
          <DataTableHead><Th>فاکتور</Th><Th>بسته</Th><Th>تعداد</Th><Th>مبلغ</Th><Th>برگشتی</Th><Th>وضعیت</Th></DataTableHead>
          <DataTableBody>
            {sales.map((s) => (
              <DataTableRow key={s.id}>
                <Td>{s.orderNumber ? fa(s.orderNumber) : "—"}</Td>
                <Td>{s.packName} <span className="text-xs text-muted-foreground">نسخهٔ {fa(s.packVersion)}</span></Td>
                <Td>{fa(s.packQuantity)}</Td>
                <Td>{money.format(s.totalRial)}</Td>
                <Td><span className="text-xs">{s.components.filter((c) => Number(c.returnedQuantity) > 0).map((c) => `${c.name} ${fa(c.returnedQuantity)}`).join("، ") || "—"}</span></Td>
                <Td><StatusBadge tone={SALE_STATUS[s.status].tone}>{SALE_STATUS[s.status].label}</StatusBadge></Td>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}
    </SectionCard>
  );
}
