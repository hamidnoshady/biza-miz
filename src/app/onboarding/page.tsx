import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  ONBOARDING_COOKIE,
  readOnboardingIdentity,
} from "@/lib/iam/onboarding-session";
import { loadOnboardingState } from "@/lib/onboarding";
import { OnboardingWizard } from "./onboarding-wizard";

/**
 * ESH-202 / #1387 — the short, resumable business onboarding.
 *
 * The page keeps #1385's guard: the encrypted continuation cookie is resolved
 * against `platform_users` on every request, and a person who has since joined a
 * business is sent to the ordinary sign-in chooser rather than shown a draft
 * that could create a duplicate. The wizard itself collects only the approved
 * business information; provisioning happens on its explicit review step.
 */
export default async function OnboardingEntryPage() {
  const cookieStore = await cookies();
  const platformUserId = await readOnboardingIdentity(
    cookieStore.get(ONBOARDING_COOKIE)?.value,
  );
  if (!platformUserId) redirect("/login");

  const state = await loadOnboardingState(platformUserId);
  if (!state) redirect("/login");
  if (state.membershipsExist) redirect("/login");

  return <OnboardingWizard initialState={state} />;
}
