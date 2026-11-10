import { redirect } from "next/navigation";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { requireMember } from "@/lib/auth";
import { effectiveFeatures } from "@/lib/features";
import { PettyCashSection } from "../accounting/petty-cash-section";

/** Assigned custodians can use their own fund without general ledger access. */
export default async function PettyCashPage() {
  const { session, error } = await requireMember();
  if (error) redirect(error.status === 401 ? "/login" : "/dashboard");
  const features = await effectiveFeatures(session.businessId);
  if (!(features.ledger ?? true)) redirect("/dashboard");

  return (
    <PageShell>
      <PageHeader title="تنخواه‌گردان" description="رسید هزینه را ارسال کنید، گردش تنخواه را ببینید و وجه را شمارش کنید." />
      <PettyCashSection />
    </PageShell>
  );
}
