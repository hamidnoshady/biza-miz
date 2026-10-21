import { featureLockedForPage } from "@/lib/features";
import { FeatureLock } from "@/components/feature-lock";
import { WpManagerShell } from "./wp-app-shell";
import { requireWpSection, wpSectionCaps } from "./wp-guard";

/**
 * The WordPress & WooCommerce manager's layout — one of the two managers
 * inside «مدیریت وب‌سایت».
 *
 * The app boundary (role, sidebar) is the parent's; what belongs here is the
 * half of the app that is *entitlement-gated*. The `integrations` flag is
 * applied at this manager's boundary only, as a locked preview: a business
 * without the add-on still opens the app and still runs the platform site it
 * pays for — it is the WordPress half that becomes an inert product preview
 * until the entitlement is granted. The child panels also skip their API
 * calls in that state.
 */
export default async function WpManagerLayout({ children }: { children: React.ReactNode }) {
  const session = await requireWpSection("overview");
  const caps = await wpSectionCaps(session);
  const locked = await featureLockedForPage(session.businessId, "integrations");

  return (
    <FeatureLock locked={locked} title="مدیریت وردپرس و ووکامرس">
      <WpManagerShell caps={caps}>{children}</WpManagerShell>
    </FeatureLock>
  );
}
