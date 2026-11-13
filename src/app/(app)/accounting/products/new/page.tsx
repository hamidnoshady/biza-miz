import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { AutomotiveWorkspace } from "@/app/dashboard/automotive/automotive-workspace";
import { SpecialistProductCreate } from "@/app/dashboard/products/specialist-product-create";
import { ProductAddSection } from "@/app/dashboard/products/product-add-section";
import { automotiveCreateEntry, specialistCreateEntry, requireProductWorkspace } from "@/app/dashboard/products/workspace-context";

/** «افزودن محصول» — the tabbed product form with drafts and variant rows. */
export default async function ProductAddPage() {
  if (await automotiveCreateEntry()) return <AutomotiveWorkspace initialSection="acquire" />;
  const specialist = await specialistCreateEntry();
  if (specialist) return (
    <PageShell>
      <PageHeader title="افزودن محصول" description={specialist.industry === "jewelry" ? "ثبت قطعه با وزن و عیار در شعبهٔ فعال" : "ثبت مدل ساعت؛ دستگاه‌های دارای شماره سریال جداگانه ثبت می‌شوند."} />
      <SpecialistProductCreate key={`${specialist.industry}:${specialist.draftScope}`} {...specialist} />
    </PageShell>
  );
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
