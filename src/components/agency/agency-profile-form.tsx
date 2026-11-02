"use client";

/**
 * Issue #1128 — the operating-profile picker for an advertising agency, in
 * «تنظیمات ← کسب‌وکار و شعبه».
 *
 * The issue allows two homes for this choice: a setup-wizard step, "only if
 * integrated into the wizard contract and readiness tests", or tenant settings.
 * This is the settings half, and the wizard is deliberately left alone: the
 * agency's `SETUP_SHAPE` is `service` (`wizard-steps.ts`), whose seven steps are
 * the contract `setup-readiness.ts` and `src/app/setup/steps.test.ts` assert for
 * every service trade, and adding an eighth step for one industry would either
 * fork that shape or make a step required that a freelancer should be able to
 * skip. AEC's `aec_profile` step exists because AEC's nineteen capabilities have
 * to be chosen before its screens make sense; an agency's eight presets only
 * reorder seven blueprints, which is a decision an owner can make after the
 * first project rather than during onboarding.
 *
 * Labels and descriptions come from `@/lib/agency` — a pure module, so a client
 * component imports it directly and the API carries only what is stored, the
 * same split `AecProfileForm` uses.
 *
 * What the copy says out loud, because the issue is emphatic about it: this
 * choice grants nothing. It decides which project blueprints are listed first
 * and badged «پیشنهادی»; every screen a member can open is still decided by
 * their role and permissions.
 */
import { useCallback, useEffect, useState } from "react";
import { SectionCard, SectionCardSkeleton, cardClass } from "@/app/dashboard/page-chrome";
import { ErrorBox, api, errorMessage } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import {
  AGENCY_DEFAULT_OPERATING_PROFILE,
  AGENCY_OPERATING_PROFILES,
  AGENCY_OPERATING_PROFILE_DEFS,
  agencyOperatingProfileOptions,
  type AgencyOperatingProfile,
} from "@/lib/agency";

interface ProfileResponse {
  profile?: {
    operatingProfile: AgencyOperatingProfile;
    specialties: AgencyOperatingProfile[];
    stored: boolean;
    updatedAt: string | null;
  };
  error?: string;
}

const OPTIONS = agencyOperatingProfileOptions();

export function AgencyProfileForm() {
  const [loaded, setLoaded] = useState(false);
  const [profile, setProfile] = useState<AgencyOperatingProfile>(AGENCY_DEFAULT_OPERATING_PROFILE);
  const [specialties, setSpecialties] = useState<Set<AgencyOperatingProfile>>(new Set());
  const [stored, setStored] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api<ProfileResponse>("/api/settings/agency-profile")
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (!ok || !data.profile) {
          setError("بارگذاری پروفایل کسب‌وکار ممکن نشد.");
          // Saving a default over a profile that only *failed to load* would
          // silently reset a real choice, so the form refuses to save until a
          // reload succeeds.
          setLoadFailed(true);
          return;
        }
        setProfile(data.profile.operatingProfile);
        setSpecialties(new Set(data.profile.specialties));
        setStored(data.profile.stored);
      })
      .catch(() => {
        if (cancelled) return;
        setError("بارگذاری پروفایل کسب‌وکار ممکن نشد.");
        setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const chooseProfile = useCallback((next: AgencyOperatingProfile) => {
    setProfile(next);
    // The primary shape cannot also be a secondary one; dropping it here keeps
    // the two lists from disagreeing without the owner having to notice.
    setSpecialties((current) => {
      if (!current.has(next)) return current;
      const without = new Set(current);
      without.delete(next);
      return without;
    });
    setDirty(true);
    setSaved(false);
  }, []);

  const toggleSpecialty = useCallback((key: AgencyOperatingProfile) => {
    setSpecialties((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setDirty(true);
    setSaved(false);
  }, []);

  async function save() {
    setBusy(true);
    setError("");
    const { ok, data } = await api<ProfileResponse>("/api/settings/agency-profile", {
      method: "PUT",
      body: JSON.stringify({
        operatingProfile: profile,
        specialties: AGENCY_OPERATING_PROFILES.filter(
          (key) => key !== profile && specialties.has(key),
        ),
      }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setStored(true);
    setDirty(false);
    setSaved(true);
  }

  if (!loaded) {
    return (
      <div className="space-y-4">
        <SectionCardSkeleton />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <SectionCard
        title="پروفایل فعالیت آژانس"
        description="شکل کار آژانس شما تعیین می‌کند کدام قالب‌های پروژه در میز کار با نشان «پیشنهادی» و زودتر فهرست شوند. این انتخاب دسترسی‌ها را تغییر نمی‌دهد، صنعت کسب‌وکار را عوض نمی‌کند و هر زمان قابل تغییر است."
      >
        <fieldset>
          <legend className="sr-only">انتخاب پروفایل فعالیت آژانس</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {OPTIONS.map((def) => {
              const selected = def.key === profile;
              return (
                <label
                  key={def.key}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${
                    selected
                      ? "border-amber-500 bg-amber-50/60 dark:bg-amber-500/10"
                      : "border-border hover:border-amber-400 dark:hover:border-amber-400/70"
                  }`}
                >
                  <input
                    type="radio"
                    name="agency-operating-profile"
                    className="mt-1"
                    checked={selected}
                    onChange={() => chooseProfile(def.key)}
                  />
                  <span>
                    <span className="block font-semibold text-foreground">{def.label}</span>
                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                      {def.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {stored ? null : (
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            هنوز پروفایلی ذخیره نشده است؛ تا زمان ذخیره، پیش‌فرض «
            {AGENCY_OPERATING_PROFILE_DEFS[AGENCY_DEFAULT_OPERATING_PROFILE].label}» به کار می‌رود.
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="زمینه‌های دیگر فعالیت"
        description="کارهایی که علاوه بر پروفایل اصلی انجام می‌دهید. فقط برای معرفی است و هیچ قالب، صفحه یا دسترسی‌ای را محدود نمی‌کند."
      >
        <div className="flex flex-wrap gap-2">
          {AGENCY_OPERATING_PROFILES.filter((key) => key !== profile).map((key) => {
            const selected = specialties.has(key);
            return (
              <label
                key={key}
                className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition ${
                  selected
                    ? "border-amber-500 bg-amber-50/60 text-foreground dark:bg-amber-500/10"
                    : "border-border text-muted-foreground hover:border-amber-400 dark:hover:border-amber-400/70"
                }`}
              >
                <input type="checkbox" checked={selected} onChange={() => toggleSpecialty(key)} />
                {AGENCY_OPERATING_PROFILE_DEFS[key].label}
              </label>
            );
          })}
        </div>
      </SectionCard>

      <div className={`flex flex-wrap items-center justify-between gap-3 ${cardClass} px-4 py-3`}>
        <Button
          type="button"
          size="lg"
          disabled={busy || loadFailed || !dirty}
          onClick={() => void save()}
          className="px-6 font-semibold"
        >
          {busy ? "در حال ذخیره…" : "ذخیرهٔ پروفایل"}
        </Button>
        <p className="min-w-0 text-xs leading-5 text-muted-foreground">
          {loadFailed
            ? "بارگذاری پروفایل ممکن نشد؛ برای جلوگیری از بازنشانی ناخواسته، ذخیره غیرفعال است. صفحه را تازه کنید."
            : saved
              ? "پروفایل ذخیره شد. ترتیب قالب‌های پروژه در میز کار به‌روزرسانی شد."
              : "پروفایل فقط ترتیب و نشان «پیشنهادی» قالب‌های پروژه را عوض می‌کند."}
        </p>
      </div>
    </div>
  );
}
