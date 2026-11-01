import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { WorkspaceCommandBar } from "../../workspace-command-bar";
import { ContractWorkspace } from "./contract-workspace";

/**
 * `/workspace/contracts/<id>` — one execution contract's document and signing
 * round (issue #908).
 *
 * The gate is the module's usual two layers, and this page deliberately reads
 * NOTHING itself: the detail component fetches the document, the signer list and
 * the caller's capabilities in one request, so the page cannot disagree with the
 * API about who may edit or send. A member without `workspace.contracts_manage`
 * still lands here and sees a read-only document — reading a contract they are
 * party to is not the same act as issuing one.
 */
export default async function ContractDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect("/login");

  const member = await memberAccessFor(session);
  if (!member?.isActive) redirect("/dashboard");
  if (!member.permissions.has(PERMISSIONS.workspaceView)) redirect("/dashboard");

  return (
    <PageShell className="max-w-[1500px]">
      <PageHeader
        title="سند قرارداد و امضای الکترونیکی"
        description="متن قرارداد را بسازید، متغیرها را به اطلاعات پروژه و طرف حساب وصل کنید، نسخهٔ ثابت بسازید و برای امضا بفرستید."
      />
      <WorkspaceCommandBar permissions={[...member.permissions]} />
      <ContractWorkspace contractId={id} />
    </PageShell>
  );
}
