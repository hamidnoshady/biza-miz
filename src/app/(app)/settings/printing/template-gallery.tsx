"use client";

/**
 * «قالب‌ها» — the five built-ins and everything the shop designed itself, in
 * one grid of real previews.
 *
 * Built-ins and saved templates are deliberately shown as peers with the same
 * card: they are the same data shape, and the only differences a person needs
 * to see are the badge («آماده») and that a built-in is duplicated rather than
 * edited in place. That keeps "start from a ready template" and "use my own"
 * the same two clicks.
 */
import { useMemo, useState } from "react";
import { CopyIcon, PencilIcon, PrinterIcon, StarIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  BUILT_IN_TEMPLATES,
  DOC_TYPE_LABELS,
  PAPERS,
  type DocType,
  type PrintDocumentData,
  type PrintTemplate,
} from "@/lib/print-template";
import { EmptyState, SectionCard, TabBar } from "@/app/dashboard/page-chrome";
import { wooPrintSample } from "@/lib/printing/woo-order-print-data";
import { TemplatePreview } from "./template-preview";
import type { SavedTemplateRow } from "./use-printing";

type Filter = "all" | DocType;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "همه" },
  { key: "receipt", label: DOC_TYPE_LABELS.receipt },
  { key: "invoice", label: DOC_TYPE_LABELS.invoice },
  { key: "kitchen", label: DOC_TYPE_LABELS.kitchen },
  { key: "label", label: DOC_TYPE_LABELS.label },
  { key: "shipping_label", label: DOC_TYPE_LABELS.shipping_label },
  { key: "woo_invoice", label: DOC_TYPE_LABELS.woo_invoice },
];

export function TemplateGallery({
  saved,
  data,
  onEdit,
  onDuplicate,
  onDelete,
  onPrint,
  onNew,
  busy,
}: {
  saved: SavedTemplateRow[];
  data: PrintDocumentData;
  onEdit: (template: SavedTemplateRow) => void;
  onDuplicate: (template: PrintTemplate) => void;
  onDelete: (template: SavedTemplateRow) => void;
  onPrint: (template: PrintTemplate) => void;
  onNew: () => void;
  busy: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("all");

  const builtIns = useMemo(
    () => BUILT_IN_TEMPLATES.filter((t) => filter === "all" || t.docType === filter),
    [filter],
  );
  const mine = useMemo(
    () => saved.filter((t) => filter === "all" || t.docType === filter),
    [saved, filter],
  );

  return (
    <div className="space-y-4">
      <TabBar idPrefix="print-templates" label="نوع سند" tabs={FILTERS} active={filter} onChange={setFilter} />

      <SectionCard
        title="قالب‌های آماده"
        description="قالب‌های استاندارد برای کاغذها و چاپگرهای رایج. هرکدام را می‌توانید کپی و به سلیقهٔ خودتان تغییر دهید."
      >
        {builtIns.length === 0 ? (
          <EmptyState>برای این نوع سند قالب آماده‌ای وجود ندارد؛ یک قالب جدید بسازید.</EmptyState>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {builtIns.map((template) => (
              <TemplateCard
                key={template.key}
                template={template}
                data={data}
                badge="آماده"
                busy={busy}
                actions={
                  <>
                    <Button type="button" variant="outline" size="sm" onClick={() => onDuplicate(template)}>
                      <CopyIcon aria-hidden="true" />
                      کپی و ویرایش
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => onPrint(template)}>
                      <PrinterIcon aria-hidden="true" />
                      چاپ نمونه
                    </Button>
                  </>
                }
              />
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="قالب‌های من"
        description="قالب‌هایی که خودتان طراحی کرده‌اید. قالب پیش‌فرض هر نوع سند، همانی است که صندوق به‌طور خودکار چاپ می‌کند."
        actions={
          <Button type="button" onClick={onNew}>
            قالب جدید
          </Button>
        }
      >
        {mine.length === 0 ? (
          <EmptyState>هنوز قالبی نساخته‌اید. از یکی از قالب‌های آماده کپی بگیرید یا «قالب جدید» را بزنید.</EmptyState>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {mine.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                data={data}
                badge={template.isDefault ? "پیش‌فرض" : undefined}
                busy={busy}
                actions={
                  <>
                    <Button type="button" variant="outline" size="sm" onClick={() => onEdit(template)}>
                      <PencilIcon aria-hidden="true" />
                      ویرایش
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => onPrint(template)}>
                      <PrinterIcon aria-hidden="true" />
                      چاپ نمونه
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => onDelete(template)} disabled={busy}>
                      <Trash2Icon aria-hidden="true" />
                      حذف
                    </Button>
                  </>
                }
              />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function TemplateCard({
  template,
  data,
  badge,
  actions,
}: {
  template: PrintTemplate;
  data: PrintDocumentData;
  badge?: string;
  busy: boolean;
  actions: React.ReactNode;
}) {
  const paper = PAPERS[template.paper];
  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/80 bg-card p-3">
      <TemplatePreview template={template} data={template.docType === "shipping_label" || template.docType === "woo_invoice" ? wooPrintSample(template.docType, data.business) : data} maxHeightPx={260} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 truncate font-semibold text-foreground">{template.name}</h3>
          {badge ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200">
              {badge === "پیش‌فرض" ? <StarIcon className="size-3" aria-hidden="true" /> : null}
              {badge}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {DOC_TYPE_LABELS[template.docType]} · {paper.label}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </article>
  );
}
