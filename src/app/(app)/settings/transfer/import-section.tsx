"use client";

/**
 * «ورود اطلاعات» — the import wizard.
 *
 * Four steps, in the order the brief asks for and the order the risk demands:
 * pick the data type → upload → map the columns → review and confirm. The
 * third and fourth steps are the ones that matter, and they are deliberately
 * not collapsible into "upload and go":
 *
 *  - **Mapping is proposed, never applied silently.** The engine suggests a
 *    mapping, the operator sees every suggestion, and a required field with no
 *    column is a blocking warning rather than a row-level surprise 4,000 rows
 *    later.
 *  - **The preview writes nothing.** Every count on the review step comes from
 *    a dry run against the operator's real data. Approving a preview that had
 *    side effects would make the approval meaningless.
 *
 * Confirming queues the job; the worker performs it and the history section
 * shows progress. The UI never blocks on a long import.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileUpIcon, SaveIcon, UploadIcon } from "lucide-react";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  LoadingSkeleton,
  SectionCard,
} from "@/app/dashboard/page-chrome";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import {
  ErrorBox,
  Field,
  InfoBox,
  PrimaryButton,
  SecondaryButton,
  api,
  inputClass,
} from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";
import { TRANSFORM_LABELS, TRANSFORM_RULES } from "@/lib/data-transfer/types";
import { CatalogueSection } from "./catalogue-section";
import { ReconciliationWizard } from "./reconciliation-wizard";
import {
  Count,
  SelectField,
  dataError,
  groupByModule,
  type CatalogueEntity,
  type ImportJobView,
  type MappingColumn,
} from "./data-transfer-ui";

export const CATALOGUE_IMPORT_ENTITY_KEY = "__catalogue__";

interface PreviewRow {
  rowNumber: number;
  raw: Record<string, string>;
  values: Record<string, unknown>;
  messages: { field: string | null; severity: string; message: string }[];
  valid: boolean;
}

interface PreviewState {
  totalRows: number;
  validRows: number;
  warningRows: number;
  errorRows: number;
  unmappedColumns: string[];
  missingRequired: string[];
  rows: PreviewRow[];
}

interface MappingTemplateView {
  id: string;
  entityKey: string;
  name: string;
  description: string;
  mapping: { columns: MappingColumn[] };
  options: Record<string, unknown>;
}

const MAX_FILE_BYTES = 20 * 1024 * 1024;

export function ImportSection({
  entities,
  cataloguePermitted = false,
  initialEntityKey = "",
  onJobQueued,
}: {
  entities: CatalogueEntity[] | null;
  cataloguePermitted?: boolean;
  initialEntityKey?: string;
  onJobQueued: () => void;
}) {
  const importable = useMemo(
    () => (entities ?? []).filter((entity) => entity.canImport),
    [entities],
  );
  const groups = useMemo(() => groupByModule(importable), [importable]);

  const fileInput = useRef<HTMLInputElement>(null);
  const [entityKey, setEntityKey] = useState(initialEntityKey);
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<ImportJobView | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [mapping, setMapping] = useState<MappingColumn[]>([]);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [templates, setTemplates] = useState<MappingTemplateView[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [duplicateRule, setDuplicateRule] = useState("");
  const [duplicateStrategy, setDuplicateStrategy] = useState("skip");
  const [relationStrategy, setRelationStrategy] = useState<Record<string, string>>({});
  const [validOnly, setValidOnly] = useState(true);
  const [moneyUnit, setMoneyUnit] = useState("toman");
  const [fieldSearch, setFieldSearch] = useState("");
  const [busy, setBusy] = useState<"upload" | "preview" | "run" | "template" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reconcileRunId, setReconcileRunId] = useState<string | null>(null);

  useEffect(() => {
    if (initialEntityKey === CATALOGUE_IMPORT_ENTITY_KEY && cataloguePermitted) {
      setEntityKey((current) => current || CATALOGUE_IMPORT_ENTITY_KEY);
    }
  }, [initialEntityKey, cataloguePermitted]);

  const isCatalogue = cataloguePermitted && entityKey === CATALOGUE_IMPORT_ENTITY_KEY;

  const entity = useMemo(
    () => (isCatalogue ? null : (importable.find((candidate) => candidate.key === entityKey) ?? null)),
    [importable, entityKey, isCatalogue],
  );

  // The saved mappings for this entity. Reloaded when the entity changes: a
  // template built for products would confidently map the wrong columns of a
  // customer file, so only this entity's are ever offered.
  useEffect(() => {
    if (!entityKey || isCatalogue) {
      setTemplates([]);
      return;
    }
    api<{ templates: MappingTemplateView[] }>(
      `/api/data/templates?kind=mapping&entity=${encodeURIComponent(entityKey)}`,
    ).then(({ ok, data }) => setTemplates(ok ? data.templates : []));
  }, [entityKey, isCatalogue]);

  const resetFlow = useCallback(() => {
    setJob(null);
    setColumns([]);
    setMapping([]);
    setPreview(null);
    setFile(null);
    setNotice("");
    setError("");
    if (fileInput.current) fileInput.current.value = "";
  }, []);

  async function upload() {
    if (!entity) {
      setError("ابتدا نوع داده را انتخاب کنید.");
      return;
    }
    if (!file) {
      setError("فایلی انتخاب نشده است.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(dataError("file_too_large"));
      return;
    }
    setBusy("upload");
    setError("");
    setNotice("");
    const form = new FormData();
    form.set("file", file);
    form.set("entity", entity.key);
    if (templateId) form.set("templateId", templateId);
    const { ok, data } = await api<{
      job: ImportJobView;
      columns: string[];
      error?: string;
    }>("/api/data/imports", { method: "POST", body: form });
    setBusy(null);
    if (!ok) {
      setError(dataError(data.error));
      return;
    }
    setJob(data.job);
    setColumns(data.columns);
    setMapping(data.job.mapping.columns);
    const options = data.job.options as Record<string, unknown>;
    setDuplicateRule(String(options.duplicateRule ?? entity.duplicateRules[0]?.key ?? ""));
    setDuplicateStrategy(String(options.duplicateStrategy ?? "skip"));
    setValidOnly(options.validOnly !== false);
    await refreshPreview(data.job.id, data.job.mapping.columns, {
      duplicateRule: String(options.duplicateRule ?? entity.duplicateRules[0]?.key ?? ""),
      duplicateStrategy: String(options.duplicateStrategy ?? "skip"),
      validOnly: options.validOnly !== false,
      moneyUnit,
      relationStrategy: {},
    });
  }

  const refreshPreview = useCallback(
    async (jobId: string, columnsToSend: MappingColumn[], options: Record<string, unknown>) => {
      setBusy("preview");
      const { ok, data } = await api<{
        job: ImportJobView;
        preview: PreviewState;
        error?: string;
      }>(`/api/data/imports/${jobId}`, {
        method: "PATCH",
        body: JSON.stringify({ mapping: { columns: columnsToSend }, options }),
      });
      setBusy(null);
      if (!ok) {
        setError(dataError(data.error));
        return;
      }
      setJob(data.job);
      setPreview(data.preview);
      setError("");
    },
    [],
  );

  function currentOptions(): Record<string, unknown> {
    return {
      duplicateRule: duplicateRule || undefined,
      duplicateStrategy,
      relationStrategy,
      validOnly,
      moneyUnit,
    };
  }

  function setFieldColumn(fieldKey: string, columnIndex: number) {
    const next = mapping.filter((column) => column.field !== fieldKey);
    if (columnIndex >= 0) {
      const existing = mapping.find((column) => column.field === fieldKey);
      next.push({ field: fieldKey, column: columnIndex, transform: existing?.transform ?? "none" });
    }
    setMapping(next);
    if (job) void refreshPreview(job.id, next, currentOptions());
  }

  function setFieldTransform(fieldKey: string, transform: string) {
    const next = mapping.map((column) =>
      column.field === fieldKey ? { ...column, transform } : column,
    );
    setMapping(next);
    if (job) void refreshPreview(job.id, next, currentOptions());
  }

  function applyOptions(patch: Record<string, unknown>) {
    if (!job) return;
    void refreshPreview(job.id, mapping, { ...currentOptions(), ...patch });
  }

  async function saveTemplate() {
    if (!entity || !templateName.trim()) {
      setError("برای ذخیرهٔ قالب، نامی برای آن وارد کنید.");
      return;
    }
    setBusy("template");
    const { ok, data } = await api<{ template: MappingTemplateView; error?: string }>(
      "/api/data/templates",
      {
        method: "POST",
        body: JSON.stringify({
          kind: "mapping",
          entity: entity.key,
          name: templateName.trim(),
          mapping: { columns: mapping },
          options: currentOptions(),
        }),
      },
    );
    setBusy(null);
    if (!ok) {
      setError(dataError(data.error));
      return;
    }
    setTemplates((current) => [...current, data.template]);
    setTemplateName("");
    setNotice(`قالب نگاشت «${data.template.name}» ذخیره شد.`);
  }

  async function run() {
    if (!job) return;
    setBusy("run");
    const { ok, data } = await api<{ job?: ImportJobView; error?: string; runId?: string }>(
      `/api/data/imports/${job.id}`,
      { method: "POST", body: JSON.stringify({ action: "run" }) },
    );
    setBusy(null);
    if (!ok) {
      if (data.error === "reconciliation_required" && data.runId) {
        setReconcileRunId(data.runId);
        setNotice("با توجه به وجود داده‌های هم‌پوشان، ابتدا ردیف‌ها را در میز تطبیق زیر بازبینی و اعمال کنید.");
        setError("");
        return;
      }
      setError(dataError(data.error));
      return;
    }
    setNotice(
      "ورود اطلاعات در صف اجرا قرار گرفت. پیشرفت آن را در بخش «تاریخچه» می‌بینید و می‌توانید این صفحه را ببندید.",
    );
    if (data.job) setJob(data.job);
    setPreview(null);
    onJobQueued();
  }

  if (entities === null) return <LoadingSkeleton rows={6} />;

  if (importable.length === 0 && !cataloguePermitted) {
    return (
      <SectionCard title="ورود اطلاعات">
        <EmptyState
          icon={FileUpIcon}
          title="برای هیچ نوع داده‌ای دسترسی ورود ندارید"
        >
          ورود گروهی اطلاعات به مجوز «ورود داده» و مجوز همان بخش نیاز دارد. از مالک کسب‌وکار
          بخواهید این دسترسی‌ها را برایتان فعال کند.
        </EmptyState>
      </SectionCard>
    );
  }

  const fields = entity?.fields.filter((field) => !field.readOnly) ?? [];
  const visibleFields = fieldSearch.trim()
    ? fields.filter((field) =>
        `${field.label} ${field.key}`.toLowerCase().includes(fieldSearch.trim().toLowerCase()),
      )
    : fields;
  const mappedByField = new Map(mapping.map((column) => [column.field, column]));
  const referenceFields = fields.filter((field) => field.relation);

  return (
    <div className="space-y-6">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}
      {reconcileRunId ? (
        <ReconciliationWizard
          initialRunId={reconcileRunId}
          onCompleted={() => {
            setReconcileRunId(null);
            setNotice("تطبیق اعمال شد. اکنون می‌توانید ادامه دهید یا وضعیت را در تاریخچه ببینید.");
            onJobQueued();
          }}
          onClose={() => setReconcileRunId(null)}
        />
      ) : null}

      <SectionCard
        title="۱. نوع داده و فایل"
        description={
          isCatalogue
            ? "ورود بازبینی‌شدهٔ کاتالوگ محصولات از اکسل با تطبیق برند، شناسه‌ها و فروشگاه."
            : "ابتدا مشخص کنید چه چیزی را وارد می‌کنید، سپس فایل CSV، Excel، JSON یا PDF را انتخاب کنید."
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="نوع داده" hint="فهرست فقط شامل مواردی است که اجازهٔ ورود آن‌ها را دارید.">
            <select
              className={inputClass}
              value={entityKey}
              onChange={(event) => {
                setEntityKey(event.target.value);
                setTemplateId("");
                resetFlow();
              }}
            >
              <option value="">— انتخاب کنید —</option>
              {cataloguePermitted ? (
                <optgroup label="کاتالوگ و محصولات">
                  <option value={CATALOGUE_IMPORT_ENTITY_KEY}>کاتالوگ محصولات</option>
                </optgroup>
              ) : null}
              {groups.map((group) => (
                <optgroup key={group.module} label={group.label}>
                  {group.entities.map((candidate) => (
                    <option key={candidate.key} value={candidate.key}>
                      {candidate.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>

          {!isCatalogue && templates.length > 0 ? (
            <SelectField
              label="قالب نگاشت ذخیره‌شده"
              value={templateId}
              onChange={setTemplateId}
              hint="اگر این فایل را به‌طور منظم دریافت می‌کنید، نگاشت ذخیره‌شده را انتخاب کنید."
              options={[
                { value: "", label: "— بدون قالب (پیشنهاد خودکار) —" },
                ...templates.map((template) => ({ value: template.id, label: template.name })),
              ]}
            />
          ) : null}
        </div>

        {!isCatalogue ? (
          <>
            {entity ? (
              <p className="mb-4 text-sm leading-6 text-muted-foreground">{entity.description}</p>
            ) : null}

            <Field
              label="فایل"
              hint="حداکثر ۲۰ مگابایت. PDF ساختار جدول ندارد، پس تشخیص ستون‌ها در آن حدسی است؛ حتماً پیش‌نمایش را بررسی کنید."
            >
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.txt,.tsv,.xlsx,.xlsm,.json,.pdf"
                className={inputClass}
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setJob(null);
                  setPreview(null);
                }}
              />
            </Field>

            <PrimaryButton onClick={upload} disabled={busy !== null || !entity || !file}>
              {busy === "upload" ? "در حال خواندن فایل…" : "خواندن فایل و پیشنهاد نگاشت"}
            </PrimaryButton>
          </>
        ) : null}
      </SectionCard>

      {isCatalogue ? <CatalogueSection /> : null}

      {job && entity && columns.length > 0 ? (
        <SectionCard
          title="۲. نگاشت ستون‌ها"
          description="هر ستون فایل را به فیلد متناظرش وصل کنید. پیشنهادها خودکار انجام شده‌اند و می‌توانید تغییرشان دهید."
        >
          {preview && preview.missingRequired.length > 0 ? (
            <ErrorBox>
              این ستون‌های الزامی هنوز نگاشت نشده‌اند: {preview.missingRequired.join("، ")}
            </ErrorBox>
          ) : null}
          {preview && preview.unmappedColumns.length > 0 ? (
            <InfoBox>
              این ستون‌های فایل به هیچ فیلدی وصل نشده‌اند و نادیده گرفته می‌شوند:{" "}
              {preview.unmappedColumns.join("، ")}
            </InfoBox>
          ) : null}

          <Field label="جست‌وجوی فیلد" hint="برای پیدا کردن سریع یک فیلد در فهرست زیر.">
            <input
              className={inputClass}
              value={fieldSearch}
              onChange={(event) => setFieldSearch(event.target.value)}
              placeholder="مثلاً تلفن"
            />
          </Field>

          <DataTable caption="نگاشت ستون‌های فایل به فیلدهای سیستم">
            <DataTableHead>
              <tr>
                <Th>فیلد سیستم</Th>
                <Th>ستون فایل</Th>
                <Th>تبدیل</Th>
              </tr>
            </DataTableHead>
            <DataTableBody>
              {visibleFields.map((field) => {
                const column = mappedByField.get(field.key);
                return (
                  <DataTableRow key={field.key}>
                    <Td>
                      <span className="font-medium text-foreground">{field.label}</span>
                      {field.required ? (
                        <span className="ms-1 text-destructive" aria-label="الزامی">
                          *
                        </span>
                      ) : null}
                      {field.hint ? (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {field.hint}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      <select
                        className={inputClass}
                        aria-label={`ستون فایل برای ${field.label}`}
                        value={column ? String(column.column) : "-1"}
                        onChange={(event) =>
                          setFieldColumn(field.key, Number(event.target.value))
                        }
                      >
                        <option value="-1">— نگاشت نشده —</option>
                        {columns.map((name, index) => (
                          <option key={`${name}-${index}`} value={index}>
                            {name || `ستون ${toPersianDigits(index + 1)}`}
                          </option>
                        ))}
                      </select>
                    </Td>
                    <Td>
                      <select
                        className={inputClass}
                        aria-label={`تبدیل مقدار ${field.label}`}
                        disabled={!column}
                        value={column?.transform ?? "none"}
                        onChange={(event) => setFieldTransform(field.key, event.target.value)}
                      >
                        {TRANSFORM_RULES.map((rule) => (
                          <option key={rule} value={rule}>
                            {TRANSFORM_LABELS[rule]}
                          </option>
                        ))}
                      </select>
                    </Td>
                  </DataTableRow>
                );
              })}
            </DataTableBody>
          </DataTable>

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div className="min-w-60 grow">
              <Field label="ذخیره به‌عنوان قالب" hint="تا دفعهٔ بعد همین نگاشت را دوباره بسازید.">
                <input
                  className={inputClass}
                  value={templateName}
                  onChange={(event) => setTemplateName(event.target.value)}
                  placeholder="مثلاً فهرست ماهانهٔ تأمین‌کننده"
                />
              </Field>
            </div>
            <SecondaryButton onClick={saveTemplate} disabled={busy !== null || !templateName.trim()}>
              <SaveIcon className="size-4" aria-hidden="true" />
              ذخیرهٔ قالب
            </SecondaryButton>
          </div>
        </SectionCard>
      ) : null}

      {job && entity && preview ? (
        <SectionCard
          title="۳. قواعد ورود"
          description="تکلیف رکوردهای تکراری و ارجاع‌هایی که پیدا نمی‌شوند را اینجا مشخص کنید."
        >
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {entity.duplicateRules.length > 0 ? (
              <SelectField
                label="تشخیص تکراری بر اساس"
                value={duplicateRule}
                onChange={(next) => {
                  setDuplicateRule(next);
                  applyOptions({ duplicateRule: next });
                }}
                options={entity.duplicateRules.map((rule) => ({
                  value: rule.key,
                  label: rule.label,
                }))}
              />
            ) : null}
            <SelectField
              label="اگر رکورد تکراری بود"
              value={duplicateStrategy}
              onChange={(next) => {
                setDuplicateStrategy(next);
                applyOptions({ duplicateStrategy: next });
              }}
              options={[
                { value: "skip", label: "رد شود (دست نخورد)" },
                { value: "update", label: "به‌روزرسانی شود" },
                { value: "create", label: "رکورد جدید ساخته شود" },
              ]}
            />
            <SelectField
              label="واحد مبالغ در فایل"
              value={moneyUnit}
              onChange={(next) => {
                setMoneyUnit(next);
                applyOptions({ moneyUnit: next });
              }}
              hint="اشتباه در این گزینه یعنی خطای ده‌برابری در همهٔ قیمت‌ها."
              options={[
                { value: "toman", label: "تومان" },
                { value: "rial", label: "ریال" },
              ]}
            />
            {referenceFields.map((field) => (
              <SelectField
                key={field.key}
                label={`اگر ${field.relation!.label} پیدا نشد`}
                value={relationStrategy[field.key] ?? field.relation!.onMissing}
                onChange={(next) => {
                  const updated = { ...relationStrategy, [field.key]: next };
                  setRelationStrategy(updated);
                  applyOptions({ relationStrategy: updated });
                }}
                options={[
                  { value: "create", label: "ساخته شود" },
                  { value: "skip", label: "سطر رد شود" },
                  { value: "warn", label: "بدون آن ثبت شود (با هشدار)" },
                ]}
              />
            ))}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={validOnly}
              onChange={(event) => {
                setValidOnly(event.target.checked);
                applyOptions({ validOnly: event.target.checked });
              }}
            />
            <span>فقط سطرهای معتبر وارد شوند و بقیه در گزارش خطا بمانند</span>
          </label>
        </SectionCard>
      ) : null}

      {job && preview ? (
        <SectionCard
          title="۴. پیش‌نمایش و تأیید"
          description="این ارقام از بررسی واقعی فایل روی داده‌های فعلی شما به دست آمده و هنوز چیزی ثبت نشده است."
        >
          <KpiRow>
            <KpiCard label="کل سطرها" value={toPersianDigits(preview.totalRows)} />
            <KpiCard label="سطرهای معتبر" value={toPersianDigits(preview.validRows)} />
            <KpiCard label="دارای هشدار" value={toPersianDigits(preview.warningRows)} />
            <KpiCard label="دارای خطا" value={toPersianDigits(preview.errorRows)} />
          </KpiRow>

          {preview.rows.length > 0 ? (
            <DataTable caption="پیش‌نمایش سطرهای فایل و نتیجهٔ بررسی آن‌ها">
              <DataTableHead>
                <tr>
                  <Th>سطر</Th>
                  <Th>وضعیت</Th>
                  <Th>پیام‌ها</Th>
                </tr>
              </DataTableHead>
              <DataTableBody>
                {preview.rows.slice(0, 50).map((row) => (
                  <DataTableRow key={row.rowNumber}>
                    <Td>
                      <Count value={row.rowNumber} />
                    </Td>
                    <Td>
                      {row.messages.some((message) => message.severity === "error") ? (
                        <span className="text-destructive">نامعتبر</span>
                      ) : row.messages.length > 0 ? (
                        <span className="text-amber-700 dark:text-amber-300">هشدار</span>
                      ) : (
                        <span className="text-emerald-700 dark:text-emerald-300">معتبر</span>
                      )}
                    </Td>
                    <Td>
                      {row.messages.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <ul className="space-y-1">
                          {row.messages.map((message, index) => (
                            <li key={index} className="text-xs">
                              {message.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </Td>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-3">
            <PrimaryButton
              onClick={run}
              disabled={
                busy !== null ||
                preview.missingRequired.length > 0 ||
                (preview.errorRows > 0 && !validOnly) ||
                preview.validRows + preview.warningRows === 0
              }
            >
              <UploadIcon className="size-4" aria-hidden="true" />
              {busy === "run" ? "در حال ثبت در صف…" : "تأیید و اجرای ورود"}
            </PrimaryButton>
            <SecondaryButton onClick={resetFlow} disabled={busy !== null}>
              انصراف و شروع دوباره
            </SecondaryButton>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
