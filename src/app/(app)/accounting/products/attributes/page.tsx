import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { AttributesSection } from "@/app/dashboard/products/attributes-section";
import { WooAttributeMapping } from "@/app/dashboard/products/woo-attribute-mapping";
import { requireProductWorkspace } from "@/app/dashboard/products/workspace-context";

/** «ویژگی محصول» — the attribute master: cards, add and edit. */
export default async function AttributesPage() {
  const { canEdit } = await requireProductWorkspace();
  return (
    <PageShell>
      <PageHeader
        title="ویژگی محصول"
        description={canEdit
          ? "نمایش و ویرایش ویژگی‌های محصول شعبه — رنگ، برند و هر ویژگی دیگری با مقدارهای مجازش."
          : "نمایش ویژگی‌های محصول شعبه و مقدارهای مجاز؛ این دسترسی فقط‌خواندنی است."}
        actions={<KnowledgeHelpButton section="pos" />}
      />
      <AttributesSection canEdit={canEdit} />
      {canEdit ? <WooAttributeMapping /> : null}
    </PageShell>
  );
}
