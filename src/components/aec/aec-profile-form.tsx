"use client";

/**
 * Issue #799 Wave 2 — the operating-profile form, used twice with one
 * implementation:
 *
 *   * the setup wizard's `aec_profile` step, where an AEC business makes its
 *     first choice (`capabilities={false}`: the profile's preset is the point,
 *     and twenty switches on the first screen would be noise);
 *   * «تنظیمات ← کسب‌وکار و شعبه», where the same business changes its mind and
 *     tunes the preset line by line.
 *
 * Labels and descriptions come from `@/lib/aec` — a pure module, so importing
 * it into a client component is the same pattern `workspace-shared.ts` sets
 * for the workspace forms. The API only carries what is *stored*.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AEC_CAPABILITY_KEYS,
  AEC_CAPABILITY_LABELS,
  AEC_LIVE_CAPABILITIES,
  AEC_OPERATING_PROFILE_DEFS,
  AEC_OPERATING_PROFILES,
  AEC_SPECIALTIES,
  AEC_SPECIALTY_LABELS,
  normalizeAecCapabilityOverrides,
  resolveAecCapabilities,
  type AecCapabilityKey,
  type AecOperatingProfile,
} from "@/lib/aec";
import { SectionCard, SectionCardSkeleton, cardClass } from "@/app/dashboard/page-chrome";
import { ErrorBox, api, errorMessage } from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";

interface ProfileResponse {
  profile?: {
    operatingProfile: AecOperatingProfile;
    specialties: string[];
    capabilityOverrides: Record<string, boolean>;
    stored: boolean;
  };
  error?: string;
}

const liveSet = new Set<AecCapabilityKey>(AEC_LIVE_CAPABILITIES);

export function AecProfileForm({
  capabilities = true,
  submitLabel = "ذخیرهٔ پروفایل",
  onSaved,
}: {
  /** Show the per-capability switches (settings does; the wizard does not). */
  capabilities?: boolean;
  submitLabel?: string;
  /** Called after a successful save — the wizard uses it to advance. */
  onSaved?: (profile: { operatingProfile: AecOperatingProfile }) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [profile, setProfile] = useState<AecOperatingProfile>("architecture_office");
  const [specialties, setSpecialties] = useState<Set<string>>(new Set());
  const [caps, setCaps] = useState<Record<string, boolean>>({});
  const [stored, setStored] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void api<ProfileResponse>("/api/aec/profile")
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (!ok || !data.profile) {
          setError("بارگذاری پروفایل کسب‌وکار ممکن نشد.");
          return;
        }
        setProfile(data.profile.operatingProfile);
        setSpecialties(new Set(data.profile.specialties));
        setCaps(
          Object.fromEntries(
            AEC_CAPABILITY_KEYS.map((key) => [key, resolveAecCapabilities({
              profile: data.profile!.operatingProfile,
              overrides: data.profile!.capabilityOverrides as Partial<Record<AecCapabilityKey, boolean>>,
            }).includes(key)]),
          ),
        );
        setStored(data.profile.stored);
      })
      .catch(() => {
        if (!cancelled) setError("بارگذاری پروفایل کسب‌وکار ممکن نشد.");
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Choosing a profile replaces the capability set with that profile's preset.
   * This is deliberate: an override is a *delta from the profile*, and keeping
   * yesterday's deltas under a new profile would apply a decision about a
   * different business shape. Anything the preset gets wrong is one click away
   * in the list below.
   */
  const chooseProfile = useCallback((next: AecOperatingProfile) => {
    setProfile(next);
    const preset = new Set(resolveAecCapabilities({ profile: next }));
    setCaps(Object.fromEntries(AEC_CAPABILITY_KEYS.map((key) => [key, preset.has(key)])));
    setDirty(true);
    setSaved(false);
  }, []);

  const toggleSpecialty = useCallback((key: string) => {
    setSpecialties((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setDirty(true);
    setSaved(false);
  }, []);

  const toggleCapability = useCallback((key: AecCapabilityKey) => {
    setCaps((current) => ({ ...current, [key]: !current[key] }));
    setDirty(true);
    setSaved(false);
  }, []);

  async function save() {
    setBusy(true);
    setError("");
    const overrides = normalizeAecCapabilityOverrides(caps, profile);
    const { ok, data } = await api<ProfileResponse>("/api/aec/profile", {
      method: "PUT",
      body: JSON.stringify({
        operatingProfile: profile,
        specialties: AEC_SPECIALTIES.filter((key) => specialties.has(key)),
        capabilityOverrides: overrides,
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
    onSaved?.({ operatingProfile: profile });
  }

  if (!loaded) {
    return (
      <div className="space-y-4">
        <SectionCardSkeleton />
        <SectionCardSkeleton />
      </div>
    );
  }

  const enabledCount = AEC_CAPABILITY_KEYS.filter((key) => caps[key]).length;

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <SectionCard
        title="پروفایل کسب‌وکار"
        description="شکل کار شما تعیین می‌کند چه بخش‌هایی از میز کار به‌صورت پیش‌فرض فعال باشد. این انتخاب صنعت شما را تغییر نمی‌دهد و هر زمان قابل تغییر است."
      >
        <fieldset>
          <legend className="sr-only">انتخاب پروفایل کسب‌وکار</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {AEC_OPERATING_PROFILES.map((key) => {
              const def = AEC_OPERATING_PROFILE_DEFS[key];
              const selected = key === profile;
              return (
                <label
                  key={key}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${
                    selected
                      ? "border-amber-500 bg-amber-50/60 dark:bg-amber-500/10"
                      : "border-border hover:border-amber-400 dark:hover:border-amber-400/70"
                  }`}
                >
                  <input
                    type="radio"
                    name="aec-operating-profile"
                    className="mt-1"
                    checked={selected}
                    onChange={() => chooseProfile(key)}
                  />
                  <span>
                    <span className="block font-semibold text-foreground">{def.label}</span>
                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                      {def.description}
                    </span>
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      {toPersianDigits(def.capabilities.length)} قابلیت پیش‌فرض
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {stored ? null : (
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            هنوز پروفایلی ذخیره نشده است؛ تا زمان ذخیره، پیش‌فرض‌های «دفتر معماری» به کار می‌رود.
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="تخصص‌ها"
        description="رشته‌هایی که در آن‌ها کار می‌کنید. فقط برای معرفی و جست‌وجو است و چیزی را محدود نمی‌کند."
      >
        <div className="flex flex-wrap gap-2">
          {AEC_SPECIALTIES.map((key) => {
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
                {AEC_SPECIALTY_LABELS[key]}
              </label>
            );
          })}
        </div>
      </SectionCard>

      {capabilities ? (
        <SectionCard
          title="قابلیت‌ها"
          description="پیش‌فرض پروفایل انتخاب‌شده؛ هر مورد را می‌توانید جداگانه روشن یا خاموش کنید. موردهایی که «به‌زودی» دارند در موج‌های بعدی همین محصول تکمیل می‌شوند."
        >
          <p className="mb-3 text-xs text-muted-foreground">
            {toPersianDigits(enabledCount)} قابلیت فعال از {toPersianDigits(AEC_CAPABILITY_KEYS.length)}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {AEC_CAPABILITY_KEYS.map((key) => (
              <label
                key={key}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm"
              >
                <span className="flex items-center gap-2">
                  <span className="text-foreground">{AEC_CAPABILITY_LABELS[key]}</span>
                  {liveSet.has(key) ? null : (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                      به‌زودی
                    </span>
                  )}
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={Boolean(caps[key])}
                  onChange={() => toggleCapability(key)}
                />
              </label>
            ))}
          </div>
        </SectionCard>
      ) : null}

      <div className={`flex flex-wrap items-center justify-between gap-3 ${cardClass} px-4 py-3`}>
        <Button type="button" size="lg" disabled={busy || !dirty} onClick={() => void save()} className="px-6 font-semibold">
          {busy ? "در حال ذخیره…" : submitLabel}
        </Button>
        <p className="min-w-0 text-xs leading-5 text-muted-foreground">
          {dirty ? "تغییرات ذخیره نشده است." : saved ? "ذخیره شد." : "همه‌چیز ذخیره شده است."}
        </p>
      </div>
    </div>
  );
}
