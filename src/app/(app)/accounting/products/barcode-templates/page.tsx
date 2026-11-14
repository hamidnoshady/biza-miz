import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { LegacyWeightPatterns } from "@/app/dashboard/products/legacy-weight-patterns";
import { SpecialistLabelPrinter } from "@/app/dashboard/products/specialist-label-printer";
import { ReadOnlyLabelGallery } from "@/app/dashboard/products/label-template-gallery";
import { PrintingManager } from "@/app/(app)/settings/printing/printing-manager";
import { requireRetailLabels } from "@/app/dashboard/products/workspace-context";

/** Label designs share the existing print catalogue and branch print rules. */
export default async function BarcodeTemplatesPage() {
  const { industry, canManage, canPrint, canAssignBarcode, locationId, canViewLegacyWeight, canEditLegacyWeight } = await requireRetailLabels();
  return (
    <PageShell>
      <PageHeader
        title="بارکد و برچسب محصولات"
        description="قالب‌های برچسب متناسب با کسب‌وکار، اندازهٔ کاغذ و پیش‌نمایش چاپ."
        actions={<KnowledgeHelpButton section="pos" />}
      />
      {canManage && canPrint ? <p className="text-sm text-muted-foreground">چاپ نمونه برای بررسی مسیر و اندازهٔ چاپ از داده‌های آزمایشی عمومی استفاده می‌کند؛ داده‌های صنفی در پیش‌نمایش فرضی هستند.</p> : null}
      <div data-tour-id="barcode-templates.list">
        {canManage ? <PrintingManager labelsOnly canPrint={canPrint} /> : <ReadOnlyLabelGallery industry={industry} />}
      </div>
      {(canPrint || canAssignBarcode) && (industry === "watch" || industry === "jewelry") ? <SpecialistLabelPrinter industry={industry} canPrint={canPrint} canAssign={canAssignBarcode} locationId={locationId} /> : null}
      {canViewLegacyWeight ? <LegacyWeightPatterns canEdit={canEditLegacyWeight} /> : null}
    </PageShell>
  );
}
