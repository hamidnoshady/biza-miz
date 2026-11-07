import Link from "next/link";
import { settingsTabHref } from "@/lib/settings-routes";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { ProductsListSection } from "@/app/dashboard/products/products-list-section";
import { requireProductWorkspace } from "@/app/dashboard/products/workspace-context";

/** «لیست محصولات» — the shared catalogue board: KPIs, filters, table, pager. */
export default async function ProductsListPage() {
  const { apiBase, canEdit } = await requireProductWorkspace();
  return (
    <PageShell>
      <PageHeader
        title="محصولات"
        description="نمایش و مدیریت محصولات، موجودی، قیمت و اطلاعات فروش."
        actions={<>
          {canEdit && <Link className="text-primary underline" href={`${settingsTabHref("data-transfer")}#catalogue-import`}>ورود کاتالوگ اکسل</Link>}
          <KnowledgeHelpButton section="pos" />
        </>}
      />
      <ProductsListSection apiBase={apiBase} />
    </PageShell>
  );
}
