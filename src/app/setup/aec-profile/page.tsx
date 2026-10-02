"use client";

/**
 * Issue #799 Wave 2 — the AEC setup step. One question: what shape of AEC
 * business is this? The answer seeds the capability presets every later wave
 * reads (§2 of the issue).
 *
 * The step only exists for `architecture_construction` businesses
 * (`wizardStepsForIndustry`), so a stale link or the back button from another
 * trade lands on whatever step follows it — the same `skipToPath` pattern the
 * F&B-only costing and menu steps use. It is optional (`OPTIONAL_STEPS`):
 * skipping keeps the default preset, and the choice stays editable in
 * «تنظیمات ← کسب‌وکار و شعبه».
 */
import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { StepShell, api, SetupDataSkeleton } from "../ui";
import { nextPath, skipToPath, stepsFor } from "../steps";
import { useSetupIndustry } from "../industry-context";
import { AecProfileForm } from "@/components/aec/aec-profile-form";
import type { WizardStep } from "@/lib/wizard-steps";

export default function AecProfileStep() {
  const router = useRouter();
  const industry = useSetupIndustry();
  const steps = useMemo(() => stepsFor(industry), [industry]);
  const available = steps.some((step) => step.id === "aec_profile");

  useEffect(() => {
    if (!available) router.replace(skipToPath("aec_profile", steps));
  }, [available, router, steps]);

  if (!available) return <SetupDataSkeleton rows={4} />;

  return (
    <StepShell
      step="aec_profile"
      description="پروفایل کسب‌وکارتان را انتخاب کنید تا بخش‌های مناسب کار شما از ابتدا فعال باشد. این انتخاب صنعت شما را تغییر نمی‌دهد و بعداً در تنظیمات قابل تغییر است."
      showSkip
    >
      <AecProfileForm
        capabilities={false}
        submitLabel="ذخیره و ادامه"
        onSaved={() => {
          // Mark the optional step in the wizard's own progress, then move on.
          // The profile itself is already saved by the form's PUT; this only
          // keeps the step list's done-state honest.
          void api("/api/setup/progress", {
            method: "POST",
            body: JSON.stringify({ step: "aec_profile" }),
          }).finally(() => router.push(nextPath("aec_profile", steps)));
        }}
      />
    </StepShell>
  );
}
