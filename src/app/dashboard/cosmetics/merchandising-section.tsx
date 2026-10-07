"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { printLabel } from "@/lib/printing/client";
import { labelFieldsForTrade, type LabelData } from "@/lib/label-template";
import { useBusinessInfo } from "../use-business-info";
import { api, Field, inputClass } from "../ui";
import {
  LoadingSkeleton,
  SectionCardSkeleton,
  cardClass,
} from "../page-chrome";

const accInputClass = `${inputClass} min-h-[52px] !border-border !bg-card shadow-none placeholder:text-muted-foreground focus-visible:border-amber-500 dark:focus-visible:border-amber-500/60 focus-visible:ring-amber-400/30 dark:focus-visible:ring-amber-400/40`;

interface ItemRow {
  id: string;
  parentName: string | null;
  name: string;
  brandId: string | null;
  brandName: string | null;
  ircCode: string | null;
  healthPermit: string | null;
  authenticityRegistration: string | null;
  tags: string[];
  unitCost: number | null;
  unitPrice: number | null;
  kind: string;
  tracking: string;
  attributes: { name: string; value: string }[];
  batches: {
    id: string;
    batchNumber: string;
    expiryDate: string | null;
    quantity: string;
  }[];
}

interface BrandRow {
  id: string;
  name: string;
  country: string | null;
  productLine: string | null;
}

function parseList(value: string): string[] {
  // Accept Persian comma too; it is the natural keyboard character in RTL
  // fields and previously produced a single invalid matrix value.
  return value
    .split(/[،,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function MerchandisingSection() {
  const [items, setItems] = useState<ItemRow[]>([]);
  const [brands, setBrands] = useState<BrandRow[]>([]);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [itemsResult, brandsResult] = await Promise.allSettled([
      api<{ items: ItemRow[] }>("/api/cosmetics/items"),
      api<{ brands: BrandRow[] }>("/api/cosmetics/brands"),
    ]);
    if (itemsResult.status === "fulfilled" && itemsResult.value.ok) {
      setItems(
        itemsResult.value.data.items.filter((i) => i.kind !== "variant_parent"),
      );
    }
    if (brandsResult.status === "fulfilled" && brandsResult.value.ok) {
      setBrands(brandsResult.value.data.brands);
    }
    if (
      itemsResult.status === "rejected" ||
      (itemsResult.status === "fulfilled" && !itemsResult.value.ok)
    ) {
      setError("بارگذاری کالاهای آرایشی ناموفق بود. دوباره تلاش کنید.");
    } else if (
      brandsResult.status === "rejected" ||
      (brandsResult.status === "fulfilled" && !brandsResult.value.ok)
    ) {
      setError("بارگذاری برندها ناموفق بود. دوباره تلاش کنید.");
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const refreshDone = (message: string) => {
    setDone(message);
    load();
  };

  if (!loaded) {
    return (
      <div className="grid min-w-0 gap-4 xl:grid-cols-3">
        {[0, 1, 2].map((item) => (
          <SectionCardSkeleton key={item} rows={4} />
        ))}
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-3">
      <BrandForm
        busy={busy}
        setBusy={setBusy}
        setError={setError}
        onDone={refreshDone}
      />
      <MatrixForm
        busy={busy}
        setBusy={setBusy}
        setError={setError}
        onDone={refreshDone}
      />
      <ItemProfileForm
        items={items}
        brands={brands}
        busy={busy}
        setBusy={setBusy}
        setError={setError}
        onDone={refreshDone}
      />

      {error ? (
        <p className="text-xs text-rose-700 dark:text-rose-300 xl:col-span-3">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="text-xs text-emerald-700 dark:text-emerald-300 xl:col-span-3">
          {done}
        </p>
      ) : null}

      <TesterPanel
        items={items}
        busy={busy}
        setBusy={setBusy}
        setError={setError}
        onDone={refreshDone}
      />
      <BarcodesPanel
        items={items}
        busy={busy}
        setBusy={setBusy}
        setError={setError}
        onDone={refreshDone}
      />
    </div>
  );
}

function PanelShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`${cardClass} p-4 sm:p-5`}>
      <h2 className="font-semibold text-foreground">{title}</h2>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

function BrandForm({
  busy,
  setBusy,
  setError,
  onDone,
}: {
  busy: boolean;
  setBusy: (v: boolean) => void;
  setError: (v: string) => void;
  onDone: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [country, setCountry] = useState("");
  const [productLine, setProductLine] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string; message?: string }>(
      "/api/cosmetics/brands",
      {
        method: "POST",
        body: JSON.stringify({
          name,
          country: country.trim() || null,
          productLine: productLine.trim() || null,
        }),
      },
    );
    setBusy(false);
    if (!ok) setError(data.message ?? "ثبت برند ناموفق بود.");
    else {
      setName("");
      setCountry("");
      setProductLine("");
      onDone("برند ثبت شد.");
    }
  }

  return (
    <PanelShell title="افزودن برند">
      <form onSubmit={submit}>
        <Field label="نام برند">
          <input
            className={accInputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>
        <Field label="کشور سازنده">
          <input
            className={accInputClass}
            value={country}
            onChange={(e) => setCountry(e.target.value)}
          />
        </Field>
        <Field label="خط تولید">
          <input
            className={accInputClass}
            value={productLine}
            onChange={(e) => setProductLine(e.target.value)}
          />
        </Field>
        <Button
          type="submit"
          disabled={busy}
          size="lg"
          className="min-h-[52px] w-full border border-amber-300 dark:border-amber-500/40 px-5 font-semibold"
        >
          ثبت برند
        </Button>
      </form>
    </PanelShell>
  );
}

function MatrixForm({
  busy,
  setBusy,
  setError,
  onDone,
}: {
  busy: boolean;
  setBusy: (v: boolean) => void;
  setError: (v: string) => void;
  onDone: (m: string) => void;
}) {
  const [parentName, setParentName] = useState("");
  const [axisAName, setAxisAName] = useState("سایه");
  const [axisAValues, setAxisAValues] = useState("");
  const [axisBName, setAxisBName] = useState("حجم");
  const [axisBValues, setAxisBValues] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!parentName.trim() || !axisAName.trim() || !axisAValues.trim()) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string; message?: string }>(
      "/api/cosmetics/matrix",
      {
        method: "POST",
        body: JSON.stringify({
          parentName,
          axisA: { name: axisAName.trim(), values: parseList(axisAValues) },
          axisB:
            axisBName.trim() && axisBValues.trim()
              ? { name: axisBName.trim(), values: parseList(axisBValues) }
              : { name: "", values: [] },
        }),
      },
    );
    setBusy(false);
    if (!ok) setError(data.message ?? "ساخت ماتریس ناموفق بود.");
    else {
      setParentName("");
      setAxisAValues("");
      setAxisBValues("");
      onDone("ماتریس تنوع ساخته شد.");
    }
  }

  return (
    <PanelShell title="ویرایشگر ماتریس تنوع">
      <form onSubmit={submit}>
        <Field label="نام خانواده">
          <input
            className={accInputClass}
            value={parentName}
            onChange={(e) => setParentName(e.target.value)}
            placeholder="مثلاً کرم پودر"
            required
          />
        </Field>
        <Field label="محور اول — نام">
          <input
            className={accInputClass}
            value={axisAName}
            onChange={(e) => setAxisAName(e.target.value)}
          />
        </Field>
        <Field label="محور اول — مقادیر (با کاما)">
          <input
            className={accInputClass}
            dir="ltr"
            value={axisAValues}
            onChange={(e) => setAxisAValues(e.target.value)}
            placeholder="روشن، تیره"
          />
        </Field>
        <Field label="محور دوم — نام (اختیاری)">
          <input
            className={accInputClass}
            value={axisBName}
            onChange={(e) => setAxisBName(e.target.value)}
          />
        </Field>
        <Field label="محور دوم — مقادیر (با کاما)">
          <input
            className={accInputClass}
            dir="ltr"
            value={axisBValues}
            onChange={(e) => setAxisBValues(e.target.value)}
            placeholder="۳۰ میل، ۵۰ میل"
          />
        </Field>
        <Button
          type="submit"
          disabled={busy}
          size="lg"
          className="min-h-[52px] w-full border border-amber-300 dark:border-amber-500/40 px-5 font-semibold"
        >
          ساخت N×M تنوع
        </Button>
      </form>
    </PanelShell>
  );
}

function ItemProfileForm({
  items,
  brands,
  busy,
  setBusy,
  setError,
  onDone,
}: {
  items: ItemRow[];
  brands: BrandRow[];
  busy: boolean;
  setBusy: (v: boolean) => void;
  setError: (v: string) => void;
  onDone: (m: string) => void;
}) {
  const [itemId, setItemId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [ircCode, setIrcCode] = useState("");
  const [healthPermit, setHealthPermit] = useState("");
  const [authenticity, setAuthenticity] = useState("");
  const [tags, setTags] = useState("");

  const selected = items.find((i) => i.id === itemId);

  useEffect(() => {
    if (!selected) {
      setBrandId("");
      setIrcCode("");
      setHealthPermit("");
      setAuthenticity("");
      setTags("");
      return;
    }
    setBrandId(selected.brandId ?? "");
    setIrcCode(selected.ircCode ?? "");
    setHealthPermit(selected.healthPermit ?? "");
    setAuthenticity(selected.authenticityRegistration ?? "");
    setTags(selected.tags.join("، "));
  }, [selected]);

  // ⚡ Bolt: Compute option arrays using useMemo to prevent per-render reallocation.
  const itemOptions = React.useMemo(
    () =>
      items.map((i) => ({
        value: i.id,
        label: `${i.parentName ? `${i.parentName} — ` : ""}${i.name}`,
      })),
    [items],
  );

  const brandOptions = React.useMemo(
    () => [
      { value: "", label: "بدون برند" },
      ...brands.map((b) => ({ value: b.id, label: b.name })),
    ],
    [brands],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!itemId) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string; message?: string }>(
      `/api/cosmetics/items/${itemId}/profile`,
      {
        method: "POST",
        body: JSON.stringify({
          brandId: brandId || null,
          ircCode: ircCode.trim() || null,
          healthPermit: healthPermit.trim() || null,
          authenticityRegistration: authenticity.trim() || null,
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        }),
      },
    );
    setBusy(false);
    if (!ok) setError(data.message ?? "ذخیره ناموفق بود.");
    else {
      // Keep the editor truthful after save: a second save must not submit
      // stale regulatory values for the previously selected item.
      setIrcCode("");
      setHealthPermit("");
      setAuthenticity("");
      setTags("");
      onDone("مشخصات کالا ذخیره شد.");
    }
  }

  return (
    <PanelShell title="برند و هویت قانونی کالا">
      <form onSubmit={submit}>
        <Field label="کالا">
          <SearchableSelect
            className={accInputClass}
            value={itemId}
            onChange={setItemId}
            options={itemOptions}
            placeholder="انتخاب کالا"
          />
        </Field>
        <Field label="برند">
          <SearchableSelect
            className={accInputClass}
            value={brandId}
            onChange={setBrandId}
            options={brandOptions}
            placeholder="انتخاب برند"
          />
        </Field>
        <Field label="کد IRC">
          <input
            className={accInputClass}
            dir="ltr"
            value={ircCode}
            onChange={(e) => setIrcCode(e.target.value)}
          />
        </Field>
        <Field label="پروانه بهداشت">
          <input
            className={accInputClass}
            dir="ltr"
            value={healthPermit}
            onChange={(e) => setHealthPermit(e.target.value)}
          />
        </Field>
        <Field label="ثبت اصالت کالا">
          <input
            className={accInputClass}
            dir="ltr"
            value={authenticity}
            onChange={(e) => setAuthenticity(e.target.value)}
          />
        </Field>
        <Field label="نوع پوست/مو (با کاما)">
          <input
            className={accInputClass}
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="پوست چرب، موی رنگ‌شده"
          />
        </Field>
        {selected?.brandName ? (
          <p className="text-xs text-muted-foreground">
            برند فعلی: {selected.brandName}
          </p>
        ) : null}
        <Button
          type="submit"
          disabled={busy}
          size="lg"
          className="min-h-[52px] w-full border border-amber-300 dark:border-amber-500/40 px-5 font-semibold"
        >
          ذخیره
        </Button>
      </form>
    </PanelShell>
  );
}

function TesterPanel({
  items,
  busy,
  setBusy,
  setError,
  onDone,
}: {
  items: ItemRow[];
  busy: boolean;
  setBusy: (v: boolean) => void;
  setError: (v: string) => void;
  onDone: (m: string) => void;
}) {
  const money = useMoney();
  const [itemId, setItemId] = useState("");
  const selected = items.find((i) => i.id === itemId);

  // ⚡ Bolt: Compute option array using useMemo to prevent per-render reallocation.
  const itemOptions = React.useMemo(
    () =>
      items.map((i) => ({
        value: i.id,
        label: `${i.parentName ? `${i.parentName} — ` : ""}${i.name}${
          i.unitCost != null ? ` (بها ${money.format(i.unitCost)})` : ""
        }`,
      })),
    [items, money],
  );

  async function open() {
    if (!itemId) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string; message?: string }>(
      `/api/cosmetics/items/${itemId}/tester`,
      {
        method: "POST",
      },
    );
    setBusy(false);
    if (!ok) setError(data.message ?? "باز کردن تستر ناموفق بود.");
    else {
      setItemId("");
      onDone("تستر باز شد و بهای آن به حساب ۵۱۶۰ منتقل شد.");
    }
  }

  return (
    <PanelShell title="تستر / نمونه">
      <Field label="کالا">
        <SearchableSelect
          className={accInputClass}
          value={itemId}
          onChange={setItemId}
          options={itemOptions}
          placeholder="انتخاب کالا"
        />
      </Field>
      <p className="text-xs leading-5 text-muted-foreground">
        یک واحد فروختنی را به‌عنوان تستر باز می‌کند؛ بهای تمام‌شدهٔ آن به هزینهٔ
        بازاریابی (۵۱۶۰) می‌رود، نه بهای کالای فروخته‌شده.
      </p>
      <Button
        type="button"
        disabled={busy || !selected}
        size="lg"
        className="min-h-[52px] w-full border border-amber-300 dark:border-amber-500/40 px-5 font-semibold"
        onClick={() => void open()}
      >
        باز کردن تستر
      </Button>
    </PanelShell>
  );
}

interface BarcodeRow {
  id: string;
  code: string;
  symbology: string;
  note: string | null;
}

function BarcodesPanel({
  items,
  busy,
  setBusy,
  setError,
  onDone,
}: {
  items: ItemRow[];
  busy: boolean;
  setBusy: (v: boolean) => void;
  setError: (v: string) => void;
  onDone: (m: string) => void;
}) {
  const money = useMoney();
  const [itemId, setItemId] = useState("");
  const [manualCode, setManualCode] = useState("");
  const [barcodes, setBarcodes] = useState<BarcodeRow[]>([]);
  const [barcodesLoading, setBarcodesLoading] = useState(false);
  const businessInfo = useBusinessInfo();

  const selected = items.find((i) => i.id === itemId);

  // ⚡ Bolt: Compute option array using useMemo to prevent per-render reallocation.
  const itemOptions = React.useMemo(
    () =>
      items.map((i) => ({
        value: i.id,
        label: `${i.parentName ? `${i.parentName} — ` : ""}${i.name}`,
      })),
    [items],
  );

  useEffect(() => {
    if (!itemId) {
      setBarcodes([]);
      setBarcodesLoading(false);
      return;
    }
    let cancelled = false;
    setBarcodes([]);
    setBarcodesLoading(true);
    void api<{ barcodes: BarcodeRow[] }>(
      `/api/barcodes?itemId=${encodeURIComponent(itemId)}`,
    )
      .then(({ ok, data }) => {
        if (!cancelled && ok) setBarcodes(data.barcodes);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setBarcodesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  async function assign(generate: boolean) {
    if (!itemId) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{
      ok?: boolean;
      barcode?: BarcodeRow;
      error?: string;
      message?: string;
    }>("/api/barcodes", {
      method: "POST",
      body: JSON.stringify(
        generate ? { itemId } : { itemId, code: manualCode },
      ),
    });
    setBusy(false);
    if (!ok) {
      setError(data.message ?? "ثبت بارکد ناموفق بود.");
      return;
    }
    setManualCode("");
    onDone(
      data.barcode?.code
        ? `بارکد ${data.barcode.code} ثبت شد.`
        : "بارکد ثبت شد.",
    );
  }

  function print(code: string) {
    if (!selected) return;
    const shade =
      selected.attributes.find((a) => a.name === "سایه" || a.name === "رنگ")
        ?.value ?? null;
    const expiry =
      selected.batches
        .filter((b) => b.expiryDate)
        .sort((a, b) => (a.expiryDate! < b.expiryDate! ? -1 : 1))[0]
        ?.expiryDate ?? null;
    const label: LabelData = {
      businessName: businessInfo.name || "فروشگاه",
      itemName: selected.name,
      code,
      fields: labelFieldsForTrade(
        "cosmetics",
        {
          name: selected.name,
          price: selected.unitPrice,
          shade,
          expiryDate: expiry,
        },
        money.unit,
      ),
    };
    printLabel(null, label, { requestId: `label:${code}` }).then((res) => {
      if (res.ok) onDone("لیبل چاپ شد.");
      else
        setError(
          res.error === "connector_not_installed" ||
            res.error === "connector_outdated"
            ? "رابط چاپ روی این کامپیوتر در دسترس نیست؛ از تنظیمات چاپگرها نصب کنید."
            : "چاپ لیبل ناموفق بود.",
        );
    });
  }

  return (
    <PanelShell title="بارکد و لیبل">
      <Field label="کالا">
        <SearchableSelect
          className={accInputClass}
          value={itemId}
          onChange={setItemId}
          options={itemOptions}
          placeholder="انتخاب کالا"
        />
      </Field>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <input
          className={accInputClass}
          dir="ltr"
          value={manualCode}
          onChange={(e) => setManualCode(e.target.value)}
          placeholder="بارکد فروشنده (اختیاری)"
        />
        <Button
          type="button"
          disabled={busy || !selected}
          size="lg"
          className="min-h-[52px] border border-amber-300 dark:border-amber-500/40 px-4 font-semibold"
          onClick={() => void assign(false)}
        >
          ثبت
        </Button>
      </div>
      <Button
        type="button"
        disabled={busy || !selected}
        size="lg"
        className="min-h-[52px] w-full border border-amber-300 dark:border-amber-500/40 px-5 font-semibold"
        onClick={() => void assign(true)}
      >
        تولید بارکد داخلی
      </Button>

      {barcodesLoading ? (
        <LoadingSkeleton
          rows={2}
          compact
          label="در حال بارگذاری بارکدهای کالا"
        />
      ) : barcodes.length > 0 ? (
        <ul className="divide-y divide-border/80 text-sm">
          {barcodes.map((b) => (
            <li
              key={b.id}
              className="flex items-center justify-between gap-2 py-2"
            >
              <span dir="ltr" className="font-mono text-foreground">
                {b.code}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => print(b.code)}
              >
                چاپ لیبل
              </Button>
            </li>
          ))}
        </ul>
      ) : selected ? (
        <p className="text-xs text-muted-foreground">
          هنوز بارکدی برای این کالا ثبت نشده است.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          برای دیدن بارکدها، یک کالا انتخاب کنید.
        </p>
      )}
    </PanelShell>
  );
}
