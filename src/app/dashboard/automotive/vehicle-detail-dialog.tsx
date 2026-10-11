"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ErrorBox, Field, PrimaryButton, SecondaryButton, errorMessage, inputClass } from "../ui";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge, overlayPanelClass } from "../page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "../data-table";
import { JalaliDatePicker } from "../jalali-date-picker";
import { MediaPickerDialog, mediaFileUrl, type PickedMedia } from "../media/media-picker";
import { formatJalali } from "@/lib/jalali";
import {
  VEHICLE_BODY_TYPES,
  VEHICLE_BODY_TYPE_LABELS,
  VEHICLE_DRIVETRAINS,
  VEHICLE_DRIVETRAIN_LABELS,
  VEHICLE_FUEL_TYPES,
  VEHICLE_FUEL_TYPE_LABELS,
  VEHICLE_MEDIA_CATEGORIES,
  VEHICLE_MEDIA_CATEGORY_LABELS,
  VEHICLE_STATE_LABELS,
  VEHICLE_TRANSMISSIONS,
  VEHICLE_TRANSMISSION_LABELS,
  type VehicleMediaCategory,
  type VehicleState,
} from "@/lib/automotive";
import type { MediaKind } from "@/lib/media";
import type { VehicleMediaAttachment, VehiclePriceHistoryEntry, VehicleTransferRow } from "@/lib/automotive-service";

interface VehicleCostDto {
  id: string;
  category: string;
  posting: "capitalized" | "period_expense";
  amountRial: number;
  incurredOn: string;
  vendorName: string | null;
  documentRef: string | null;
  notes: string | null;
  status: "active" | "void";
  voidReason: string | null;
}

interface VehicleDetailDto {
  serialId: string;
  locationId: string;
  stockNumber: string;
  displayName: string;
  make: string;
  model: string;
  trim: string | null;
  vehicleYearCalendar: "jalali" | "gregorian";
  modelYear: number | null;
  productionYear: number | null;
  vin: string | null;
  chassisNumber: string | null;
  engineNumber: string | null;
  plateNumber: string | null;
  bodyType: string | null;
  transmission: string | null;
  fuelType: string | null;
  engineSpec: string | null;
  drivetrain: string | null;
  exteriorColor: string | null;
  interiorColor: string | null;
  condition: "new" | "used";
  mileageKm: number | null;
  priorOwners: number | null;
  registrationDate: string | null;
  inspectionNotes: string | null;
  bodyConditionNotes: string | null;
  mechanicalNotes: string | null;
  serviceHistory: string | null;
  state: VehicleState;
  acquisitionDate: string | null;
  purchaseCostRial?: number;
  askingPriceRial: number;
  minimumPriceRial?: number | null;
  wholesalePriceRial?: number | null;
  promotionalPriceRial?: number | null;
  effectiveCostRial?: number;
  capitalizedCostRial?: number;
  periodExpenseRial?: number;
  soldOn: string | null;
  salePriceRial: number | null;
  costs?: VehicleCostDto[];
}

interface VehicleDetailResponseDto {
  vehicle?: VehicleDetailDto;
  canSeeCost?: boolean;
  canSeePriceHistory?: boolean;
  priceHistory?: VehiclePriceHistoryEntry[];
  transfers?: VehicleTransferRow[];
  error?: string;
  message?: string;
}

interface VehicleMediaResponseDto {
  attachments?: VehicleMediaAttachment[];
  error?: string;
  message?: string;
}

interface EditForm {
  vin: string;
  chassisNumber: string;
  engineNumber: string;
  plateNumber: string;
  mileageKm: string;
  priorOwners: string;
  registrationDate: string;
  bodyType: string;
  transmission: string;
  fuelType: string;
  drivetrain: string;
  engineSpec: string;
  exteriorColor: string;
  interiorColor: string;
  inspectionNotes: string;
  bodyConditionNotes: string;
  mechanicalNotes: string;
  serviceHistory: string;
}

interface PriceForm {
  askingPriceRial: string;
  minimumPriceRial: string;
  wholesalePriceRial: string;
  promotionalPriceRial: string;
  reason: string;
}

interface LocationOption {
  id: string;
  name: string;
}

const EMPTY_EDIT_FORM: EditForm = {
  vin: "", chassisNumber: "", engineNumber: "", plateNumber: "", mileageKm: "", priorOwners: "",
  registrationDate: "", bodyType: "", transmission: "", fuelType: "", drivetrain: "", engineSpec: "",
  exteriorColor: "", interiorColor: "", inspectionNotes: "", bodyConditionNotes: "", mechanicalNotes: "",
  serviceHistory: "",
};

function editFormFor(vehicle: VehicleDetailDto): EditForm {
  return {
    vin: vehicle.vin ?? "",
    chassisNumber: vehicle.chassisNumber ?? "",
    engineNumber: vehicle.engineNumber ?? "",
    plateNumber: vehicle.plateNumber ?? "",
    mileageKm: vehicle.mileageKm == null ? "" : String(vehicle.mileageKm),
    priorOwners: vehicle.priorOwners == null ? "" : String(vehicle.priorOwners),
    registrationDate: vehicle.registrationDate ?? "",
    bodyType: vehicle.bodyType ?? "",
    transmission: vehicle.transmission ?? "",
    fuelType: vehicle.fuelType ?? "",
    drivetrain: vehicle.drivetrain ?? "",
    engineSpec: vehicle.engineSpec ?? "",
    exteriorColor: vehicle.exteriorColor ?? "",
    interiorColor: vehicle.interiorColor ?? "",
    inspectionNotes: vehicle.inspectionNotes ?? "",
    bodyConditionNotes: vehicle.bodyConditionNotes ?? "",
    mechanicalNotes: vehicle.mechanicalNotes ?? "",
    serviceHistory: vehicle.serviceHistory ?? "",
  };
}

function priceFormFor(vehicle: VehicleDetailDto): PriceForm {
  return {
    askingPriceRial: String(vehicle.askingPriceRial),
    minimumPriceRial: vehicle.minimumPriceRial == null ? "" : String(vehicle.minimumPriceRial),
    wholesalePriceRial: vehicle.wholesalePriceRial == null ? "" : String(vehicle.wholesalePriceRial),
    promotionalPriceRial: vehicle.promotionalPriceRial == null ? "" : String(vehicle.promotionalPriceRial),
    reason: "",
  };
}

function money(value: number | null | undefined): string {
  return value == null ? "—" : value.toLocaleString("fa-IR");
}

function displayDate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return formatJalali(value, { withTime: value.includes("T") });
  } catch {
    return value;
  }
}

function parseWholeNumber(value: string, label: string, optional: boolean): { value: number | null; error: string | null } {
  if (!value.trim() && optional) return { value: null, error: null };
  if (!/^\d+$/.test(value.trim())) return { value: null, error: `${label} باید عدد صحیح نامنفی باشد.` };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return { value: null, error: `${label} خارج از بازهٔ مجاز است.` };
  return { value: parsed, error: null };
}

function statusTone(state: VehicleState): "active" | "positive" | "neutral" | "danger" {
  if (state === "in_stock" || state === "acquired") return "positive";
  if (state === "reserved" || state === "transferred") return "active";
  if (state === "returned") return "danger";
  return "neutral";
}

function transferStatus(status: VehicleTransferRow["status"]): string {
  return status === "in_transit" ? "در مسیر" : status === "completed" ? "تحویل‌شده" : "لغوشده";
}

export function VehicleDetailDialog({
  serialId,
  activeLocationId,
  locations,
  canSeeCost,
  canEditVehicle,
  canEditPrice,
  canOverrideMinPrice,
  canTransferVehicle,
  canArchiveVehicle,
  canViewMedia,
  canManageMedia,
  onClose,
  onChanged,
}: {
  serialId: string;
  activeLocationId: string | null;
  locations: LocationOption[];
  canSeeCost: boolean;
  canEditVehicle: boolean;
  canEditPrice: boolean;
  canOverrideMinPrice: boolean;
  canTransferVehicle: boolean;
  canArchiveVehicle: boolean;
  canViewMedia: boolean;
  canManageMedia: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [vehicle, setVehicle] = useState<VehicleDetailDto | null>(null);
  const [priceHistory, setPriceHistory] = useState<VehiclePriceHistoryEntry[]>([]);
  const [canSeePriceHistory, setCanSeePriceHistory] = useState(false);
  const [transfers, setTransfers] = useState<VehicleTransferRow[]>([]);
  const [attachments, setAttachments] = useState<VehicleMediaAttachment[]>([]);
  const [editForm, setEditForm] = useState<EditForm>(EMPTY_EDIT_FORM);
  const [priceForm, setPriceForm] = useState<PriceForm>({
    askingPriceRial: "", minimumPriceRial: "", wholesalePriceRial: "", promotionalPriceRial: "", reason: "",
  });
  const [selectedTab, setSelectedTab] = useState<"details" | "pricing" | "transfers" | "files" | "costs">("details");
  const [loading, setLoading] = useState(true);
  const [mediaLoading, setMediaLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mediaError, setMediaError] = useState("");
  const [notice, setNotice] = useState("");
  const [transferTo, setTransferTo] = useState("");
  const [transferNote, setTransferNote] = useState("");
  const [transferReasons, setTransferReasons] = useState<Record<string, string>>({});
  const [relistReason, setRelistReason] = useState("");
  const [archiveReason, setArchiveReason] = useState("");
  const [mediaKind, setMediaKind] = useState<MediaKind>("image");
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  const [pickedMedia, setPickedMedia] = useState<PickedMedia | null>(null);
  const [mediaTitle, setMediaTitle] = useState("");
  const [mediaCategory, setMediaCategory] = useState<VehicleMediaCategory>("photo");
  const [mediaDescription, setMediaDescription] = useState("");
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setMediaLoading(true);
    setError("");
    const detailRequest = api<VehicleDetailResponseDto>(`/api/automotive/vehicles/${serialId}`, { signal: controller.signal }).then((detailResult) => {
      if (controller.signal.aborted || detailResult.aborted) return;
      if (detailResult.ok && detailResult.data.vehicle) {
        const next = detailResult.data.vehicle;
        setVehicle(next);
        setEditForm(editFormFor(next));
        setPriceForm(priceFormFor(next));
        setPriceHistory(detailResult.data.priceHistory ?? []);
        setCanSeePriceHistory(detailResult.data.canSeePriceHistory === true);
        setTransfers(detailResult.data.transfers ?? []);
      } else {
        setError(errorMessage(detailResult.data.error) || detailResult.data.message || detailResult.data.error || "پروندهٔ خودرو بارگیری نشد.");
      }
      setLoading(false);
    });
    const mediaRequest = api<VehicleMediaResponseDto>(`/api/automotive/vehicles/${serialId}/media`, { signal: controller.signal }).then((mediaResult) => {
      if (controller.signal.aborted || mediaResult.aborted) return;
      if (mediaResult.ok) {
        setAttachments(mediaResult.data.attachments ?? []);
        setMediaError("");
      } else {
        setMediaError(errorMessage(mediaResult.data.error) || mediaResult.data.message || mediaResult.data.error || "رسانه‌ها و مدارک خودرو بارگیری نشدند.");
      }
      setMediaLoading(false);
    });
    await Promise.all([detailRequest, mediaRequest]);
  }, [serialId]);

  useEffect(() => {
    void load();
    return () => requestRef.current?.abort();
  }, [load]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !mediaPickerOpen) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mediaPickerOpen, onClose]);

  const canActInVehicleBranch = Boolean(vehicle && activeLocationId && vehicle.locationId === activeLocationId);
  const canEditHere = canEditVehicle && canActInVehicleBranch && vehicle?.state !== "sold";
  const canPriceHere = canEditPrice && canActInVehicleBranch && vehicle?.state !== "sold" && vehicle?.state !== "archived";
  const canArchiveHere = Boolean(vehicle && canArchiveVehicle && canActInVehicleBranch && vehicle.state !== "sold" && vehicle.state !== "archived");
  const branchName = vehicle ? locations.find((location) => location.id === vehicle.locationId)?.name : null;

  async function saveDetails() {
    if (!vehicle || !canEditHere) return;
    const mileage = parseWholeNumber(editForm.mileageKm, "کارکرد", true);
    const priorOwners = parseWholeNumber(editForm.priorOwners, "تعداد مالک قبلی", true);
    const invalid = mileage.error || priorOwners.error;
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const result = await api<{ vehicle?: VehicleDetailDto; error?: string; message?: string }>(
      `/api/automotive/vehicles/${serialId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          vin: editForm.vin || null,
          chassisNumber: editForm.chassisNumber || null,
          engineNumber: editForm.engineNumber || null,
          plateNumber: editForm.plateNumber || null,
          mileageKm: mileage.value,
          priorOwners: priorOwners.value,
          registrationDate: editForm.registrationDate || null,
          bodyType: editForm.bodyType || null,
          transmission: editForm.transmission || null,
          fuelType: editForm.fuelType || null,
          drivetrain: editForm.drivetrain || null,
          engineSpec: editForm.engineSpec || null,
          exteriorColor: editForm.exteriorColor || null,
          interiorColor: editForm.interiorColor || null,
          inspectionNotes: editForm.inspectionNotes || null,
          bodyConditionNotes: editForm.bodyConditionNotes || null,
          mechanicalNotes: editForm.mechanicalNotes || null,
          serviceHistory: editForm.serviceHistory || null,
        }),
      },
    );
    setBusy(false);
    if (!result.ok || !result.data.vehicle) {
      setError(errorMessage(result.data.error) || result.data.message || result.data.error || "ذخیرهٔ مشخصات خودرو ناموفق بود.");
      return;
    }
    setNotice("مشخصات خودرو ذخیره شد.");
    onChanged();
    await load();
  }

  async function savePrice() {
    if (!vehicle || !canPriceHere) return;
    const asking = parseWholeNumber(priceForm.askingPriceRial, "قیمت فروش", false);
    const minimum = parseWholeNumber(priceForm.minimumPriceRial, "حداقل قیمت", true);
    const wholesale = canSeeCost ? parseWholeNumber(priceForm.wholesalePriceRial, "قیمت عمده", true) : { value: null, error: null };
    const promotional = canSeeCost ? parseWholeNumber(priceForm.promotionalPriceRial, "قیمت تبلیغاتی", true) : { value: null, error: null };
    const invalid = asking.error || (canOverrideMinPrice ? minimum.error : null) || wholesale.error || promotional.error;
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const body: Record<string, number | null | string> = {
      askingPriceRial: asking.value,
      reason: priceForm.reason.trim() || "",
    };
    if (canSeeCost) {
      body.wholesalePriceRial = wholesale.value;
      body.promotionalPriceRial = promotional.value;
    }
    if (canOverrideMinPrice && (canSeeCost || priceForm.minimumPriceRial.trim() !== "")) {
      body.minimumPriceRial = minimum.value;
    }
    const result = await api<{ priceHistory?: VehiclePriceHistoryEntry[]; error?: string; message?: string }>(
      `/api/automotive/vehicles/${serialId}/price`,
      { method: "POST", body: JSON.stringify(body) },
    );
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result.data.error) || result.data.message || result.data.error || "ذخیرهٔ قیمت ناموفق بود.");
      return;
    }
    setNotice("قیمت‌ها و سابقهٔ تغییرات ذخیره شدند.");
    onChanged();
    await load();
  }

  async function startTransfer() {
    if (!vehicle || !canTransferVehicle || !canActInVehicleBranch || !transferTo) return;
    setBusy(true);
    setError("");
    setNotice("");
    const result = await api<{ transferId?: string; error?: string; message?: string }>(
      `/api/automotive/vehicles/${serialId}/transfers`,
      { method: "POST", body: JSON.stringify({ toLocationId: transferTo, note: transferNote.trim() || null }) },
    );
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result.data.error) || result.data.message || result.data.error || "ثبت انتقال ناموفق بود.");
      return;
    }
    setTransferTo("");
    setTransferNote("");
    setNotice("انتقال خودرو ثبت شد؛ خودرو تا زمان تأیید شعبهٔ مقصد از موجودی قابل فروش خارج است.");
    onChanged();
    await load();
  }

  async function closeTransfer(transfer: VehicleTransferRow, action: "complete" | "cancel") {
    const reason = (transferReasons[transfer.id] ?? "").trim();
    if (action === "cancel" && !reason) return;
    setBusy(true);
    setError("");
    setNotice("");
    const result = await api<{ error?: string; message?: string }>(`/api/automotive/transfers/${transfer.id}`, {
      method: "PATCH",
      body: JSON.stringify({ action, ...(action === "cancel" ? { reason } : {}) }),
    });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result.data.error) || result.data.message || result.data.error || "به‌روزرسانی انتقال ناموفق بود.");
      return;
    }
    setTransferReasons((reasons) => ({ ...reasons, [transfer.id]: "" }));
    setNotice(action === "complete" ? "تحویل خودرو ثبت شد." : "انتقال با ذکر دلیل لغو شد.");
    onChanged();
    await load();
  }

  async function relistReturned() {
    if (!vehicle || !canEditHere || !relistReason.trim()) return;
    setBusy(true);
    setError("");
    setNotice("");
    const result = await api<{ error?: string; message?: string }>(`/api/automotive/vehicles/${serialId}/relist`, {
      method: "POST",
      body: JSON.stringify({ reason: relistReason.trim() }),
    });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result.data.error) || result.data.message || result.data.error || "بازگرداندن خودرو به موجودی ناموفق بود.");
      return;
    }
    setRelistReason("");
    setNotice("بازرسی ثبت شد و خودرو دوباره قابل فروش است.");
    onChanged();
    await load();
  }

  async function archiveVehicle() {
    if (!vehicle || !canArchiveVehicle || !canActInVehicleBranch || !archiveReason.trim()) return;
    setBusy(true);
    setError("");
    setNotice("");
    const result = await api<{ error?: string; message?: string }>(`/api/automotive/vehicles/${serialId}/state`, {
      method: "POST",
      body: JSON.stringify({ action: "archive", reason: archiveReason.trim() }),
    });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result.data.error) || result.data.message || result.data.error || "بایگانی خودرو ناموفق بود.");
      return;
    }
    setArchiveReason("");
    setNotice("خودرو بایگانی شد.");
    onChanged();
    await load();
  }

  async function attachMedia() {
    if (!pickedMedia || !vehicle || !canEditHere || !canViewMedia) return;
    const title = mediaTitle.trim() || pickedMedia.fileName;
    setBusy(true);
    setError("");
    setNotice("");
    const result = await api<{ attachment?: VehicleMediaAttachment; error?: string; message?: string }>(
      `/api/automotive/vehicles/${serialId}/media`,
      {
        method: "POST",
        body: JSON.stringify({
          mediaAssetId: pickedMedia.id,
          category: mediaCategory,
          title,
          description: mediaDescription.trim() || null,
        }),
      },
    );
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result.data.error) || result.data.message || result.data.error || "پیوست فایل به خودرو ناموفق بود.");
      return;
    }
    setPickedMedia(null);
    setMediaTitle("");
    setMediaDescription("");
    setNotice("فایل به پروندهٔ خودرو پیوست شد؛ فایل اصلی در کتابخانهٔ رسانه باقی می‌ماند.");
    onChanged();
    await load();
  }

  async function detachMedia(attachment: VehicleMediaAttachment) {
    if (!canEditHere || !canViewMedia) return;
    setBusy(true);
    setError("");
    setNotice("");
    const params = new URLSearchParams({ mediaAssetId: attachment.mediaAssetId });
    const result = await api<{ error?: string; message?: string }>(
      `/api/automotive/vehicles/${serialId}/media?${params.toString()}`,
      { method: "DELETE" },
    );
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result.data.error) || result.data.message || result.data.error || "جداکردن فایل ناموفق بود.");
      return;
    }
    setNotice("فایل از این خودرو جدا شد؛ از کتابخانهٔ رسانه حذف نشد.");
    onChanged();
    await load();
  }

  const vehicleCanTransfer = canTransferVehicle && canActInVehicleBranch && vehicle?.state !== "sold" && vehicle?.state !== "archived";
  const currentLocation = vehicle ? locations.find((location) => location.id === vehicle.locationId) : null;

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-foreground/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="automotive-vehicle-dialog-title">
      <div className={`${overlayPanelClass} max-h-[95vh] w-full max-w-6xl overflow-y-auto rounded-t-2xl p-4 sm:rounded-2xl sm:p-6`}>
        <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
          <div className="min-w-0">
            <h2 id="automotive-vehicle-dialog-title" className="text-lg font-semibold">پروندهٔ خودرو</h2>
            {vehicle ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {vehicle.displayName} · <span dir="ltr" className="font-mono">{vehicle.stockNumber}</span>
              </p>
            ) : null}
          </div>
          <SecondaryButton type="button" onClick={onClose}>بستن</SecondaryButton>
        </header>

        {error ? <ErrorBox>{error}</ErrorBox> : null}
        {notice ? <p role="status" aria-live="polite" className="mb-4 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm">{notice}</p> : null}
        {vehicle && !canActInVehicleBranch ? (
          <p role="status" className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
            این خودرو در شعبهٔ «{currentLocation?.name ?? branchName ?? "دیگر"}» است. برای تغییر قیمت، اطلاعات یا وضعیت، همان شعبه را فعال کنید.
          </p>
        ) : null}

        {loading && !vehicle ? (
          <SectionCardSkeleton />
        ) : !vehicle ? (
          <EmptyState title="پرونده بارگیری نشد">اطلاعات خودرو در دسترس نیست.</EmptyState>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <StatusBadge tone={statusTone(vehicle.state)}>{VEHICLE_STATE_LABELS[vehicle.state]}</StatusBadge>
              <span className="text-xs text-muted-foreground">شعبه: {currentLocation?.name ?? "—"}</span>
              <span className="text-xs text-muted-foreground">ثبت/خرید: {displayDate(vehicle.acquisitionDate)}</span>
              {vehicle.soldOn ? <span className="text-xs text-muted-foreground">فروش: {displayDate(vehicle.soldOn)}</span> : null}
            </div>

            <div role="tablist" aria-label="بخش‌های پروندهٔ خودرو" className="mb-4 flex flex-wrap gap-2 border-b border-border pb-3">
              {([
                ["details", "مشخصات و ویرایش"],
                ["pricing", "قیمت و تاریخچه"],
                ["transfers", "انتقال شعبه"],
                ["files", "رسانه و مدارک"],
                ...(canSeeCost ? [["costs", "بهای تمام‌شده"]] : []),
              ] as [typeof selectedTab, string][]).map(([tab, label]) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  id={`vehicle-tab-${tab}`}
                  aria-selected={selectedTab === tab}
                  aria-controls="vehicle-detail-tabpanel"
                  onClick={() => setSelectedTab(tab)}
                  className={`rounded-lg px-3 py-2 text-sm transition-colors ${selectedTab === tab ? "bg-primary text-primary-foreground" : "border border-border hover:bg-muted"}`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div role="tabpanel" id="vehicle-detail-tabpanel" aria-labelledby={`vehicle-tab-${selectedTab}`}>
              {selectedTab === "details" ? (
                <div className="space-y-4">
                  <SectionCard title="مشخصات خودرو" description="هویت، وضعیت و اطلاعات فنی">
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <Field label="شماره انبار"><input className={inputClass} value={vehicle.stockNumber} readOnly dir="ltr" /></Field>
                      <Field label="برند"><input className={inputClass} value={vehicle.make} readOnly /></Field>
                      <Field label="مدل"><input className={inputClass} value={vehicle.model} readOnly /></Field>
                      <Field label="تیپ"><input className={inputClass} value={vehicle.trim ?? "—"} readOnly /></Field>
                      <Field label="سال مدل"><input className={inputClass} value={vehicle.modelYear == null ? "—" : `${vehicle.modelYear} (${vehicle.vehicleYearCalendar === "jalali" ? "شمسی" : "میلادی"})`} readOnly /></Field>
                      <Field label="سال تولید"><input className={inputClass} value={vehicle.productionYear == null ? "—" : String(vehicle.productionYear)} readOnly /></Field>
                      <Field label="شرط"><input className={inputClass} value={vehicle.condition === "new" ? "نو" : "کارکرده"} readOnly /></Field>
                      <Field label="قیمت فروش (ریال)"><input className={inputClass} value={money(vehicle.askingPriceRial)} readOnly dir="ltr" /></Field>
                      <Field label="VIN"><input className={inputClass} value={editForm.vin} onChange={(event) => setEditForm((form) => ({ ...form, vin: event.target.value }))} disabled={!canEditHere || busy} dir="ltr" /></Field>
                      <Field label="شماره شاسی"><input className={inputClass} value={editForm.chassisNumber} onChange={(event) => setEditForm((form) => ({ ...form, chassisNumber: event.target.value }))} disabled={!canEditHere || busy} dir="ltr" /></Field>
                      <Field label="شماره موتور"><input className={inputClass} value={editForm.engineNumber} onChange={(event) => setEditForm((form) => ({ ...form, engineNumber: event.target.value }))} disabled={!canEditHere || busy} dir="ltr" /></Field>
                      <Field label="پلاک"><input className={inputClass} value={editForm.plateNumber} onChange={(event) => setEditForm((form) => ({ ...form, plateNumber: event.target.value }))} disabled={!canEditHere || busy} /></Field>
                      <Field label="کارکرد (کیلومتر)"><PersianNumberInput className={inputClass} inputMode="numeric" value={editForm.mileageKm} onChange={(event) => setEditForm((form) => ({ ...form, mileageKm: event.target.value }))} disabled={!canEditHere || busy || vehicle.condition === "new"} /></Field>
                      <Field label="تعداد مالک قبلی"><PersianNumberInput className={inputClass} inputMode="numeric" value={editForm.priorOwners} onChange={(event) => setEditForm((form) => ({ ...form, priorOwners: event.target.value }))} disabled={!canEditHere || busy || vehicle.condition === "new"} /></Field>
                      <Field as="div" label="تاریخ ثبت"><JalaliDatePicker value={editForm.registrationDate} onChange={(value) => setEditForm((form) => ({ ...form, registrationDate: value }))} ariaLabel="تاریخ ثبت خودرو" disabled={!canEditHere || busy} /></Field>
                      <Field label="نوع بدنه">
                        <select className={inputClass} value={editForm.bodyType} onChange={(event) => setEditForm((form) => ({ ...form, bodyType: event.target.value }))} disabled={!canEditHere || busy}>
                          <option value="">— نامشخص —</option>{VEHICLE_BODY_TYPES.map((value) => <option key={value} value={value}>{VEHICLE_BODY_TYPE_LABELS[value]}</option>)}
                        </select>
                      </Field>
                      <Field label="گیربکس">
                        <select className={inputClass} value={editForm.transmission} onChange={(event) => setEditForm((form) => ({ ...form, transmission: event.target.value }))} disabled={!canEditHere || busy}>
                          <option value="">— نامشخص —</option>{VEHICLE_TRANSMISSIONS.map((value) => <option key={value} value={value}>{VEHICLE_TRANSMISSION_LABELS[value]}</option>)}
                        </select>
                      </Field>
                      <Field label="نوع سوخت">
                        <select className={inputClass} value={editForm.fuelType} onChange={(event) => setEditForm((form) => ({ ...form, fuelType: event.target.value }))} disabled={!canEditHere || busy}>
                          <option value="">— نامشخص —</option>{VEHICLE_FUEL_TYPES.map((value) => <option key={value} value={value}>{VEHICLE_FUEL_TYPE_LABELS[value]}</option>)}
                        </select>
                      </Field>
                      <Field label="محور محرک">
                        <select className={inputClass} value={editForm.drivetrain} onChange={(event) => setEditForm((form) => ({ ...form, drivetrain: event.target.value }))} disabled={!canEditHere || busy}>
                          <option value="">— نامشخص —</option>{VEHICLE_DRIVETRAINS.map((value) => <option key={value} value={value}>{VEHICLE_DRIVETRAIN_LABELS[value]}</option>)}
                        </select>
                      </Field>
                      <Field label="مشخصات موتور"><input className={inputClass} value={editForm.engineSpec} onChange={(event) => setEditForm((form) => ({ ...form, engineSpec: event.target.value }))} disabled={!canEditHere || busy} /></Field>
                      <Field label="رنگ بدنه"><input className={inputClass} value={editForm.exteriorColor} onChange={(event) => setEditForm((form) => ({ ...form, exteriorColor: event.target.value }))} disabled={!canEditHere || busy} /></Field>
                      <Field label="رنگ کابین"><input className={inputClass} value={editForm.interiorColor} onChange={(event) => setEditForm((form) => ({ ...form, interiorColor: event.target.value }))} disabled={!canEditHere || busy} /></Field>
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <Field label="یادداشت بازرسی"><textarea className={inputClass} rows={3} value={editForm.inspectionNotes} onChange={(event) => setEditForm((form) => ({ ...form, inspectionNotes: event.target.value }))} disabled={!canEditHere || busy} /></Field>
                      <Field label="وضعیت بدنه"><textarea className={inputClass} rows={3} value={editForm.bodyConditionNotes} onChange={(event) => setEditForm((form) => ({ ...form, bodyConditionNotes: event.target.value }))} disabled={!canEditHere || busy} /></Field>
                      <Field label="وضعیت فنی"><textarea className={inputClass} rows={3} value={editForm.mechanicalNotes} onChange={(event) => setEditForm((form) => ({ ...form, mechanicalNotes: event.target.value }))} disabled={!canEditHere || busy} /></Field>
                      <Field label="سابقهٔ سرویس"><textarea className={inputClass} rows={3} value={editForm.serviceHistory} onChange={(event) => setEditForm((form) => ({ ...form, serviceHistory: event.target.value }))} disabled={!canEditHere || busy} /></Field>
                    </div>
                    {canEditHere ? <div className="mt-4"><PrimaryButton type="button" onClick={saveDetails} disabled={busy}>{busy ? "در حال ذخیره…" : "ذخیرهٔ مشخصات"}</PrimaryButton></div> : null}
                  </SectionCard>
                  {(canEditVehicle && canActInVehicleBranch && vehicle.state === "returned") || canArchiveHere ? (
                    <SectionCard title="گردش وضعیت" description="هر تغییر از فرمان عملیاتی خودش انجام می‌شود">
                      {canEditVehicle && canActInVehicleBranch && vehicle.state === "returned" ? (
                        <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_auto]">
                          <Field label="دلیل بازرسی برای بازگشت به موجودی"><input className={inputClass} value={relistReason} onChange={(event) => setRelistReason(event.target.value)} /></Field>
                          <div className="self-end"><SecondaryButton onClick={relistReturned} disabled={busy || !relistReason.trim()}>بازگرداندن به موجودی</SecondaryButton></div>
                        </div>
                      ) : null}
                      {canArchiveHere ? (
                        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                          <Field label="دلیل بایگانی"><input className={inputClass} value={archiveReason} onChange={(event) => setArchiveReason(event.target.value)} /></Field>
                          <div className="self-end"><SecondaryButton onClick={archiveVehicle} disabled={busy || !archiveReason.trim()}>بایگانی خودرو</SecondaryButton></div>
                        </div>
                      ) : null}
                    </SectionCard>
                  ) : null}
                </div>
              ) : null}

              {selectedTab === "pricing" ? (
                <div className="space-y-4">
                  <SectionCard title="قیمت‌گذاری" description="تغییرات قیمت مستقل از بهای خرید ثبت می‌شوند">
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <Field label="قیمت فروش (ریال)"><PersianNumberInput className={inputClass} inputMode="numeric" value={priceForm.askingPriceRial} onChange={(event) => setPriceForm((form) => ({ ...form, askingPriceRial: event.target.value }))} disabled={!canPriceHere || busy} /></Field>
                      {canOverrideMinPrice ? <Field label="حداقل قیمت (ریال)"><PersianNumberInput className={inputClass} inputMode="numeric" value={priceForm.minimumPriceRial} onChange={(event) => setPriceForm((form) => ({ ...form, minimumPriceRial: event.target.value }))} disabled={!canPriceHere || busy} /></Field> : null}
                      {canSeeCost ? <Field label="قیمت عمده (ریال)"><PersianNumberInput className={inputClass} inputMode="numeric" value={priceForm.wholesalePriceRial} onChange={(event) => setPriceForm((form) => ({ ...form, wholesalePriceRial: event.target.value }))} disabled={!canPriceHere || busy} /></Field> : null}
                      {canSeeCost ? <Field label="قیمت تبلیغاتی (ریال)"><PersianNumberInput className={inputClass} inputMode="numeric" value={priceForm.promotionalPriceRial} onChange={(event) => setPriceForm((form) => ({ ...form, promotionalPriceRial: event.target.value }))} disabled={!canPriceHere || busy} /></Field> : null}
                      <Field label="دلیل تغییر"><input className={inputClass} value={priceForm.reason} onChange={(event) => setPriceForm((form) => ({ ...form, reason: event.target.value }))} disabled={!canPriceHere || busy} /></Field>
                    </div>
                    {canPriceHere ? <div className="mt-4"><PrimaryButton type="button" onClick={savePrice} disabled={busy}>{busy ? "در حال ذخیره…" : "ثبت قیمت و تاریخچه"}</PrimaryButton></div> : null}
                    {!canSeePriceHistory ? <p className="mt-3 text-sm text-muted-foreground">برای دیدن ریز تاریخچهٔ قیمت، دسترسی قیمت‌گذاری یا مشاهدهٔ بهای تمام‌شده لازم است.</p> : null}
                  </SectionCard>
                  {canSeePriceHistory ? (
                    <SectionCard title="تاریخچهٔ کامل قیمت" description="قیمت قبلی و جدید هر تغییر، همراه با عامل و دلیل">
                      {priceHistory.length === 0 ? <EmptyState title="تغییری ثبت نشده">با ثبت اولین تغییر، سابقهٔ قیمت این خودرو در همین‌جا می‌ماند.</EmptyState> : (
                        <DataTable caption="تاریخچهٔ قیمت خودرو">
                          <DataTableHead><Th>زمان</Th><Th>قیمت فروش</Th>{canSeeCost ? <Th>حداقل قیمت</Th> : null}{canSeeCost ? <Th>عمده</Th> : null}{canSeeCost ? <Th>تبلیغاتی</Th> : null}<Th>تغییردهنده</Th><Th>دلیل</Th></DataTableHead>
                          <DataTableBody>{priceHistory.map((entry) => (
                            <DataTableRow key={entry.id}>
                              <Td>{displayDate(entry.changedAt)}</Td>
                              <Td>{money(entry.previousAskingPriceRial)} ← {money(entry.askingPriceRial)}</Td>
                              {canSeeCost ? <Td>{money(entry.previousMinimumPriceRial)} ← {money(entry.minimumPriceRial)}</Td> : null}
                              {canSeeCost ? <Td>{money(entry.previousWholesalePriceRial)} ← {money(entry.wholesalePriceRial)}</Td> : null}
                              {canSeeCost ? <Td>{money(entry.previousPromotionalPriceRial)} ← {money(entry.promotionalPriceRial)}</Td> : null}
                              <Td>{entry.changedByName ?? "—"}</Td>
                              <Td>{entry.reason ?? "—"}</Td>
                            </DataTableRow>
                          ))}</DataTableBody>
                        </DataTable>
                      )}
                    </SectionCard>
                  ) : null}
                </div>
              ) : null}

              {selectedTab === "transfers" ? (
                <div className="space-y-4">
                  {vehicleCanTransfer ? (
                    <SectionCard title="ارسال به شعبهٔ دیگر" description="شعبهٔ مبدأ از محل فعال و مقصد از شعب مجاز گرفته می‌شود">
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        <Field label="شعبهٔ مقصد">
                          <select className={inputClass} value={transferTo} onChange={(event) => setTransferTo(event.target.value)} disabled={busy}>
                            <option value="">— انتخاب مقصد —</option>{locations.filter((location) => location.id !== vehicle.locationId).map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                          </select>
                        </Field>
                        <Field label="یادداشت انتقال"><input className={inputClass} value={transferNote} onChange={(event) => setTransferNote(event.target.value)} disabled={busy} /></Field>
                        <div className="self-end"><PrimaryButton type="button" onClick={startTransfer} disabled={busy || !transferTo}>{busy ? "در حال ثبت…" : "ثبت انتقال"}</PrimaryButton></div>
                      </div>
                    </SectionCard>
                  ) : canTransferVehicle && vehicle.state === "reserved" ? (
                    <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">این خودرو رزرو فعال دارد؛ ابتدا رزرو را از بخش «رزروها» با دلیل روشن آزاد کنید.</p>
                  ) : null}
                  <SectionCard title="تاریخچهٔ انتقال‌ها" description="ارسال، دریافت یا لغو هر خودرو">
                    {transfers.length === 0 ? <EmptyState title="انتقالی ثبت نشده">سوابق انتقال شعبه‌ای این خودرو این‌جا نمایش داده می‌شود.</EmptyState> : (
                      <DataTable caption="تاریخچهٔ انتقال خودرو">
                        <DataTableHead><Th>زمان ارسال</Th><Th>مبدأ</Th><Th>مقصد</Th><Th>وضعیت</Th><Th>یادداشت</Th><Th>اقدام</Th></DataTableHead>
                        <DataTableBody>{transfers.map((transfer) => {
                          const canReceive = canTransferVehicle && activeLocationId === transfer.toLocationId && transfer.status === "in_transit";
                          const canCancel = canTransferVehicle && activeLocationId === transfer.fromLocationId && transfer.status === "in_transit";
                          return (
                            <DataTableRow key={transfer.id}>
                              <Td>{displayDate(transfer.startedAt)}</Td>
                              <Td>{transfer.fromLocationName ?? "—"}</Td>
                              <Td>{transfer.toLocationName ?? "—"}</Td>
                              <Td><StatusBadge tone={transfer.status === "in_transit" ? "active" : transfer.status === "completed" ? "positive" : "neutral"}>{transferStatus(transfer.status)}</StatusBadge></Td>
                              <Td>{transfer.note ?? transfer.cancelReason ?? "—"}</Td>
                              <Td>
                                {canReceive ? <SecondaryButton onClick={() => closeTransfer(transfer, "complete")} disabled={busy}>تأیید دریافت</SecondaryButton> : null}
                                {canCancel ? <div className="min-w-48 space-y-2"><input className={inputClass} aria-label="دلیل لغو انتقال" value={transferReasons[transfer.id] ?? ""} onChange={(event) => setTransferReasons((reasons) => ({ ...reasons, [transfer.id]: event.target.value }))} /><SecondaryButton onClick={() => closeTransfer(transfer, "cancel")} disabled={busy || !(transferReasons[transfer.id] ?? "").trim()}>لغو انتقال</SecondaryButton></div> : null}
                                {!canReceive && !canCancel ? "—" : null}
                              </Td>
                            </DataTableRow>
                          );
                        })}</DataTableBody>
                      </DataTable>
                    )}
                  </SectionCard>
                </div>
              ) : null}

              {selectedTab === "files" ? (
                <div className="space-y-4">
                  <SectionCard title="رسانه و مدارک" description="فایل در کتابخانهٔ مشترک می‌ماند؛ این خودرو فقط یک پیوند و برچسب نگه می‌دارد">
                    {mediaError ? <ErrorBox>{mediaError}</ErrorBox> : null}
                    {canViewMedia && canEditHere ? (
                      <div className="mb-5 rounded-xl border border-border p-3">
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                          <Field label="نوع فایل">
                            <select className={inputClass} value={mediaKind} onChange={(event) => { setMediaKind(event.target.value as MediaKind); setPickedMedia(null); setMediaTitle(""); }} disabled={busy}>
                              <option value="image">تصویر خودرو</option><option value="video">ویدئوی خودرو</option><option value="document">مدرک / سند</option>
                            </select>
                          </Field>
                          <Field label="دسته‌بندی">
                            <select className={inputClass} value={mediaCategory} onChange={(event) => setMediaCategory(event.target.value as VehicleMediaCategory)} disabled={busy}>
                              {VEHICLE_MEDIA_CATEGORIES.map((category) => <option key={category} value={category}>{VEHICLE_MEDIA_CATEGORY_LABELS[category]}</option>)}
                            </select>
                          </Field>
                          <Field label="عنوان"><input className={inputClass} value={mediaTitle} onChange={(event) => setMediaTitle(event.target.value)} disabled={busy} /></Field>
                        </div>
                        <div className="mt-3 grid gap-3 sm:grid-cols-[auto_1fr]">
                          <SecondaryButton onClick={() => setMediaPickerOpen(true)} disabled={busy}>{pickedMedia ? "تغییر فایل" : "انتخاب از کتابخانهٔ رسانه"}</SecondaryButton>
                          <Field label="توضیح"><input className={inputClass} value={mediaDescription} onChange={(event) => setMediaDescription(event.target.value)} disabled={busy} /></Field>
                        </div>
                        {pickedMedia ? <p className="mt-2 text-xs text-muted-foreground">انتخاب‌شده: {pickedMedia.fileName}</p> : null}
                        {canManageMedia ? <p className="mt-1 text-xs text-muted-foreground">در پنجرهٔ کتابخانه می‌توانید فایل تازه هم بارگذاری کنید؛ ذخیره‌سازی فقط در رسانهٔ مشترک انجام می‌شود.</p> : null}
                        <div className="mt-3"><PrimaryButton type="button" onClick={attachMedia} disabled={busy || !pickedMedia || !mediaTitle.trim()}>{busy ? "در حال پیوست…" : "پیوست به خودرو"}</PrimaryButton></div>
                      </div>
                    ) : null}
                    {mediaLoading && attachments.length === 0 ? <SectionCardSkeleton rows={2} label="در حال دریافت فایل‌های خودرو" /> : attachments.length === 0 ? <EmptyState title="فایلی پیوست نشده">عکس‌ها، ویدئوها و مدارک این خودرو در این فهرست دیده می‌شوند.</EmptyState> : (
                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {attachments.map((attachment) => (
                          <article key={attachment.id} className="overflow-hidden rounded-xl border border-border">
                            <div className="flex h-44 items-center justify-center overflow-hidden bg-muted">
                              {attachment.deletedAt ? <span className="p-4 text-center text-sm text-muted-foreground">این فایل در سطل زبالهٔ رسانه است؛ برای نمایش، ابتدا آن را بازیابی کنید.</span> : attachment.mediaKind === "image" ? <img src={mediaFileUrl(attachment.mediaAssetId)} alt={attachment.title} loading="lazy" className="size-full object-contain" /> : attachment.mediaKind === "video" ? <video src={mediaFileUrl(attachment.mediaAssetId)} controls preload="metadata" aria-label={attachment.title} className="size-full object-contain" /> : <a className="text-primary underline" href={mediaFileUrl(attachment.mediaAssetId)}>{attachment.fileName}</a>}
                            </div>
                            <div className="space-y-1 p-3">
                              <p className="font-medium">{attachment.title}</p>
                              <p className="text-xs text-muted-foreground">{VEHICLE_MEDIA_CATEGORY_LABELS[attachment.category]} · {attachment.fileName}</p>
                              {attachment.description ? <p className="text-xs text-muted-foreground">{attachment.description}</p> : null}
                              {canEditHere && canViewMedia ? <SecondaryButton onClick={() => detachMedia(attachment)} disabled={busy}>جداکردن از خودرو</SecondaryButton> : null}
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </SectionCard>
                  {!canViewMedia ? <p className="text-xs text-muted-foreground">مدارک دانلودی نیازمند دسترسی «مشاهدهٔ کتابخانهٔ رسانه» هستند؛ عکس‌های پیوست‌شده با دسترسی مشاهدهٔ خودرو نمایش داده می‌شوند.</p> : null}
                </div>
              ) : null}

              {selectedTab === "costs" && canSeeCost ? (
                <SectionCard title="بهای تمام‌شده و هزینه‌ها" description="هزینه‌ها در همان سرویس خودرو و با مجوز هزینه خوانده می‌شوند">
                  <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <Summary label="بهای خرید" value={`${money(vehicle.purchaseCostRial)} ریال`} />
                    <Summary label="بهای تمام‌شدهٔ مؤثر" value={`${money(vehicle.effectiveCostRial)} ریال`} />
                    <Summary label="هزینهٔ سرمایه‌ای" value={`${money(vehicle.capitalizedCostRial)} ریال`} />
                    <Summary label="هزینهٔ دوره‌ای" value={`${money(vehicle.periodExpenseRial)} ریال`} />
                  </div>
                  {(vehicle.costs ?? []).length === 0 ? <EmptyState title="هزینه‌ای ثبت نشده">هزینه‌های این خودرو از بخش «هزینهٔ خودرو» ثبت می‌شوند.</EmptyState> : (
                    <DataTable caption="هزینه‌های خودرو">
                      <DataTableHead><Th>تاریخ</Th><Th>دسته</Th><Th>ثبت حسابداری</Th><Th>مبلغ</Th><Th>فروشنده</Th><Th>مرجع سند</Th><Th>وضعیت</Th></DataTableHead>
                      <DataTableBody>{vehicle.costs!.map((cost) => <DataTableRow key={cost.id}><Td>{displayDate(cost.incurredOn)}</Td><Td>{cost.category}</Td><Td>{cost.posting === "capitalized" ? "سرمایه‌ای" : "هزینهٔ دوره"}</Td><Td>{money(cost.amountRial)} ریال</Td><Td>{cost.vendorName ?? "—"}</Td><Td>{cost.documentRef ?? "—"}</Td><Td>{cost.status === "active" ? "فعال" : `باطل‌شده: ${cost.voidReason ?? "—"}`}</Td></DataTableRow>)}</DataTableBody>
                    </DataTable>
                  )}
                </SectionCard>
              ) : null}
            </div>
          </>
        )}
      </div>
      {mediaPickerOpen ? (
        <MediaPickerDialog
          title={mediaKind === "image" ? "انتخاب تصویر خودرو" : mediaKind === "video" ? "انتخاب ویدئوی خودرو" : "انتخاب مدرک خودرو"}
          kind={mediaKind}
          canUpload={canManageMedia}
          onClose={() => setMediaPickerOpen(false)}
          onPick={(asset) => {
            setPickedMedia(asset);
            setMediaTitle((current) => current || asset.fileName);
            setMediaPickerOpen(false);
          }}
       />
      ) : null}
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 font-medium">{value}</p></div>;
}
