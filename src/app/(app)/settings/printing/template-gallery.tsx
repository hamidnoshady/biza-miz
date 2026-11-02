"use client";

/**
 * «قالب‌ها» — eligible built-ins and this branch's saved layouts in one
 * gallery. Every card is a scroll-free miniature of the complete canonical
 * renderer output; the monitor dialog is the only place with user-controlled
 * zoom/scroll and it never requires a printer or a real customer record.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  EyeIcon,
  PencilIcon,
  PrinterIcon,
  StarIcon,
  Trash2Icon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DOC_TYPE_LABELS,
  PAPERS,
  type DocType,
  type PrintDocumentData,
  type PrintTemplate,
} from "@/lib/print-template";
import { EmptyState, SectionCard, TabBar } from "@/app/dashboard/page-chrome";
import { api } from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";
import { availableDocumentTypes, isTradeSpecificTemplate, templateMetadataForDisplay } from "@/lib/printing/template-catalog";
import { sampleForTemplate } from "@/lib/printing/template-samples";
import type { Industry } from "@/lib/industries";
import { INDUSTRY_LABELS } from "@/lib/industries";
import { TemplatePreview } from "./template-preview";
import type { SavedTemplateRow, UnavailableTemplateSummary } from "./use-printing";

export { sampleForTemplate };

type Filter = "all" | DocType;
interface Selection {
  templateId: string | null;
  templateKey: string | null;
}
interface ResolvedTemplateView {
  ok: boolean;
  templateId?: string | null;
  templateKey?: string | null;
}

export function TemplateGallery({
  saved,
  builtIns,
  unavailableTemplates,
  industry,
  data,
  onEdit,
  onDuplicate,
  onDelete,
  onPrint,
  onSelect,
  onNew,
  busy,
}: {
  saved: SavedTemplateRow[];
  builtIns: PrintTemplate[];
  unavailableTemplates: UnavailableTemplateSummary[];
  industry: Industry | null;
  data: PrintDocumentData;
  onEdit: (template: SavedTemplateRow) => void;
  onDuplicate: (template: PrintTemplate) => void;
  onDelete: (template: SavedTemplateRow) => void;
  onPrint: (template: PrintTemplate) => void;
  onSelect: (template: PrintTemplate) => Promise<void>;
  onNew: () => void;
  busy: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [resolved, setResolved] = useState<Record<string, ResolvedTemplateView>>({});
  const [resolving, setResolving] = useState(true);
  const templates = useMemo(() => [...builtIns, ...saved], [builtIns, saved]);
  const availableTypes = useMemo(() => availableDocumentTypes(templates), [templates]);
  const filters = useMemo(
    () => [
      { key: "all" as const, label: "همهٔ قالب‌های مجاز" },
      ...availableTypes.map((key) => ({ key, label: DOC_TYPE_LABELS[key] })),
    ],
    [availableTypes],
  );

  const reloadResolved = useCallback(async () => {
    setResolving(true);
    const { ok, data: result } = await api<{ resolved?: Record<string, ResolvedTemplateView> }>("/api/settings/print-rules");
    setResolved(ok ? result.resolved ?? {} : {});
    setResolving(false);
  }, []);

  useEffect(() => {
    void reloadResolved();
  }, [reloadResolved]);

  useEffect(() => {
    if (filter !== "all" && !availableTypes.includes(filter)) setFilter("all");
  }, [availableTypes, filter]);

  const filteredBuiltIns = useMemo(
    () => builtIns.filter((template) => filter === "all" || template.docType === filter),
    [builtIns, filter],
  );
  const filteredSaved = useMemo(
    () => saved.filter((template) => filter === "all" || template.docType === filter),
    [saved, filter],
  );

  const specificBuiltIns = useMemo(() => filteredBuiltIns.filter(isTradeSpecificTemplate), [filteredBuiltIns]);
  const generalBuiltIns = useMemo(
    () => filteredBuiltIns.filter((template) => !isTradeSpecificTemplate(template)),
    [filteredBuiltIns],
  );

  async function choose(template: PrintTemplate) {
    await onSelect(template);
    await reloadResolved();
  }

  return (
    <div className="space-y-4">
      <TabBar idPrefix="print-templates" label="نوع سند" tabs={filters} active={filter} onChange={setFilter} />

      {resolving ? (
        <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Skeleton aria-hidden="true" className="h-5 w-28 rounded-full" />
          <span>در حال بررسی قالب فعال…</span>
        </div>
      ) : null}

      <SectionCard
        title="قالب‌های آماده"
        description="نمونه‌ها با داده‌های ساختگی و همان موتور چاپ ساخته شده‌اند. قالب آماده را می‌توانید مستقیم انتخاب کنید یا برای سفارشی‌سازی کپی بگیرید."
      >
        {industry ? (
          <p className="mb-3 text-xs text-muted-foreground">
            نوع کسب‌وکار: <span className="font-medium text-foreground">{INDUSTRY_LABELS[industry]}</span>
            {" "}— نمونه‌ها با اقلام و برچسب‌های همین حوزه ساخته شده‌اند.
          </p>
        ) : null}
        {filteredBuiltIns.length === 0 ? (
          <EmptyState>برای نوع کسب‌وکار و قابلیت‌های فعال، قالب آماده‌ای در این گروه وجود ندارد.</EmptyState>
        ) : (
          <div className="space-y-5">
            {[
              { key: "specific", title: industry ? `ویژهٔ ${INDUSTRY_LABELS[industry]}` : "ویژهٔ برخی کسب‌وکارها", items: specificBuiltIns },
              { key: "general", title: "عمومی", items: generalBuiltIns },
            ]
              .filter((group) => group.items.length > 0)
              .map((group, _index, groups) => (
                <section key={group.key} aria-label={group.title} className="space-y-3">
                  {groups.length > 1 ? <h3 className="text-sm font-semibold text-foreground">{group.title}</h3> : null}
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {group.items.map((template) => (
                      <TemplateCard
                        key={template.key}
                        template={template}
                        data={sampleForTemplate(template, data, industry)}
                        selected={isSelected(template, resolved[template.docType])}
                        resolving={resolving}
                        busy={busy}
                        onSelect={() => void choose(template)}
                      >
                        <Button type="button" variant="outline" size="sm" onClick={() => onDuplicate(template)} disabled={busy}>
                          <CopyIcon aria-hidden="true" />
                          کپی و ویرایش
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => onPrint(template)} disabled={busy}>
                          <PrinterIcon aria-hidden="true" />
                          چاپ نمونه
                        </Button>
                      </TemplateCard>
                    ))}
                  </div>
                </section>
              ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="قالب‌های من"
        description="قالب‌های این شعبه. انتخاب قالب، قانون چاپ همان نوع سند را به‌روزرسانی می‌کند و هیچ قالب سفارشی دیگری را بازنویسی نمی‌کند."
        actions={
          <Button type="button" onClick={onNew} disabled={busy || availableTypes.length === 0}>
            قالب جدید
          </Button>
        }
      >
        {filteredSaved.length === 0 ? (
          <EmptyState>هنوز قالب قابل‌استفاده‌ای نساخته‌اید. از یک قالب آماده کپی بگیرید یا «قالب جدید» را بزنید.</EmptyState>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {filteredSaved.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                data={sampleForTemplate(template, data, industry)}
                selected={isSelected(template, resolved[template.docType])}
                resolving={resolving}
                busy={busy}
                onSelect={() => void choose(template)}
              >
                <Button type="button" variant="outline" size="sm" onClick={() => onEdit(template)} disabled={busy}>
                  <PencilIcon aria-hidden="true" />
                  ویرایش
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => onPrint(template)} disabled={busy}>
                  <PrinterIcon aria-hidden="true" />
                  چاپ نمونه
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => onDelete(template)} disabled={busy}>
                  <Trash2Icon aria-hidden="true" />
                  حذف
                </Button>
              </TemplateCard>
            ))}
          </div>
        )}
      </SectionCard>

      {unavailableTemplates.length > 0 ? (
        <SectionCard
          title="قالب‌های ذخیره‌شدهٔ غیرفعال"
          description="قالب‌ها حفظ شده‌اند اما با نوع کسب‌وکار یا قابلیت‌های فعلی سازگار نیستند و در هیچ قانون یا چاپ جدیدی استفاده نمی‌شوند."
        >
          <ul className="divide-y divide-border/60 text-sm">
            {unavailableTemplates.map((template) => (
              <li key={template.id} className="flex flex-wrap items-start justify-between gap-2 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="font-medium text-foreground">{template.name}</p>
                  <p className="text-xs text-muted-foreground">{DOC_TYPE_LABELS[template.docType] ?? template.docType}</p>
                </div>
                <p className="max-w-xl text-xs text-amber-800 dark:text-amber-200">
                  {unavailableReasonText(template.reason, industry)}
                </p>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}

function TemplateCard({
  template,
  data,
  selected,
  resolving,
  busy,
  onSelect,
  children,
}: {
  template: PrintTemplate;
  data: PrintDocumentData;
  selected: boolean;
  resolving: boolean;
  busy: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const meta = templateMetadataForDisplay(template);
  const paper = PAPERS[template.paper];
  const orientation = template.options.orientation === "landscape" && paper.kind !== "thermal" ? "افقی" : "عمودی";
  const industryText = meta.eligibleIndustry;
  const isWooDocument = template.docType === "shipping_label" || template.docType === "woo_invoice";
  const selectionLabel = isWooDocument ? "انتخاب پیش‌فرض شعبه" : "انتخاب قالب";

  function updatePageCount(next: number) {
    setPageCount((current) => current === next ? current : next);
    setPageIndex((current) => Math.min(current, Math.max(0, next - 1)));
  }

  return (
    <>
      <article className="flex h-full min-w-0 flex-col gap-3 rounded-xl border border-border/80 bg-card p-3">
        <div className="relative">
          <TemplatePreview template={template} data={data} maxHeightPx={244} mode="thumbnail" />
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={`بزرگ‌نمایی پیش‌نمایش ${template.name}`}
            className="absolute inset-0 rounded-xl outline-none transition-colors hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate font-semibold text-foreground">{template.name}</h3>
            {selected ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-950 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-200">
                <StarIcon className="size-3" aria-hidden="true" />
                {isWooDocument ? "پیش‌فرض شعبه" : "فعال برای چاپ"}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{DOC_TYPE_LABELS[template.docType]} · {paper.label} · {orientation}</p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={
                meta.tradeSpecific
                  ? "inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200"
                  : "inline-flex items-center rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-foreground"
              }
            >
              {meta.tradeSpecific ? "ویژهٔ حوزهٔ خاص" : "عمومی"}
            </span>
            <span>مناسب: {industryText}</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{meta.logo}</p>
        </div>
        <div className="mt-auto flex flex-col gap-2">
          {!selected ? (
            <Button type="button" size="sm" className="w-full" onClick={onSelect} disabled={busy || resolving}>
              <CheckIcon aria-hidden="true" />
              {selectionLabel}
            </Button>
          ) : null}
          <div className="flex flex-wrap gap-2 [&>button]:flex-1">
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
              <EyeIcon aria-hidden="true" />
              پیش‌نمایش دیجیتال
            </Button>
            {children}
          </div>
        </div>
      </article>

      <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) { setZoom(100); setPageIndex(0); } }}>
        <DialogContent
          showCloseButton
          className="grid h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-6xl grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-6xl"
        >
          <DialogHeader className="gap-1 border-b border-border/70 py-4 ps-4 pe-14 sm:ps-6 sm:pe-14">
            <DialogTitle className="text-base">{template.name}</DialogTitle>
            <DialogDescription>
              {DOC_TYPE_LABELS[template.docType]} · {paper.label} · {orientation} · {industryText}
            </DialogDescription>
            <p className="text-xs text-muted-foreground">
              پیش‌نمایش روی صفحه با داده‌های ساختگی است؛ چاپگر یا دانلود لازم نیست. {meta.logo}.
            </p>
          </DialogHeader>

          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 bg-muted/30 px-4 py-2 sm:px-6">
            <div className="flex items-center gap-1" role="group" aria-label="بزرگ‌نمایی">
              <Button type="button" variant="outline" size="icon-sm" aria-label="کوچک‌نمایی" disabled={zoom <= 50} onClick={() => setZoom((current) => Math.max(50, current - 25))}>
                <ZoomOutIcon aria-hidden="true" />
              </Button>
              <Button type="button" variant="ghost" size="sm" className="min-w-14 tabular-nums" aria-label="بازنشانی بزرگ‌نمایی" disabled={zoom === 100} onClick={() => setZoom(100)}>
                {toPersianDigits(zoom)}٪
              </Button>
              <Button type="button" variant="outline" size="icon-sm" aria-label="بزرگ‌نمایی" disabled={zoom >= 200} onClick={() => setZoom((current) => Math.min(200, current + 25))}>
                <ZoomInIcon aria-hidden="true" />
              </Button>
            </div>
            {pageCount > 1 ? (
              <div className="flex items-center gap-1" role="group" aria-label="پیمایش برگه‌ها">
                <Button type="button" variant="outline" size="icon-sm" aria-label="برگهٔ قبلی" disabled={pageIndex <= 0} onClick={() => setPageIndex((current) => current - 1)}>
                  <ChevronRightIcon aria-hidden="true" />
                </Button>
                <span className="min-w-24 text-center text-xs text-muted-foreground">
                  برگهٔ {toPersianDigits(pageIndex + 1)} از {toPersianDigits(pageCount)}
                </span>
                <Button type="button" variant="outline" size="icon-sm" aria-label="برگهٔ بعدی" disabled={pageIndex >= pageCount - 1} onClick={() => setPageIndex((current) => current + 1)}>
                  <ChevronLeftIcon aria-hidden="true" />
                </Button>
              </div>
            ) : null}
          </div>

          <div className="min-h-0 p-3 sm:p-5">
            <TemplatePreview
              template={template}
              data={data}
              mode="expanded"
              scale={zoom / 100}
              pageIndex={pageIndex}
              onPageCountChange={updatePageCount}
            />
          </div>

          <DialogFooter className="flex-row items-center justify-between gap-2 border-t border-border/70 px-4 py-3 sm:px-6">
            <p className="hidden min-w-0 text-xs text-muted-foreground sm:block">قالب آماده فقط به‌عنوان قانون چاپ انتخاب می‌شود؛ کپی‌کردن برای ویرایش، اصل آن را تغییر نمی‌دهد.</p>
            <div className="flex shrink-0 gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>بستن</Button>
              <Button type="button" onClick={() => { onSelect(); setOpen(false); }} disabled={busy || resolving || selected}>
                {selected ? "قالب فعال است" : selectionLabel}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function isSelected(template: PrintTemplate, resolved?: ResolvedTemplateView): boolean {
  if (!resolved?.ok) return false;
  const id = "id" in template && typeof template.id === "string" ? template.id : null;
  return id ? resolved.templateId === id : resolved.templateKey === template.key;
}

function unavailableReasonText(reason: string | null, industry: Industry | null): string {
  if (reason === "woo_not_connected") return "برای فعال‌شدن، قابلیت اتصال و یک فروشگاه WooCommerce فعال در این شعبه لازم است.";
  if (reason === "capability_unavailable") return "قابلیت لازم برای این نوع قالب در پروفایل کسب‌وکار فعال نیست.";
  if (reason === "module_unavailable") return "ماژول مربوط به این نوع سند در کسب‌وکار فعلی وجود ندارد.";
  if (reason === "incompatible_paper") return "اندازهٔ کاغذ با نوع سند قالب سازگار نیست.";
  if (reason === "unsupported_document") return "نوع سند این قالب در مسیر چاپ فعلی پشتیبانی نمی‌شود.";
  return industry
    ? `این قالب برای نوع کسب‌وکار فعلی (${INDUSTRY_LABELS[industry]}) مجاز نیست.`
    : "این قالب با نوع کسب‌وکار فعلی سازگار نیست.";
}
