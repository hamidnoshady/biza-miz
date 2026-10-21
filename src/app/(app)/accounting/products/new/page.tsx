import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { ProductAddSection } from "@/app/dashboard/products/product-add-section";
import { requireProductWorkspace } from "@/app/dashboard/products/workspace-context";

/** «افزودن محصول» — the tabbed product form with drafts and variant rows. */
export default async function ProductAddPage() {
  const { draftScope } = await requireProductWorkspace({ edit: true });
  return (
    <PageShell>
      <PageHeader
        title="افزودن محصول"
        description="ثبت محصول ساده یا خانوادهٔ چندتنوعی با قیمت، موجودی اولیه، واحد، سفارش، مالیات و بارکد — پیش‌نویس‌ها فقط روی همین دستگاه می‌مانند."
        actions={<KnowledgeHelpButton section="pos" />}
      />
      <ProductAddSection draftScope={draftScope} />
    </PageShell>
  );
}
