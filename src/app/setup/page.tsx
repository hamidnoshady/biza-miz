import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { computeSetupState, isSetupComplete } from "@/lib/setup-state";
import { stepsFor } from "./steps";

/** /setup → jump to the first incomplete step (or the finish page). */
export default async function SetupIndex() {
  const session = await getSession();
  if (!session) redirect("/login");

  if (await isSetupComplete(session.businessId)) redirect("/settings");

  const state = await computeSetupState(session.businessId);
  const industry = state.business?.industry ?? "food_service";
  // Skip the accounting steps when the owner did not select Accounting; an
  // explicit zero-app choice must not be sent through a chart of accounts.
  const firstIncomplete = stepsFor(industry, state.selectedApps).find(
    (s) => !state.progress.steps[s.id],
  );
  redirect(firstIncomplete ? firstIncomplete.path : "/setup/finish");
}
