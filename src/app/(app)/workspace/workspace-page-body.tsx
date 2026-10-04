import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { WORKSPACE_MODULE_HOME } from "@/lib/app-routes";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { WorkspaceManager } from "./workspace-manager";
import { WorkspaceCommandBar } from "./workspace-command-bar";
import { WORKSPACE_SECTION_META, type WorkspaceSection } from "./workspace-routes";

/**
 * What every «میز کار من» URL renders.
 *
 * The module is one route per section (`/workspace/tasks`,
 * `/workspace/contracts` — see `app-routes.ts`), and all of them need the same
 * two reads before they can decide what to show: the session, and the member's
 * effective permissions. Keeping that here rather than in each page means a
 * new section cannot ship with a slightly different gate.
 *
 * The gate is the platform's, not a new one. `workspace.view` opens the
 * module; the three write permissions decide which buttons exist; and inside a
 * project the member's `workspace_members.role` narrows it further, enforced
 * server-side by `requireProjectCapability`. A section the member may not open
 * redirects to one they can rather than rendering an empty frame — and a
 * member with no workspace permission at all goes back to the dashboard, which
 * is where every other closed door in the product leads.
 */
export async function WorkspacePageBody({ section }: { section?: WorkspaceSection | null }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const member = await memberAccessFor(session);
  if (!member?.isActive) redirect("/dashboard");
  if (!member.permissions.has(PERMISSIONS.workspaceView)) redirect("/dashboard");

  const permissions = [...member.permissions] as string[];
  // «قالب‌ها» reshapes every project created afterwards, so it is the one
  // section a read-only member does not get; asking for it lands them on the
  // overview instead of on a 403.
  if (section && !member.permissions.has(WORKSPACE_SECTION_META[section].permission)) {
    redirect(WORKSPACE_MODULE_HOME);
  }

  const activeSection: WorkspaceSection = section ?? "overview";

  return (
    <PageShell className="max-w-[1500px]">
      <PageHeader
        title="میز کار من"
        description={
          <>
            {WORKSPACE_SECTION_META[activeSection].description}
            <span className="hidden sm:inline">
              {" "}
              پروژه‌ها، وظایف، اسناد و قراردادهای اجرایی، به‌هم‌پیوسته با مشتریان و حسابداری.
            </span>
          </>
        }
        actions={<KnowledgeHelpButton section="projects" />}
      />
      <WorkspaceCommandBar permissions={permissions} section={activeSection} />
      <WorkspaceManager activeSection={activeSection} permissions={permissions} />
    </PageShell>
  );
}
