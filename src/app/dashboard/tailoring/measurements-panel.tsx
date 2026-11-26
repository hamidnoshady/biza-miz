"use client";

/**
 * GH #1567 Phase 6A — a customer's body measurements, as an authorised member
 * sees them.
 *
 * Privacy is the design, not a feature of it:
 *   - Nothing is fetched until the member states why they are opening the
 *     record. The purpose travels with the request and is written to the
 *     append-only access log server-side (`tailoring_measurement_access_log`).
 *   - The panel is only ever mounted for a member holding
 *     `tailoring.measurements` (the manager page decides that from the
 *     server-side permission set); a job manager without it never mounts
 *     this component, so no request for values is ever made on their behalf.
 *   - Values live in component state only — never in a URL, local storage or
 *     a console line — and are dropped when the panel unmounts or is locked.
 *   - The form is the allow-list (`TAILORING_MEASUREMENT_FIELDS`): numbers and
 *     a unit, no free text and no photos.
 *   - A new set is a new version; the previous one is superseded, never
 *     overwritten. Older values are reachable only through the data-subject
 *     export, which is logged as such.
 */
import { useCallback, useEffect, useState } from "react";
import { DownloadIcon, LockIcon, RulerIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import {
  TAILORING_MEASUREMENT_FIELDS,
  type TailoringMeasurementField,
  type TailoringUnit,
} from "@/lib/tailoring-workflow";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "../data-table";
import { FilterChip, FilterChipRow } from "../filters";
import { EmptyState, SectionCard, StatusBadge } from "../page-chrome";
import { api, ErrorBox, InfoBox } from "../ui";
import { tailoringErrorMessage } from "./tailoring-errors";

export interface MeasurementVersionMeta {
  id: string;
  version: number;
  unit: TailoringUnit;
  fieldCount: number;
  recordedAt: string;
  supersededAt: string | null;
  erasedAt: string | null;
}

interface CurrentMeasurements extends MeasurementVersionMeta {
  measurements: { unit: TailoringUnit; values: Partial<Record<TailoringMeasurementField, number>> } | null;
}

interface AccessLogEntry {
  id: string;
  actorName: string;
  action: "record" | "view" | "export" | "erase" | "purge";
  purpose: string | null;
  at: string;
}

export const UNIT_LABELS: Record<TailoringUnit, string> = { cm: "سانتی‌متر", in: "اینچ" };
const ACTION_LABELS: Record<AccessLogEntry["action"], string> = {
  record: "ثبت نسخه",
  view: "مشاهده",
  export: "خروجی",
  erase: "پاک‌سازی",
  purge: "حذف خودکار (نگهداری)",
};
/** Common reasons, offered as one tap; any 3–300 character reason is accepted. */
const PURPOSE_PRESETS = ["دوخت سفارش", "پرو", "اصلاح اندازه به درخواست مشتری"] as const;
const FIELD_KEYS = Object.keys(TAILORING_MEASUREMENT_FIELDS) as TailoringMeasurementField[];

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Parse one typed value: Persian or Latin digits, one decimal, positive. */
export function parseMeasurementInput(raw: string): number | null | "invalid" {
  const text = toLatinDigits(raw).replace("٫", ".").replace(/\s+/gu, "");
  if (!text) return null;
  if (!/^\d{1,3}(\.\d)?$/u.test(text)) return "invalid";
  const value = Number(text);
  return value > 0 ? value : "invalid";
}

export function MeasurementsPanel({
  partyId,
  customerName,
  canExport,
  canErase,
  onCurrentVersion,
}: {
  partyId: string;
  customerName: string;
  canExport: boolean;
  canErase: boolean;
  /** The current version id once opened or recorded — the job form attaches it. */
  onCurrentVersion?: (versionId: string | null) => void;
}) {
  const [purpose, setPurpose] = useState("");
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const [current, setCurrent] = useState<CurrentMeasurements | null>(null);
  const [versions, setVersions] = useState<MeasurementVersionMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(false);
  const [unit, setUnit] = useState<TailoringUnit>("cm");
  const [draft, setDraft] = useState<Partial<Record<TailoringMeasurementField, string>>>({});
  const [eraseReason, setEraseReason] = useState("");
  const [eraseConfirm, setEraseConfirm] = useState(false);
  const [log, setLog] = useState<AccessLogEntry[] | null>(null);

  // A different customer is a different record: lock and forget everything.
  useEffect(() => {
    setOpenedFor(null);
    setCurrent(null);
    setVersions([]);
    setEditing(false);
    setDraft({});
    setLog(null);
    setError("");
    setNotice("");
  }, [partyId]);

  const lock = useCallback(() => {
    setOpenedFor(null);
    setCurrent(null);
    setVersions([]);
    setEditing(false);
    setDraft({});
    setLog(null);
  }, []);

  const open = useCallback(async (reason: string) => {
    const text = reason.trim();
    if (text.length < 3) {
      setError(tailoringErrorMessage("tailoring_purpose_required"));
      return;
    }
    setBusy(true);
    setError("");
    const params = new URLSearchParams({ partyId, purpose: text });
    const res = await api<{ current: CurrentMeasurements | null; versions: MeasurementVersionMeta[]; error?: string }>(
      `/api/tailoring/measurements?${params.toString()}`,
      { cache: "no-store" },
    );
    setBusy(false);
    if (!res.ok) {
      setError(tailoringErrorMessage(res.data.error));
      return;
    }
    setOpenedFor(text);
    setCurrent(res.data.current);
    setVersions(res.data.versions);
    onCurrentVersion?.(res.data.current?.id ?? null);
  }, [partyId, onCurrentVersion]);

  function startEdit() {
    const values = current?.measurements?.values ?? {};
    setUnit(current?.measurements?.unit ?? "cm");
    setDraft(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, toPersianDigits(String(value))])));
    setEditing(true);
    setNotice("");
  }

  async function saveVersion() {
    const values: Partial<Record<TailoringMeasurementField, number>> = {};
    for (const key of FIELD_KEYS) {
      const parsed = parseMeasurementInput(draft[key] ?? "");
      if (parsed === "invalid") {
        setError(`مقدار «${TAILORING_MEASUREMENT_FIELDS[key]}» معتبر نیست؛ یک عدد مثبت با حداکثر یک رقم اعشار وارد کنید.`);
        return;
      }
      if (parsed !== null) values[key] = parsed;
    }
    if (Object.keys(values).length === 0) {
      setError("دست‌کم یک اندازه وارد کنید.");
      return;
    }
    setBusy(true);
    setError("");
    const res = await api<{ version?: MeasurementVersionMeta; error?: string }>("/api/tailoring/measurements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partyId, measurements: { unit, values } }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(tailoringErrorMessage(res.data.error));
      return;
    }
    setEditing(false);
    setDraft({});
    setNotice(`نسخهٔ ${toPersianDigits(String(res.data.version?.version ?? ""))} ثبت شد؛ نسخهٔ قبلی بازنویسی نشد و در تاریخچه می‌ماند.`);
    // Re-open under the same stated purpose so the screen shows what is stored.
    await open(openedFor ?? "ثبت نسخهٔ جدید");
  }

  async function exportAll() {
    setBusy(true);
    setError("");
    const res = await api<Record<string, unknown> & { error?: string }>(
      `/api/tailoring/measurements/export?partyId=${encodeURIComponent(partyId)}`,
      { cache: "no-store" },
    );
    setBusy(false);
    if (!res.ok) {
      setError(tailoringErrorMessage(res.data.error));
      return;
    }
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `measurements-${partyId}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice("خروجی همهٔ نسخه‌ها آماده شد و این دسترسی در گزارش ثبت شد.");
  }

  async function erase() {
    setBusy(true);
    setError("");
    const res = await api<{ erased?: number; error?: string }>("/api/tailoring/measurements/erase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partyId, reason: eraseReason.trim(), confirm: true }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(tailoringErrorMessage(res.data.error));
      return;
    }
    setEraseReason("");
    setEraseConfirm(false);
    lock();
    onCurrentVersion?.(null);
    setNotice(`مقادیر ${toPersianDigits(String(res.data.erased ?? 0))} نسخه پاک شد. ردیف نسخه‌ها و گزارش دسترسی برای حسابرسی باقی می‌ماند.`);
  }

  async function loadLog() {
    setBusy(true);
    const res = await api<{ entries?: AccessLogEntry[]; error?: string }>(
      `/api/tailoring/measurements/log?partyId=${encodeURIComponent(partyId)}`,
    );
    setBusy(false);
    if (!res.ok) {
      setError(tailoringErrorMessage(res.data.error));
      return;
    }
    setLog(res.data.entries ?? []);
  }

  const values = current?.measurements?.values ?? {};
  const shownUnit = current?.measurements?.unit ?? "cm";

  return (
    <SectionCard
      title="اندازه‌های بدن"
      description={`اندازه‌های ${customerName} رمزنگاری‌شده نگهداری می‌شوند و هر مشاهده با دلیل آن ثبت می‌شود.`}
      actions={openedFor ? (
        <Button type="button" variant="outline" size="sm" onClick={lock}>
          <LockIcon aria-hidden="true" />
          بستن اندازه‌ها
        </Button>
      ) : null}
    >
      <div className="space-y-4">
        <ErrorBox>{error}</ErrorBox>
        {notice ? <InfoBox>{notice}</InfoBox> : null}

        {!openedFor ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void open(purpose);
            }}
          >
            <p className="text-sm text-muted-foreground">
              پیش از نمایش، دلیل مشاهده را بنویسید. این دلیل همراه نام شما و زمان مشاهده در گزارش دسترسی می‌ماند.
            </p>
            <FilterChipRow label="دلیل‌های پرکاربرد">
              {PURPOSE_PRESETS.map((preset) => (
                <FilterChip key={preset} dense selected={purpose === preset} onClick={() => setPurpose(preset)}>
                  {preset}
                </FilterChip>
              ))}
            </FilterChipRow>
            <div className="space-y-1.5">
              <Label htmlFor={`tailoring-purpose-${partyId}`}>دلیل مشاهده</Label>
              <Input
                id={`tailoring-purpose-${partyId}`}
                value={purpose}
                maxLength={300}
                onChange={(event) => setPurpose(event.target.value)}
                placeholder="مثلاً: دوخت کت سفارش شمارهٔ ۱۲"
              />
            </div>
            <Button type="submit" disabled={busy || purpose.trim().length < 3}>
              <RulerIcon aria-hidden="true" />
              نمایش اندازه‌ها
            </Button>
          </form>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">دلیل این مشاهده: {openedFor}</p>
            {editing ? (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveVersion();
                }}
              >
                <FilterChipRow label="واحد اندازه">
                  {(Object.keys(UNIT_LABELS) as TailoringUnit[]).map((key) => (
                    <FilterChip key={key} dense selected={unit === key} onClick={() => setUnit(key)}>
                      {UNIT_LABELS[key]}
                    </FilterChip>
                  ))}
                </FilterChipRow>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {FIELD_KEYS.map((key) => (
                    <div key={key} className="space-y-1">
                      <Label htmlFor={`tailoring-${partyId}-${key}`}>
                        {TAILORING_MEASUREMENT_FIELDS[key]} ({UNIT_LABELS[unit]})
                      </Label>
                      <Input
                        id={`tailoring-${partyId}-${key}`}
                        inputMode="decimal"
                        autoComplete="off"
                        dir="ltr"
                        value={draft[key] ?? ""}
                        onChange={(event) => setDraft((prev) => ({ ...prev, [key]: event.target.value }))}
                      />
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={busy}>ثبت نسخهٔ جدید</Button>
                  <Button type="button" variant="outline" onClick={() => setEditing(false)} disabled={busy}>انصراف</Button>
                </div>
              </form>
            ) : current?.measurements ? (
              <DataTable caption={`اندازه‌های فعلی ${customerName}`}>
                <DataTableHead>
                  <Th>اندازه</Th>
                  <Th>مقدار</Th>
                </DataTableHead>
                <DataTableBody>
                  {FIELD_KEYS.filter((key) => values[key] !== undefined).map((key) => (
                    <DataTableRow key={key}>
                      <Td>{TAILORING_MEASUREMENT_FIELDS[key]}</Td>
                      <Td>{toPersianDigits(String(values[key]))} {UNIT_LABELS[shownUnit]}</Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            ) : (
              <EmptyState>برای این مشتری اندازهٔ فعالی ثبت نشده است.</EmptyState>
            )}
            {!editing ? (
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={startEdit} disabled={busy}>
                  {current?.measurements ? "ثبت نسخهٔ جدید بر پایهٔ همین اندازه‌ها" : "ثبت اندازه‌ها"}
                </Button>
                {canExport ? (
                  <Button type="button" variant="outline" onClick={() => void exportAll()} disabled={busy}>
                    <DownloadIcon aria-hidden="true" />
                    خروجی همهٔ نسخه‌ها
                  </Button>
                ) : null}
                <Button type="button" variant="outline" onClick={() => void loadLog()} disabled={busy}>
                  گزارش دسترسی
                </Button>
              </div>
            ) : null}

            {versions.length > 0 ? (
              <DataTable caption="تاریخچهٔ نسخه‌های اندازه">
                <DataTableHead>
                  <Th>نسخه</Th>
                  <Th>واحد</Th>
                  <Th>تعداد اندازه</Th>
                  <Th>ثبت</Th>
                  <Th>وضعیت</Th>
                </DataTableHead>
                <DataTableBody>
                  {versions.map((version) => (
                    <DataTableRow key={version.id}>
                      <Td>{toPersianDigits(String(version.version))}</Td>
                      <Td>{UNIT_LABELS[version.unit]}</Td>
                      <Td>{toPersianDigits(String(version.fieldCount))}</Td>
                      <Td>{formatDate(version.recordedAt)}</Td>
                      <Td>
                        {version.erasedAt ? (
                          <StatusBadge tone="danger">پاک شده</StatusBadge>
                        ) : version.supersededAt ? (
                          <StatusBadge tone="neutral">نسخهٔ قبلی</StatusBadge>
                        ) : (
                          <StatusBadge tone="positive">فعلی</StatusBadge>
                        )}
                      </Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            ) : null}
          </div>
        )}

        {log ? (
          log.length === 0 ? (
            <EmptyState>هنوز دسترسی‌ای ثبت نشده است.</EmptyState>
          ) : (
            <DataTable caption="گزارش دسترسی به اندازه‌ها">
              <DataTableHead>
                <Th>زمان</Th>
                <Th>کاربر</Th>
                <Th>عمل</Th>
                <Th>دلیل</Th>
              </DataTableHead>
              <DataTableBody>
                {log.map((entry) => (
                  <DataTableRow key={entry.id}>
                    <Td>{formatDate(entry.at)}</Td>
                    <Td>{entry.actorName}</Td>
                    <Td>{ACTION_LABELS[entry.action] ?? entry.action}</Td>
                    <Td>{entry.purpose ?? "—"}</Td>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          )
        ) : null}

        {canErase ? (
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">پاک‌سازی اندازه‌ها به درخواست مشتری</summary>
            <div className="mt-3 space-y-3">
              <p className="text-sm text-muted-foreground">
                مقادیر همهٔ نسخه‌ها پاک می‌شود و برنمی‌گردد. شمارهٔ نسخه‌ها، تاریخ‌ها و گزارش دسترسی برای حسابرسی می‌ماند.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor={`tailoring-erase-${partyId}`}>دلیل پاک‌سازی</Label>
                <Textarea
                  id={`tailoring-erase-${partyId}`}
                  value={eraseReason}
                  maxLength={500}
                  onChange={(event) => setEraseReason(event.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`tailoring-erase-confirm-${partyId}`}
                  checked={eraseConfirm}
                  onCheckedChange={(checked) => setEraseConfirm(checked === true)}
                />
                <Label htmlFor={`tailoring-erase-confirm-${partyId}`}>می‌دانم که این کار برگشت‌پذیر نیست.</Label>
              </div>
              <Button
                type="button"
                variant="destructive"
                disabled={busy || !eraseConfirm || eraseReason.trim().length < 3}
                onClick={() => void erase()}
              >
                پاک‌سازی اندازه‌ها
              </Button>
            </div>
          </details>
        ) : null}
      </div>
    </SectionCard>
  );
}
