import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { ProjectDetail } from "./project-detail";

/**
 * `/workspace/projects/<id>` — one project's page, and the address every old
 * `/projects/<id>` bookmark lands on through the middleware redirect.
 *
 * The gate is the same two-layer one the rest of the module uses: the platform
 * permission opens the page, and which buttons exist comes from the API's
 * `capabilities` (platform permission AND `workspace_members.role`), which
 * every API call the page makes re-checks. This
 * page deliberately does not read the project server-side — the detail
 * component does it in one request that also brings phases, members, activity
 * and the caller's project role, so the page cannot disagree with the API
 * about who may do what.
 */
export default async function WorkspaceProjectPage({
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
        title="پروندهٔ پروژه"
        description="وظایف، اسناد، قراردادهای اجرایی، تیم، تأییدها و تقویم این پروژه — و پنل‌های دستیار هوش مصنوعی همان پروژه."
        actions={<KnowledgeHelpButton section="projects" />}
      />
      <ProjectDetail projectId={id} />
    </PageShell>
  );
}
