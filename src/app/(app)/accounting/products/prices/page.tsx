import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { AutomotivePrices } from "@/app/dashboard/products/automotive-prices";
import { JewelryPriceBoard } from "@/app/dashboard/products/jewelry-price-board";
import { PriceListsSection } from "@/app/dashboard/products/price-lists-section";
import { WooPriceSourceSettings } from "@/app/dashboard/products/woo-price-source-settings";
import { specialistSectionForPage, automotiveProductSectionForPage, requireProductWorkspace } from "@/app/dashboard/products/workspace-context";

/** «لیست قیمت» — the price-update matrix over sale/purchase and named lists. */
export default async function PriceListsPage() {
  const specialist = await specialistSectionForPage("prices");
  if (specialist?.industry === "jewelry") return (
    <PageShell>
      <PageHeader title="نرخ طلا" description="آخرین نرخ هر عیار در سامانهٔ طلا و جواهر." actions={<KnowledgeHelpButton section="jewelry" />} />
      <JewelryPriceBoard canEdit={specialist.canEdit} />
    </PageShell>
  );
  const automotive = await automotiveProductSectionForPage("prices");
  if (automotive) return (
    <PageShell>
      <PageHeader title="قیمت خودروها" description="قیمت پیشنهادی هر خودروی مستقل در شعبهٔ فعال." actions={<KnowledgeHelpButton section="automotive" />} />
      <AutomotivePrices canEdit={automotive.canEdit} />
    </PageShell>
  );
  const { apiBase, canEdit, canManageStore, draftScope } = await requireProductWorkspace();
  return (
    <PageShell>
      <PageHeader
        title="بروزرسانی قیمت‌ها"
        description="نمایش لیست قیمت‌های کالا — ستون‌های قیمت فروش و خرید و لیست‌های قیمت نام‌دار، با بروزرسانی سریع و ذخیرهٔ یکجا."
        actions={<KnowledgeHelpButton section="pos" />}
      />
      <PriceListsSection apiBase={apiBase} canEdit={canEdit} draftScope={draftScope} />
      {canManageStore ? <WooPriceSourceSettings /> : null}
    </PageShell>
  );
}
