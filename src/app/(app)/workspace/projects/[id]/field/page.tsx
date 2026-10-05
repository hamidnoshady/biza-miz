import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { FieldScreen } from "./field-screen";

/**
 * `/workspace/projects/<id>/field` — «حالت کارگاه» (issue #799 §25).
 *
 * A page of its own rather than a tab: §25's users are on a phone in a site
 * office, and a route is something they can bookmark on the home screen, open
 * from the project's «حالت کارگاه» button, or paste into a message — none of
 * which a tab behind `useState` gives them. The screen itself is deliberately
 * thin and asks one API (`/api/aec/projects/<id>/field`) for the queues it
 * shows, so the phone is not a second, slower copy of the desktop.
 *
 * The gate is the module's usual two layers: the platform permission opens the
 * page, the project role is re-checked by the API that fills it in.
 */
export default async function WorkspaceProjectFieldPage({
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
    <PageShell className="max-w-2xl">
      <PageHeader
        title="حالت کارگاه"
        description="کارهای میدانی این پروژه روی موبایل: گزارش روزانه، عکس، نقص، بازرسی، پرسش فنی، چک‌لیست، وظیفه و تحویل مصالح."
      />
      <FieldScreen projectId={id} />
    </PageShell>
  );
}
