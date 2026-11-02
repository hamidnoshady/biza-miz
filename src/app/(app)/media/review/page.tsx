import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { requireModuleForPage } from "@/lib/industry-guard";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { ReviewPanel } from "./review-panel";

/**
 * «بررسی کارفرما» — the agency's side of issue #1128 §E.
 *
 * The client-facing half shipped in #1182: the tables, the service, ten routes
 * and the public `/review/[token]` screen a client lands on. What was missing is
 * the door an agency actually walks through — without this page the only way to
 * put work in front of a client was a raw API call, which is not a product.
 *
 * Guards mirror `/media` exactly, because this is the same library seen from a
 * different angle: a session, an active member holding `media.view`, and the
 * `media` module. `media.manage` is read here only to decide what the screen
 * *offers*; it is not the gate. Every mutation re-checks the permission server
 * side in its own route, so hiding a button is convenience and never
 * authorization — the distinction the issue's non-goals insist on.
 *
 * Deliberately not industry-gated, matching decision 32: the Media Library is a
 * platform feature and the agency-specific part is only the nullable format
 * vocabulary. A jeweller sending a custom design proof to a customer for
 * approval is this feature exactly as much as an agency sending a campaign.
 */
export default async function MediaReviewPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const member = await memberAccessFor(session);
  if (!member?.isActive || !member.permissions.has("media.view")) redirect("/dashboard");
  await requireModuleForPage(session.businessId, "media");

  return (
    <PageShell>
      <PageHeader
        title="بررسی کارفرما"
        description="کار را در یک دور بررسی بفرستید، پیوند کوتاه‌مدت و محدود بسازید و تصمیم کارفرما را با سابقهٔ کامل ببینید. هر پیوند را می‌توانید لغو کنید و دسترسی‌اش ثبت می‌شود."
      />
      <ReviewPanel canManage={member.permissions.has("media.manage")} />
    </PageShell>
  );
}
