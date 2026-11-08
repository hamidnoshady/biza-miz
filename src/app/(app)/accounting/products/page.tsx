import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { ProductsListSection } from "@/app/dashboard/products/products-list-section";
import { requireProductWorkspace } from "@/app/dashboard/products/workspace-context";

/** «لیست محصولات» — the shared catalogue board: KPIs, filters, table, pager. */
export default async function ProductsListPage() {
  const { apiBase, canEdit, canImport } = await requireProductWorkspace();
  return (
    <PageShell>
      <PageHeader
        title="محصولات"
        description="نمایش و مدیریت محصولات، موجودی، قیمت و اطلاعات فروش."
        actions={<>
          {canEdit && canImport ?
            <Link className={buttonVariants({ variant: "outline" })} href="/settings/transfer?import=catalogue">ورود از اکسل</Link> : null}
          <KnowledgeHelpButton section="pos" />
        </>}
      />
      <ProductsListSection apiBase={apiBase} />
    </PageShell>
  );
}
