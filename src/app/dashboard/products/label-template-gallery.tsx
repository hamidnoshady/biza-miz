"use client";

import { useMemo } from "react";
import { useMoney } from "@/components/money/money-context";
import { EmptyState, SectionCard } from "@/app/dashboard/page-chrome";
import { TemplatePreview } from "@/app/(app)/settings/printing/template-preview";
import { samplePrintDocument } from "@/lib/print-sample";
import { PAPERS } from "@/lib/print-template";
import { availableBuiltInTemplates } from "@/lib/printing/template-catalog";
import { sampleForTemplate } from "@/lib/printing/template-samples";
import type { RetailCatalogueIndustry } from "@/lib/industries";

/** Read-only built-ins, using exactly the printer catalogue's eligibility and renderer. */
export function ReadOnlyLabelGallery({ industry }: { industry: RetailCatalogueIndustry }) {
  const money = useMoney();
  const templates = useMemo(
    () => availableBuiltInTemplates({ industry, wooEnabled: false }).filter((template) => template.docType === "label"),
    [industry],
  );
  const sample = useMemo(() => samplePrintDocument({ name: "کسب‌وکار نمونه" }, { unit: money.unit }), [money.unit]);
  return (
    <SectionCard title="قالب‌های آمادهٔ برچسب" description="نمونه‌ها با دادهٔ ساختگی نشان داده می‌شوند. مدیریت قالب‌های ذخیره‌شده به دسترسی تنظیمات نیاز دارد.">
      {templates.length === 0 ? <EmptyState>برای این کسب‌وکار قالب برچسبی در دسترس نیست.</EmptyState> : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {templates.map((template) => (
            <section key={template.key} className="min-w-0 rounded-xl border border-border p-3">
              <h2 className="font-semibold">{template.name}</h2>
              <p className="text-xs text-muted-foreground">{PAPERS[template.paper].label} · {PAPERS[template.paper].hint}</p>
              <TemplatePreview template={template} data={sampleForTemplate(template, sample, industry)} />
            </section>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
