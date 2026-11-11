import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { AutomotiveWorkspace } from "@/app/dashboard/automotive/automotive-workspace";
import { SpecialistCatalogue } from "@/app/dashboard/products/specialist-catalogue";
import { ProductsListSection } from "@/app/dashboard/products/products-list-section";
import { specialistCatalogueForPage, requireProductWorkspace } from "@/app/dashboard/products/workspace-context";

/** «لیست محصولات» — the shared catalogue board: KPIs, filters, table, pager. */
export default async function ProductsListPage() {
  const specialist = await specialistCatalogueForPage();
  if (specialist?.industry === "automotive") return <AutomotiveWorkspace initialSection="stock" />;
  if (specialist) return (
    <PageShell>
      <PageHeader title="محصولات" description={specialist.industry === "watch" ? "مدل‌های ساعت و دستگاه‌های سریال‌دار شعبهٔ فعال." : "قطعات طلا و جواهر شعبهٔ فعال با وزن و عیار هر قطعه."} actions={<KnowledgeHelpButton section={specialist.industry} />} />
      <SpecialistCatalogue industry={specialist.industry} canEdit={specialist.canEdit} />
    </PageShell>
  );
  const { apiBase, canEdit, canImport, canEditMeta, canManageStore } = await requireProductWorkspace();
  return (
    <PageShell>
      <PageHeader
        title="محصولات"
        description="نمایش و مدیریت محصولات، موجودی، قیمت و اطلاعات فروش."
        actions={<>
          {canEdit && canImport ?
            <Link className={buttonVariants({ variant: "outline" })} href="/settings/data-transfer?import=catalogue">ورود از اکسل</Link> : null}
          <KnowledgeHelpButton section="pos" />
        </>}
      />
      <ProductsListSection apiBase={apiBase} canEditStock={canEdit} canEditMeta={canEditMeta} canManageStore={canManageStore} />
    </PageShell>
  );
}
