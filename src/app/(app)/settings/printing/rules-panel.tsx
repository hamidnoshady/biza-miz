"use client";

/**
 * «قوانین چاپ» — routing: which template and which printer each document type
 * uses.
 *
 * Three rules this screen obeys, because they are the ones the runtime obeys:
 *
 *  - **Templates are filtered by document type AND by the printer that will
 *    print them.** A saved template of the location is offered next to the
 *    built-ins, since a custom layout nobody can select is a template nobody
 *    can use; a template the chosen printer physically cannot carry is not
 *    offered at all.
 *  - **Printers are filtered by physical compatibility.** A page printer is
 *    never offered for a receipt rule, an inactive or disconnected printer is
 *    shown but marked, and the fallback list never repeats the primary.
 *  - **The screen says what would actually print now** — the resolved plan,
 *    straight from the same resolver the till calls, including which template
 *    revision and which printer the fallback replaced.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { LoadingSkeleton, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { ErrorBox, InfoBox, api, errorMessage, inputClass } from "@/app/dashboard/ui";
import { BUILT_IN_TEMPLATES, DOC_TYPE_LABELS, PAPERS, type DocType, type PrintTemplate } from "@/lib/print-template";
import { printerErrorMessage } from "@/lib/printing/errors";
import { printTemplateSample } from "@/lib/printing/client";
import { printerAcceptsDocument, printerAcceptsPaper, type RoutingPrinter } from "@/lib/printing/routing";
import { printerClassOf, printerNeedsReconnect, resolvedPaperOf, type PrinterPurpose } from "@/lib/printing/types";
import { usePrinterList, useSavedTemplates, type PrinterRow, type SavedTemplateRow } from "./use-printing";

const DOCS: DocType[] = ["receipt", "kitchen", "invoice", "label"];

/** What each document type means, in the operator's words. */
const DOC_HINT: Record<DocType, string> = {
  receipt: "فیش مشتری که هنگام تسویه در صندوق چاپ می‌شود.",
  kitchen: "سفارش آشپزخانه که از صندلی/گارسون ارسال می‌شود.",
  invoice: "فاکتور رسمی روی کاغذ A4 یا A5.",
  label: "برچسب قیمت و بارکد کالا.",
};

interface RuleRow {
  document_type: string;
  template_key: string | null;
  template_id: string | null;
  printer_id: string | null;
  fallback_printer_id: string | null;
}

interface ResolvedPlan {
  ok: boolean;
  error?: string;
  printerName?: string;
  route?: string;
  fallbackPrinterName?: string | null;
  templateKey?: string | null;
  templateId?: string | null;
  templateName?: string;
  templateVersion?: number;
  templateSource?: string;
}

interface HistoryRow {
  id: string;
  documentType: string;
  status: string;
  errorCode: string | null;
  printerName: string | null;
  templateKey: string | null;
  templateVersion: number | null;
  when: string;
}

const STATUS_LABEL: Record<string, string> = {
  handed_off: "ارسال شد",
  sending: "در حال ارسال",
  failed: "ناموفق",
};

const ROUTE_LABEL: Record<string, string> = {
  requested: "چاپگر انتخاب‌شده",
  rule: "قانون این سند",
  fallback: "چاپگر جانشین",
  only: "تنها چاپگر سازگار",
  last_used: "آخرین چاپگر استفاده‌شده",
  default: "چاپگر پیش‌فرض",
  none: "انتخاب نشده",
};

const RULE_ERROR: Record<string, string> = {
  incompatible_template: "این قالب برای این نوع سند یا این چاپگر نیست.",
  incompatible_printer: "این چاپگر این نوع سند را چاپ نمی‌کند.",
  duplicate_fallback_printer: "چاپگر جانشین نمی‌تواند همان چاپگر اصلی باشد.",
  template_not_found: "قالب پیدا نشد؛ ممکن است حذف شده باشد.",
  printer_not_found: "چاپگر پیدا نشد؛ ممکن است حذف شده باشد.",
};

function ruleError(code: string | undefined): string {
  if (!code) return "ذخیرهٔ قانون چاپ ناموفق بود.";
  return RULE_ERROR[code] ?? printerErrorMessage(code) ?? errorMessage(code);
}

function routingPrinterOf(printer: PrinterRow): RoutingPrinter {
  return {
    id: printer.id,
    name: printer.name,
    purpose: printer.kind as PrinterPurpose,
    printerClass: printerClassOf(printer),
    isActive: printer.is_active !== false,
    isDefault: printer.is_default === true,
    needsReconnect: printerNeedsReconnect(printer),
    supportsDrawer: printer.supports_drawer === true,
    paper: resolvedPaperOf(printer),
  };
}

function paperLabel(printer: PrinterRow): string {
  const paper = resolvedPaperOf(printer);
  return PAPERS[paper]?.label ?? paper;
}

export function RulesPanel() {
  const saved = useSavedTemplates();
  const printerList = usePrinterList();
  const [rules, setRules] = useState<Record<string, RuleRow>>({});
  const [resolved, setResolved] = useState<Record<string, ResolvedPlan>>({});
  const [jobs, setJobs] = useState<HistoryRow[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const [ruleRes, jobRes] = await Promise.all([
      api<{ rules?: RuleRow[]; resolved?: Record<string, ResolvedPlan> }>("/api/settings/print-rules"),
      api<{ jobs?: HistoryRow[] }>("/api/printing/jobs"),
    ]);
    if (!ruleRes.ok) setError("قوانین چاپ خوانده نشد.");
    const next: Record<string, RuleRow> = {};
    for (const row of ruleRes.data.rules ?? []) next[row.document_type] = row;
    setRules(next);
    setResolved(ruleRes.data.resolved ?? {});
    if (jobRes.ok) setJobs(jobRes.data.jobs ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const routablePrinters = useMemo(() => printerList.printers.map(routingPrinterOf), [printerList.printers]);

  const compatible = useCallback(
    (documentType: DocType) => printerList.printers.filter((_, index) => printerAcceptsDocument(routablePrinters[index], documentType)),
    [printerList.printers, routablePrinters],
  );

  async function save(documentType: DocType) {
    const row = rules[documentType];
    setSaving(documentType);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ error?: string }>("/api/settings/print-rules", {
      method: "PUT",
      body: JSON.stringify({
        documentType,
        templateKey: row?.template_key ?? null,
        templateId: row?.template_id ?? null,
        printerId: row?.printer_id ?? null,
        fallbackPrinterId: row?.fallback_printer_id ?? null,
      }),
    });
    setSaving(null);
    if (!ok) {
      setError(ruleError(data.error));
      return;
    }
    setNotice(`قانون «${DOC_TYPE_LABELS[documentType]}» ذخیره شد.`);
    await reload();
  }

  async function printSample(documentType: DocType) {
    const row = rules[documentType];
    setTesting(documentType);
    setError("");
    setNotice("");
    const result = await printTemplateSample({
      id: row?.template_id ?? null,
      docType: documentType,
    });
    setTesting(null);
    if (!result.ok) {
      setError(
        result.error === "connector_not_installed" || result.error === "connector_outdated"
          ? "برای چاپ از این کامپیوتر، سرویس چاپ را از تب «چاپگرها» نصب کنید."
          : printerErrorMessage(result.error),
      );
      return;
    }
    setNotice("نمونه از همان مسیر چاپ واقعی ارسال شد.");
  }

  function patch(documentType: DocType, patchRow: Partial<RuleRow>) {
    setRules((current) => ({
      ...current,
      [documentType]: {
        document_type: documentType,
        template_key: current[documentType]?.template_key ?? null,
        template_id: current[documentType]?.template_id ?? null,
        printer_id: current[documentType]?.printer_id ?? null,
        fallback_printer_id: current[documentType]?.fallback_printer_id ?? null,
        ...patchRow,
      },
    }));
  }

  if (loading) return <LoadingSkeleton rows={4} />;

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      {DOCS.map((documentType) => {
        const row = rules[documentType];
        const printers = compatible(documentType);
        const fallbackCandidates = printers.filter((printer) => printer.id !== row?.printer_id);
        const chosenPrinter = printers.find((printer) => printer.id === row?.printer_id) ?? null;
        // Templates this document type may use: the ones that fit the printer
        // that will actually print them (or, before a printer is chosen, every
        // template of the document type).
        const savedForDoc = saved.templates.filter((template) => template.docType === documentType);
        const savedTemplates = chosenPrinter
          ? savedForDoc.filter((template) => templateCanPrint(chosenPrinter, template))
          : savedForDoc;
        const builtIns = builtInsFor(documentType).filter((template) =>
          chosenPrinter ? templateCanPrint(chosenPrinter, template) : true,
        );
        const plan = resolved[documentType];

        return (
          <SectionCard key={documentType} title={DOC_TYPE_LABELS[documentType]} description={DOC_HINT[documentType]}>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">قالب</span>
                <select
                  className={inputClass}
                  value={row?.template_id ? `id:${row.template_id}` : row?.template_key ? `key:${row.template_key}` : ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    patch(documentType, {
                      template_id: value.startsWith("id:") ? value.slice(3) : null,
                      template_key: value.startsWith("key:") ? value.slice(4) : null,
                    });
                  }}
                >
                  <option value="">قالب پیش‌فرض شعبه</option>
                  {savedTemplates.length > 0 ? (
                    <optgroup label="قالب‌های ذخیره‌شدهٔ این شعبه">
                      {savedTemplates.map((template) => (
                        <option key={template.id} value={`id:${template.id}`}>
                          {template.name}
                          {template.isDefault ? " — پیش‌فرض" : ""}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  <optgroup label="قالب‌های آماده">
                    {builtIns.map((template) => (
                      <option key={template.key} value={`key:${template.key}`}>
                        {template.name}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>

              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">چاپگر</span>
                <select
                  className={inputClass}
                  value={row?.printer_id ?? ""}
                  onChange={(event) => patch(documentType, { printer_id: event.target.value || null })}
                >
                  <option value="">انتخاب خودکار</option>
                  {printers.map((printer) => (
                    <option key={printer.id} value={printer.id}>
                      {printer.name} — {paperLabel(printer)}
                      {printer.is_active === false ? " (غیرفعال)" : ""}
                      {printerNeedsReconnect(printer) ? " (نیازمند اتصال دوباره)" : ""}
                    </option>
                  ))}
                </select>
                {printers.length === 0 ? (
                  <span className="mt-1 block text-xs text-amber-700 dark:text-amber-300">
                    چاپگر سازگاری برای این نوع سند ثبت نشده است؛ از تب «چاپگرها» یکی اضافه کنید.
                  </span>
                ) : null}
              </label>

              <label className="block text-sm sm:col-span-2">
                <span className="mb-1 block text-muted-foreground">چاپگر جانشین (وقتی چاپگر اصلی در دسترس نیست)</span>
                <select
                  className={inputClass}
                  value={row?.fallback_printer_id ?? ""}
                  onChange={(event) => patch(documentType, { fallback_printer_id: event.target.value || null })}
                >
                  <option value="">بدون جانشین</option>
                  {fallbackCandidates.map((printer) => (
                    <option key={printer.id} value={printer.id}>
                      {printer.name} — {paperLabel(printer)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button type="button" disabled={saving === documentType} onClick={() => void save(documentType)}>
                {saving === documentType ? "در حال ذخیره…" : "ذخیره"}
              </Button>
              <Button type="button" variant="outline" disabled={testing === documentType} onClick={() => void printSample(documentType)}>
                {testing === documentType ? "در حال ارسال…" : "چاپ نمونه روی همین مسیر"}
              </Button>
            </div>

            <p className="mt-3 text-xs leading-6 text-muted-foreground">
              {plan?.ok ? (
                <>
                  اکنون: قالب «{plan.templateName}»
                  {plan.templateVersion ? ` (نسخهٔ ${plan.templateVersion})` : ""} روی «{plan.printerName}» — مسیر:{" "}
                  {ROUTE_LABEL[plan.route ?? ""] ?? plan.route}
                  {plan.fallbackPrinterName ? ` (جانشین «${plan.fallbackPrinterName}»)` : ""}
                </>
              ) : plan ? (
                <span className="text-amber-700 dark:text-amber-300">
                  اکنون چاپ نمی‌شود: {printerErrorMessage(plan.error)}
                </span>
              ) : null}
            </p>
          </SectionCard>
        );
      })}

      <SectionCard title="فعالیت اخیر" description="آخرین ارسال‌ها. «ارسال شد» یعنی ویندوز کار را پذیرفته است.">
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز چاپی ثبت نشده است.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {jobs.map((job) => (
              <li key={job.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-muted-foreground">{job.when}</span>
                <span>{DOC_TYPE_LABELS[job.documentType as DocType] ?? job.documentType}</span>
                <span dir="auto">{job.printerName ?? "—"}</span>
                <span className="text-xs text-muted-foreground">
                  {job.templateKey ? `${job.templateKey}${job.templateVersion ? ` · v${job.templateVersion}` : ""}` : "—"}
                </span>
                <StatusBadge tone={job.status === "handed_off" ? "active" : job.status === "failed" ? "danger" : "neutral"}>
                  {STATUS_LABEL[job.status] ?? job.status}
                </StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

/** The built-ins of a document type — the same set the resolver can fall back to. */
function builtInsFor(documentType: DocType) {
  return BUILT_IN_TEMPLATES.filter((template) => template.docType === documentType);
}

/** Can this printer physically carry this template's own paper? */
function templateCanPrint(printer: PrinterRow, template: { paper: PrintTemplate["paper"] }): boolean {
  return printerAcceptsPaper(printerClassOf(printer), template.paper);
}
