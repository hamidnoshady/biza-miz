import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { PageShell } from "@/app/dashboard/page-chrome";
import { ContractDocumentSheet } from "@/components/contracts/contract-document-sheet";
import {
  getContractDocument,
  getFrozenVersion,
  listContractDocumentVersions,
  loadContractBindingContext,
  contractFormatters,
} from "@/lib/contracts/service";
import { resolveBindings } from "@/lib/contracts/bindings";
import { resolveBusinessMoneyUnit } from "@/lib/ai-money-unit";
import { resolveWorkspaceSubject } from "@/lib/workspace";
import { getContract } from "@/lib/workspace";
import { workspaceAccessFlags } from "@/lib/workspace-shared";
import { PrintToolbar } from "./print-toolbar";

/**
 * `/workspace/contracts/<id>/print` — the print/PDF view of a contract.
 *
 * It shows the newest FROZEN version when one exists (that is the text anybody
 * signed or will sign) and the live draft otherwise, with unresolved variables
 * marked. Authorisation is the same pair the detail page uses: `workspace.view`
 * on the module and `view` on the contract as a subject, so a print view can
 * never be the way around the contract's own permission.
 */
export default async function ContractPrintPage({
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

  const owner = {
    businessId: session.businessId,
    actorUserId: session.sub,
    actorName: session.fullName ?? "",
    access: workspaceAccessFlags(member.permissions),
  };

  try {
    await resolveWorkspaceSubject(owner, "contract", id, "view");
  } catch {
    notFound();
  }

  const contract = await getContract(owner.businessId, id);
  if (!contract) notFound();

  const versions = await listContractDocumentVersions(owner.businessId, id);
  const latest = versions[0] ? await getFrozenVersion(owner.businessId, id, versions[0].id) : null;
  const document = await getContractDocument(owner.businessId, id);

  const content = latest?.content ?? document?.content ?? null;
  let values: Record<string, string> = latest?.content.values ?? {};
  if (!latest && content) {
    const [context, unit] = await Promise.all([
      loadContractBindingContext(owner, contract),
      resolveBusinessMoneyUnit(owner.businessId),
    ]);
    // The business's own display unit, the same one the editor and the frozen
    // snapshot used — a print view with a different unit would be a different
    // number on the same contract.
    values = resolveBindings(content, context, contractFormatters(unit)).values;
  }
  if (!content) notFound();

  return (
    <PageShell className="max-w-[900px]">
      <PrintToolbar title={content.title} />
      <ContractDocumentSheet content={content} values={values} markUnresolved={!latest} />
      {latest ? (
        <p className="mt-3 text-center text-[11px] text-muted-foreground">
          نسخهٔ ثابت v{latest.version} — اثر انگشت محتوا:{" "}
          <span dir="ltr" className="font-mono">
            {latest.contentHash.slice(0, 16)}…
          </span>
        </p>
      ) : (
        <p className="mt-3 text-center text-[11px] text-muted-foreground">
          این پیش‌نمایش از پیش‌نویس ساخته شده است؛ نسخهٔ ثابتی وجود ندارد.
        </p>
      )}
    </PageShell>
  );
}
