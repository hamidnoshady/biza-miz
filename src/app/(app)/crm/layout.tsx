import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CrmAppShell } from "./crm-app-shell";
import { canOpenCrm } from "./crm-routes";

/**
 * The CRM app's layout (Phase 36).
 *
 * The gate is here, server-side, so a member the app does not admit never
 * renders a single CRM screen — the per-page checks below it are the finer
 * cut (a cashier may open the directory but not the pipeline), not the door.
 *
 * It asks for effective permissions rather than a role, which is the same
 * question the CRM's routes ask. A role test here could admit someone every
 * fetch inside then refused, or lock out someone the API would have served.
 *
 * `canOpenCrm` is derived from the same `canViewCrmSection` the menu uses, so
 * "who is let in" and "what they see once inside" cannot disagree: anyone with
 * at least one visible section is admitted, and everyone else is not.
 */
export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  if (!canOpenCrm(permissions)) redirect("/dashboard");

  return <CrmAppShell permissions={[...permissions]}>{children}</CrmAppShell>;
}
