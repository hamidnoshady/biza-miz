"use client";

/**
 * Shared pieces of the «ورود و خروج داده» screen.
 *
 * The three sections below (import, export, history) all need the same entity
 * catalogue, the same Persian error vocabulary and the same couple of small
 * display cells, so they live here rather than being copied three times.
 *
 * Everything composes the platform's own primitives — `Field`, `inputClass`,
 * `StatusBadge`, `JalaliDatePicker` — and states no card skin or page shell of
 * its own. This screen must look like the rest of the product, not like a
 * module that arrived from somewhere else.
 */

import { useCallback, useEffect, useState } from "react";
import { LoadingSkeleton, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { Field, api, inputClass } from "@/app/dashboard/ui";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import type {
  DataModuleKey,
  ExportFormat,
  ExportJobFormat,
  FieldType,
  ImportJobStatus,
  ExportJobStatus,
  ProviderJobMetadata,
} from "@/lib/data-transfer/types";

/** One field of a registered entity, as the catalogue route serialises it. */
export interface CatalogueField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  readOnly: boolean;
  exportDefault: boolean;
  hint: string | null;
  options: { value: string; label: string }[] | null;
  relation: { entity: string; label: string; onMissing: string } | null;
}

export interface CatalogueEntity {
  key: string;
  module: DataModuleKey;
  moduleLabel: string;
  label: string;
  description: string;
  locationScoped: boolean;
  canExport: boolean;
  canImport: boolean;
  defaultExportFields: string[];
  duplicateRules: { key: string; label: string; fields: string[] }[];
  fields: CatalogueField[];
}

export interface ImportJobView {
  id: string;
  entityKey: string;
  entityLabel: string;
  status: ImportJobStatus;
  fileName: string;
  fileFormat: string;
  providerMetadata?: ProviderJobMetadata | null;
  totalRows: number;
  validRows: number;
  warningRows: number;
  errorRows: number;
  createdRows: number;
  updatedRows: number;
  skippedRows: number;
  failedRows: number;
  error: string | null;
  createdByName: string;
  createdAt: string;
  finishedAt: string | null;
  sourceColumns: string[];
  mapping: { columns: MappingColumn[] };
  options: Record<string, unknown>;
}

export interface MappingColumn {
  field: string;
  column: number;
  constant?: string;
  transform?: string;
}

export interface ExportJobView {
  id: string;
  entityKey: string;
  providerMetadata?: ProviderJobMetadata | null;
  entityLabel: string;
  format: ExportJobFormat;
  status: ExportJobStatus;
  rowCount: number;
  fileName: string;
  sizeBytes: number;
  error: string | null;
  scheduleId: string | null;
  createdByName: string;
  createdAt: string;
  downloadable: boolean;
}

export interface ScheduleView {
  id: string;
  entityKey: string;
  entityLabel: string;
  name: string;
  format: ExportFormat;
  frequency: "daily" | "weekly" | "monthly";
  hourLocal: number;
  weekday: number | null;
  dayOfMonth: number | null;
  fields: string[];
  deliverEmail: string;
  deliverStore: boolean;
  isActive: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: "completed" | "failed" | null;
  lastError: string | null;
}

/**
 * The engine's error codes in the operator's language.
 *
 * A raw code on screen is a dead end — the person reading it cannot act on
 * `has_invalid_rows`. Anything unmapped falls back to a sentence that at least
 * says what to do next.
 */
const ERRORS: Record<string, string> = {
  unknown_entity: "این نوع داده شناخته نشد.",
  entity_not_importable: "برای این نوع داده فقط خروجی گرفتن ممکن است.",
  location_required: "برای این نوع داده باید یک شعبهٔ فعال انتخاب شده باشد.",
  empty_file: "فایل خالی است یا سطر عنوان ندارد.",
  no_rows: "در فایل هیچ سطر داده‌ای پیدا نشد.",
  no_fields: "دست‌کم یک ستون را برای خروجی انتخاب کنید.",
  no_failed_rows: "سطر ناموفقی برای تلاش دوباره وجود ندارد.",
  unsupported_format: "قالب فایل پشتیبانی نمی‌شود. از CSV، Excel، JSON یا PDF استفاده کنید.",
  too_many_rows: "تعداد سطرهای فایل بیش از حد مجاز است. فایل را به چند بخش تقسیم کنید.",
  file_too_large: "حجم فایل بیش از حد مجاز است.",
  missing_file: "فایلی انتخاب نشده است.",
  missing_required_fields: "همهٔ ستون‌های الزامی باید نگاشت شوند.",
  has_invalid_rows: "فایل سطر نامعتبر دارد. یا آن‌ها را اصلاح کنید یا گزینهٔ «فقط سطرهای معتبر» را روشن کنید.",
  already_completed: "این عملیات پیش‌تر انجام شده است.",
  job_running: "این عملیات در حال اجراست؛ کمی بعد دوباره تلاش کنید.",
  job_not_found: "این عملیات پیدا نشد.",
  template_not_found: "این قالب پیدا نشد.",
  schedule_not_found: "این زمان‌بندی پیدا نشد.",
  name_required: "نام را وارد کنید.",
  name_taken: "نامی با همین عنوان از پیش ثبت شده است.",
  invalid_email: "نشانی ایمیل معتبر نیست.",
  no_delivery: "دست‌کم یکی از «ذخیره در تاریخچه» یا «ارسال ایمیل» باید فعال باشد.",
  content_expired: "فایل این خروجی دیگر نگه‌داری نمی‌شود.",
  forbidden: "برای این کار روی این نوع داده دسترسی ندارید.",
  unauthorized: "وارد نشده‌اید.",
  network_error: "ارتباط با سرور برقرار نشد.",
};

export function dataError(code: string | undefined): string {
  if (!code) return "انجام این کار ممکن نشد. دوباره تلاش کنید.";
  return ERRORS[code] ?? "انجام این کار ممکن نشد. دوباره تلاش کنید.";
}

const IMPORT_STATUS_TONE: Record<ImportJobStatus, "active" | "positive" | "neutral" | "danger"> = {
  pending: "neutral",
  ready: "active",
  queued: "active",
  running: "active",
  completed: "positive",
  failed: "danger",
  cancelled: "neutral",
};

const IMPORT_STATUS_TEXT: Record<ImportJobStatus, string> = {
  pending: "در انتظار نگاشت",
  ready: "آمادهٔ اجرا",
  queued: "در صف",
  running: "در حال اجرا",
  completed: "انجام شد",
  failed: "ناموفق",
  cancelled: "لغو شد",
};

export function ImportStatusBadge({ status }: { status: ImportJobStatus }) {
  return <StatusBadge tone={IMPORT_STATUS_TONE[status]}>{IMPORT_STATUS_TEXT[status]}</StatusBadge>;
}

const EXPORT_STATUS_TONE: Record<ExportJobStatus, "active" | "positive" | "neutral" | "danger"> = {
  queued: "active",
  running: "active",
  completed: "positive",
  failed: "danger",
  cancelled: "neutral",
};

const EXPORT_STATUS_TEXT: Record<ExportJobStatus, string> = {
  queued: "در صف",
  running: "در حال ساخت",
  completed: "آماده",
  failed: "ناموفق",
  cancelled: "لغو شد",
};

export function ExportStatusBadge({ status }: { status: ExportJobStatus }) {
  return <StatusBadge tone={EXPORT_STATUS_TONE[status]}>{EXPORT_STATUS_TEXT[status]}</StatusBadge>;
}

/**
 * A date, in Shamsi.
 *
 * The repo's standing rule, and it applies to this screen exactly as it does
 * to every other: no ISO string ever reaches the user.
 */
export function JalaliCell({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return <span className="tabular-nums">{toPersianDigits(formatJalali(value))}</span>;
}

/** A count, in Persian digits. */
export function Count({ value }: { value: number }) {
  return <span className="tabular-nums">{toPersianDigits(value)}</span>;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${toPersianDigits((bytes / (1024 * 1024)).toFixed(1)).replace(".", "٫")} مگابایت`;
  }
  return `${toPersianDigits(Math.max(1, Math.round(bytes / 1024)))} کیلوبایت`;
}

/** A labelled `<select>` over a plain option list. */
export function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: readonly { value: string; label: string }[];
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <select
        className={inputClass}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** A Shamsi date field — never an `<input type="date">`. */
export function DateField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint} as="div">
      <JalaliDatePicker value={value} onChange={onChange} />
    </Field>
  );
}

/**
 * The shape the screen reserves while the catalogue is being read.
 *
 * It lives beside the hook that does the reading rather than in each of the
 * three panels: the loading state and the thing being loaded are one decision,
 * and three copies of it is how they drift apart.
 */
export function DataTransferSkeleton() {
  return (
    <div className="space-y-6">
      <SectionCardSkeleton rows={2} label="در حال خواندن فهرست داده‌ها" />
      <LoadingSkeleton rows={5} />
    </div>
  );
}

/**
 * The entity catalogue, loaded once and shared by every section.
 *
 * It is the *permitted* catalogue: the route computes it from this member's
 * effective permissions, so a section rendering from it can never offer a
 * button whose route would answer 403.
 */
export function useDataCatalogue(): {
  entities: CatalogueEntity[] | null;
  canImport: boolean;
  error: string;
  reload: () => void;
} {
  const [entities, setEntities] = useState<CatalogueEntity[] | null>(null);
  const [canImport, setCanImport] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(() => {
    api<{ entities: CatalogueEntity[]; canImport: boolean; error?: string }>(
      "/api/data/entities",
    ).then(({ ok, data }) => {
      if (ok) {
        setEntities(data.entities);
        setCanImport(data.canImport);
      } else {
        setEntities([]);
        setError(dataError(data.error));
      }
    });
  }, []);

  useEffect(reload, [reload]);

  return { entities, canImport, error, reload };
}

/** Entities grouped by their module, in registry order, for a grouped picker. */
export function groupByModule(
  entities: readonly CatalogueEntity[],
): { module: DataModuleKey; label: string; entities: CatalogueEntity[] }[] {
  const groups = new Map<DataModuleKey, { module: DataModuleKey; label: string; entities: CatalogueEntity[] }>();
  for (const entity of entities) {
    const existing = groups.get(entity.module);
    if (existing) existing.entities.push(entity);
    else groups.set(entity.module, { module: entity.module, label: entity.moduleLabel, entities: [entity] });
  }
  return [...groups.values()];
}
