import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { SpecialistAttributes } from "@/app/dashboard/products/specialist-attributes";
import { AttributesSection } from "@/app/dashboard/products/attributes-section";
import { WooAttributeMapping } from "@/app/dashboard/products/woo-attribute-mapping";
import { requireProductWorkspace, specialistCatalogueForPage } from "@/app/dashboard/products/workspace-context";

/** «ویژگی محصول» — the attribute master: cards, add and edit. */
export default async function AttributesPage() {
  const specialist = await specialistCatalogueForPage();
  if (specialist) return (
    <PageShell>
      <PageHeader title="مشخصات محصولات" description="مشخصات ثبت‌شده در سامانهٔ تخصصی شعبهٔ فعال؛ این نما فقط‌خواندنی است." actions={<KnowledgeHelpButton section={specialist.industry} />} />
      <SpecialistAttributes industry={specialist.industry} />
    </PageShell>
  );
  const { canEdit, canManageStore } = await requireProductWorkspace();
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
      {canManageStore ? <WooAttributeMapping /> : null}
    </PageShell>
  );
}
