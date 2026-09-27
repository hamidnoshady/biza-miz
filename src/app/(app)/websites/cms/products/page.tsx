import { CmsManagerShell } from "../cms-manager-shell";
import { CmsProductsSection } from "../cms-sections";

export default function CmsProductsPage() {
  return (
    <CmsManagerShell title="محصولات" description="کالاهای فروشگاه اینترنتی." assistantContext="محصولات فروشگاه سایت را بررسی کن.">
      <CmsProductsSection />
    </CmsManagerShell>
  );
}
