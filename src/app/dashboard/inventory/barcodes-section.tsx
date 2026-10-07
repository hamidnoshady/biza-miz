"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CameraScanTrigger } from "@/components/scanner/camera-barcode-scanner";
import { toPersianDigits } from "@/lib/digits";
import { barcodeEntryError, normalizeBarcode } from "@/lib/barcode";
import { printLabel } from "@/lib/printing/client";
import { type LabelData } from "@/lib/label-template";
import { useBusinessInfo } from "../use-business-info";
import { SectionCard, StatusBadge } from "../page-chrome";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { api, Field, inputClass } from "../ui";
import type { InventoryItem } from "./inventory-manager";

/**
 * Barcodes and shelf labels for raw ingredients — the step that has to happen
 * before a store room can be counted with a scanner at all.
 *
 * The retail trades got this in Phase 27 Wave 4 (`/api/barcodes`, the label
 * panel on the merchandising screen). F&B's `inventory_items` never had it, so
 * the only "code" an ingredient carried was `sku`, a search hint no scanner
 * emits. The label itself goes through the one printing pipeline every other
 * document uses (`printLabel` → the branch's label rule → the label template →
 * ESC/POS raster); an ingredient's label carries the unit rather than a shelf
 * price, because raw stock is not priced to sell.
 *
 * Each card owns its own notice/error line (rendered inside the card the
 * action lives in, with `role="status"`), so a message from «چاپ لیبل» never
 * appears in the bulk-mint card a screen height away. API failures surface
 * the server's own Persian `message` when it sends one — the duplicate-code
 * and check-digit refusals are written for the operator, not for a log.
 */
interface BarcodeRow {
  id: string;
  inventoryItemId: string;
  code: string;
  symbology: string;
  note: string | null;
}

interface PendingItem {
  id: string;
  name: string;
  unit: string;
}

/** One row of the bulk-mint response — what the «چاپ لیبل‌ها» follow-up prints. */
interface MintedCode {
  inventoryItemId: string;
  itemName: string;
  code: string;
}

const SYMBOLOGY_LABELS: Record<string, string> = {
  EAN13: "EAN-13",
  UPC: "UPC",
  internal: "داخلی",
};

function StatusLine({ notice, error }: { notice: string; error: string }) {
  if (!notice && !error) return null;
  return (
    <p
      role="status"
      aria-live="polite"
      className={`mt-3 text-sm ${
        error ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300"
      }`}
    >
      {error || notice}
    </p>
  );
}

export function BarcodesSection({
  items,
  busy,
}: {
  items: InventoryItem[];
  busy: boolean;
}) {
  const [pending, setPending] = useState<PendingItem[] | null>(null);
  const [itemId, setItemId] = useState("");
  const [manualCode, setManualCode] = useState("");
  const [barcodes, setBarcodes] = useState<BarcodeRow[]>([]);
  const [barcodesLoading, setBarcodesLoading] = useState(false);
  const [minted, setMinted] = useState<MintedCode[]>([]);
  const [saving, setSaving] = useState(false);
  const [minting, setMinting] = useState(false);
  const [printingAll, setPrintingAll] = useState(false);
  // Each card's own message line, so feedback shows up next to the button
  // that produced it rather than in another card off-screen on a phone.
  const [prepNotice, setPrepNotice] = useState("");
  const [prepError, setPrepError] = useState("");
  const [manageNotice, setManageNotice] = useState("");
  const [manageError, setManageError] = useState("");
  const businessInfo = useBusinessInfo();

  const selected = items.find((i) => i.id === itemId);
  const anyBusy = busy || saving || minting || printingAll;

  const loadPending = useCallback(() => {
    api<{ pending: PendingItem[] }>("/api/inventory/barcodes").then(({ ok, data }) => {
      if (ok) setPending(data.pending);
    });
  }, []);
  useEffect(loadPending, [loadPending]);

  // Keyed so a slow response for the previously selected item can never
  // overwrite the list of the one selected now.
  const barcodesRequestId = useRef(0);
  const loadBarcodes = useCallback(() => {
    const requestId = ++barcodesRequestId.current;
    if (!itemId) {
      setBarcodes([]);
      setBarcodesLoading(false);
      return;
    }
    setBarcodesLoading(true);
    api<{ barcodes: BarcodeRow[] }>(
      `/api/inventory/barcodes?inventoryItemId=${encodeURIComponent(itemId)}`,
    ).then(({ ok, data }) => {
      if (requestId !== barcodesRequestId.current) return;
      setBarcodesLoading(false);
      if (ok) setBarcodes(data.barcodes);
    });
  }, [itemId]);
  useEffect(loadBarcodes, [loadBarcodes]);

  // A message about one item's barcodes is stale the moment another item is picked.
  useEffect(() => {
    setManageNotice("");
    setManageError("");
  }, [itemId]);

  async function assign(generate: boolean) {
    if (!itemId || saving) return;
    setManageError("");
    setManageNotice("");

    const code = generate ? "" : normalizeBarcode(manualCode);
    if (!generate) {
      if (!code) return;
      // The same refusal the server would send, without the round trip: a
      // 12/13-digit code whose check digit fails is a typo with certainty.
      const entryError = barcodeEntryError(code);
      if (entryError) {
        setManageError(entryError);
        return;
      }
    }

    setSaving(true);
    const { ok, data } = await api<{ barcode?: BarcodeRow; message?: string }>(
      "/api/inventory/barcodes",
      {
        method: "POST",
        body: JSON.stringify(generate ? { inventoryItemId: itemId } : { inventoryItemId: itemId, code }),
      },
    );
    setSaving(false);
    if (!ok) {
      setManageError(data.message ?? "ثبت بارکد ناموفق بود.");
      return;
    }
    setManualCode("");
    setManageNotice(
      data.barcode?.code
        ? `بارکد ${toPersianDigits(data.barcode.code)} ثبت شد.`
        : "بارکد ثبت شد.",
    );
    loadBarcodes();
    loadPending();
  }

  async function mintAll() {
    if (minting) return;
    setPrepError("");
    setPrepNotice("");
    setMinting(true);
    const { ok, data } = await api<{ minted?: number; codes?: MintedCode[]; message?: string }>(
      "/api/inventory/barcodes/bulk",
      { method: "POST" },
    );
    setMinting(false);
    if (!ok) {
      setPrepError(data.message ?? "تولید بارکد ناموفق بود.");
      return;
    }
    setMinted(data.codes ?? []);
    setPrepNotice(`${toPersianDigits(data.minted ?? 0)} بارکد داخلی تولید شد. حالا لیبل‌ها را چاپ کنید.`);
    loadPending();
    loadBarcodes();
  }

  /** Print one label; resolves to null on success or a Persian error message. */
  async function printOne(code: string, item: { name: string; unit: string }): Promise<string | null> {
    const label: LabelData = {
      businessName: businessInfo.name || "انبار",
      itemName: item.name,
      code,
      fields: [{ label: "واحد", value: item.unit }],
    };
    // No printer id: the label rule decides. If the branch has no label
    // printer at all, the server refuses with `printer_not_configured` — the
    // browser's print dialog is not a fallback anywhere in this product.
    const res = await printLabel(null, label, { requestId: `label:${code}` });
    if (res.ok) return null;
    return res.error === "connector_not_installed" || res.error === "connector_outdated" ? "رابط چاپ روی این کامپیوتر در دسترس نیست؛ از تنظیمات چاپگرها نصب کنید." : "چاپ لیبل ناموفق بود.";
  }

  async function printSelected(code: string, item: { name: string; unit: string }) {
    setManageError("");
    setManageNotice("");
    const error = await printOne(code, item);
    if (error) setManageError(error);
    else setManageNotice("لیبل چاپ شد.");
  }

  function mintedLabel(row: MintedCode): LabelData {
    const unit = items.find((i) => i.id === row.inventoryItemId)?.unit ?? "";
    return {
      businessName: businessInfo.name || "انبار",
      itemName: row.itemName,
      code: row.code,
      fields: unit ? [{ label: "واحد", value: unit }] : [],
    };
  }

  async function printMinted() {
    if (printingAll || minted.length === 0) return;
    setPrepError("");
    setPrepNotice("");
    setPrintingAll(true);

    let printed = 0;
    for (const row of minted) {
      const res = await printLabel(null, mintedLabel(row), { requestId: `label:${row.code}` });
      if (!res.ok) {
        const reason =
          res.error === "connector_not_installed" || res.error === "connector_outdated" ? "رابط چاپ روی این کامپیوتر در دسترس نیست؛ از تنظیمات چاپگرها نصب کنید." : "چاپ لیبل ناموفق بود.";
        setPrepError(
          printed > 0
            ? `${toPersianDigits(printed)} لیبل چاپ شد؛ سپس چاپ متوقف شد: ${reason}`
            : reason,
        );
        setPrintingAll(false);
        return;
      }
      printed += 1;
    }
    setPrintingAll(false);
    setPrepNotice(`${toPersianDigits(printed)} لیبل چاپ شد.`);
    setMinted([]);
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">آماده‌سازی</p>
            <h2 className="mt-1 font-semibold text-foreground">آماده‌سازی انبار برای شمارش</h2>
          </div>
        }
        description="شمارش با بارکدخوان تنها برای اقلامی کار می‌کند که بارکد داشته باشند. اقلامی که هنوز بارکد ندارند در فهرست زیر می‌آیند؛ با یک دکمه برای همهٔ آن‌ها بارکد داخلی تولید کنید و سپس لیبل‌ها را چاپ و روی قفسه‌ها نصب کنید."
      >
        {pending === null ? (
          <LoadingSkeleton rows={3} />
        ) : pending.length === 0 && minted.length === 0 ? (
          <p className="text-sm text-emerald-700 dark:text-emerald-300">
            همهٔ اقلام فعال بارکد دارند؛ انبار آمادهٔ شمارش است.
          </p>
        ) : (
          <>
            {pending.length > 0 ? (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <span className="text-sm">{toPersianDigits(pending.length)} قلم بدون بارکد</span>
                  <Button
                    type="button"
                    disabled={anyBusy}
                    variant="outline"
                    size="lg"
                    onClick={() => void mintAll()}
                  >
                    {minting ? "در حال تولید…" : "تولید بارکد برای همه"}
                  </Button>
                </div>
                <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                  {pending.map((p) => (
                    <li key={p.id} className="px-3 py-2 text-sm">
                      {p.name}{" "}
                      <span className="text-xs text-muted-foreground">({p.unit})</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {minted.length > 0 ? (
              <div className={pending.length > 0 ? "mt-4" : undefined}>
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <span className="text-sm">
                    {toPersianDigits(minted.length)} بارکد تازه — لیبل‌ها را چاپ و نصب کنید
                  </span>
                  <Button
                    type="button"
                    disabled={anyBusy}
                    variant="outline"
                    size="lg"
                    onClick={() => void printMinted()}
                  >
                    {printingAll ? "در حال چاپ…" : "چاپ همهٔ لیبل‌ها"}
                  </Button>
                </div>
                <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                  {minted.map((m) => (
                    <li
                      key={m.inventoryItemId}
                      className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 break-words">{m.itemName}</span>
                      <span dir="ltr" className="font-mono text-xs text-muted-foreground">
                        {m.code}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
        <StatusLine notice={prepNotice} error={prepError} />
      </SectionCard>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">مدیریت بارکد</p>
            <h2 className="mt-1 font-semibold text-foreground">بارکد یک قلم</h2>
          </div>
        }
        description="اگر بسته‌بندی تأمین‌کننده بارکد چاپی دارد، همان را ثبت کنید تا نیازی به لیبل تازه نباشد."
      >
        <Field label="قلم انبار">
          <SearchableSelect
            value={itemId}
            onChange={setItemId}
            placeholder="انتخاب قلم"
            options={items
              .filter((i) => i.is_active)
              .map((i) => ({
                value: i.id,
                label: `${i.name} (${i.unit})`,
                searchString: [i.name, i.sku, i.unit].filter(Boolean).join(" "),
              }))}
          />
        </Field>
        <div className="mt-3 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
          <input
            className={`${inputClass} col-span-2 sm:col-span-1`}
            dir="ltr"
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
            onKeyDown={(e) => {
              // A handheld scanner types the code and presses Enter; treat it
              // as «ثبت» instead of letting the key fall through unused.
              if (e.key === "Enter") {
                e.preventDefault();
                if (!anyBusy && selected && manualCode.trim()) void assign(false);
              }
            }}
            placeholder="بارکد تأمین‌کننده (EAN-13 یا UPC)"
            aria-label="بارکد تأمین‌کننده"
          />
          <CameraScanTrigger
            label="دوربین"
            disabled={anyBusy || !selected}
            className="gap-1.5 min-h-[44px] border-border px-4 text-foreground/80"
            title="خواندن بارکد تأمین‌کننده"
            description="بارکد روی بسته‌بندی را با دوربین بخوانید تا روی این قلم ثبت شود."
            onScan={(scanned) => setManualCode(scanned)}
          />
          <Button
            type="button"
            disabled={anyBusy || !selected || !manualCode.trim()}
            variant="outline"
            size="lg"
            onClick={() => void assign(false)}
          >
            {saving ? "در حال ثبت…" : "ثبت"}
          </Button>
        </div>
        <Button
          type="button"
          disabled={anyBusy || !selected}
          variant="outline"
          size="lg"
          className="mt-2 w-full"
          onClick={() => void assign(true)}
        >
          تولید بارکد داخلی
        </Button>

        {selected && barcodesLoading ? (
          <LoadingSkeleton rows={2} compact className="mt-3" label="در حال بارگذاری بارکدهای قلم" />
        ) : selected && barcodes.length > 0 ? (
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
            {barcodes.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span dir="ltr" className="font-mono break-all">
                    {b.code}
                  </span>
                  <StatusBadge tone={b.symbology === "internal" ? "neutral" : "active"}>
                    {SYMBOLOGY_LABELS[b.symbology] ?? b.symbology}
                  </StatusBadge>
                  {b.note ? (
                    <span className="text-xs text-muted-foreground">{b.note}</span>
                  ) : null}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={anyBusy}
                  onClick={() => void printSelected(b.code, { name: selected.name, unit: selected.unit })}
                >
                  چاپ لیبل
                </Button>
              </li>
            ))}
          </ul>
        ) : selected ? (
          <p className="mt-3 text-xs text-muted-foreground">
            هنوز بارکدی برای این قلم ثبت نشده است.
          </p>
        ) : null}
        <StatusLine notice={manageNotice} error={manageError} />
      </SectionCard>
    </div>
  );
}
