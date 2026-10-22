import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { PriceListsSection } from "@/app/dashboard/products/price-lists-section";
import { requireProductWorkspace } from "@/app/dashboard/products/workspace-context";

/** «لیست قیمت» — the price-update matrix over sale/purchase and named lists. */
export default async function PriceListsPage() {
  const { apiBase, canEdit, draftScope } = await requireProductWorkspace();
  return (
    <PageShell>
      <PageHeader
        title="بروزرسانی قیمت‌ها"
        description="نمایش لیست قیمت‌های کالا — ستون‌های قیمت فروش و خرید و لیست‌های قیمت نام‌دار، با بروزرسانی سریع و ذخیرهٔ یکجا."
        actions={<KnowledgeHelpButton section="pos" />}
      />
      <PriceListsSection apiBase={apiBase} canEdit={canEdit} draftScope={draftScope} />
    </PageShell>
  );
}
