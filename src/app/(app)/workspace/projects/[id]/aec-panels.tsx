"use client";

/**
 * Issue #799 §5 and §6 on screen — the two AEC tabs a project gains:
 * «شناسنامهٔ پروژه» (the AEC project profile) and «طرف‌های پروژه» (the external
 * participants).
 *
 * Both are mounted by the project page only for an AEC tenant
 * (`aecProjectTabs`), and both talk to the `/api/aec/projects/**` routes, which
 * is where §5's and §6's real rules live: the profile keeps `ai_projects`
 * canonical and its AEC metadata in an extension table, and a participant is a
 * directory record — never a user, never a membership, never a permission.
 *
 * What this file adds on top of that is presentation the issue asks for by
 * name: **Gregorian in the database, Shamsi on every screen** (every date goes
 * through `DateField` → `JalaliDatePicker` and `DateCell` → `formatJalali`),
 * **planned vs reported physical progress side by side** (the two columns §5
 * insists on, with the gap named), and a role picker that offers exactly the
 * roles the operating profile allows — the list the API enforces, so the form
 * can never propose a role that will be refused.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClipboardListIcon,
  MapPinIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import {
  EmptyState,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
  overlayPanelClass,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { toPersianDigits } from "@/lib/digits";
import type { WorkspaceLookups } from "../../use-workspace-lookups";
import { DateCell, DateField, PickerField, ProgressBar, workspaceError } from "../../workspace-ui";

/* ---------------------------------------------------------------------------
 * Types — the wire shapes of `/api/aec/projects/[id]/**`
 * ------------------------------------------------------------------------- */

interface AecProjectProfile {
  projectId: string;
  projectNumber: string | null;
  projectCategory: string | null;
  siteName: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  latitude: string | null;
  longitude: string | null;
  landArea: string | null;
  builtArea: string | null;
  floorCount: number | null;
  employerPartyId: string | null;
  employerPartyName: string | null;
  leadConsultantPartyId: string | null;
  leadConsultantPartyName: string | null;
  mainContractorPartyId: string | null;
  mainContractorPartyName: string | null;
  projectManagerUserId: string | null;
  projectManagerName: string | null;
  contractMethod: string | null;
  deliveryMethod: string | null;
  permitNumbers: string[];
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  plannedPhysicalProgress: string | null;
  reportedPhysicalProgress: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

interface Participant {
  id: string;
  partyId: string;
  partyName: string;
  partyRole: string;
  role: string;
  contactName: string | null;
  notes: string;
  startedAt: string | null;
  endedAt: string | null;
}

/* ---------------------------------------------------------------------------
 * The project's AEC profile (§5)
 * ------------------------------------------------------------------------- */

/** The editable fields, all as text: the API parses numbers, dates and uuids. */
interface ProfileForm {
  projectNumber: string;
  projectCategory: string;
  siteName: string;
  address: string;
  city: string;
  region: string;
  latitude: string;
  longitude: string;
  landArea: string;
  builtArea: string;
  floorCount: string;
  employerPartyId: string;
  leadConsultantPartyId: string;
  mainContractorPartyId: string;
  projectManagerUserId: string;
  contractMethod: string;
  deliveryMethod: string;
  permitNumbers: string;
  plannedStartDate: string;
  plannedEndDate: string;
  actualStartDate: string;
  actualEndDate: string;
  plannedPhysicalProgress: string;
  reportedPhysicalProgress: string;
  notes: string;
}

const EMPTY_FORM: ProfileForm = {
  projectNumber: "", projectCategory: "", siteName: "", address: "", city: "", region: "",
  latitude: "", longitude: "", landArea: "", builtArea: "", floorCount: "",
  employerPartyId: "", leadConsultantPartyId: "", mainContractorPartyId: "", projectManagerUserId: "",
  contractMethod: "", deliveryMethod: "", permitNumbers: "",
  plannedStartDate: "", plannedEndDate: "", actualStartDate: "", actualEndDate: "",
  plannedPhysicalProgress: "", reportedPhysicalProgress: "", notes: "",
};

function formFrom(profile: AecProjectProfile | null): ProfileForm {
  if (!profile) return { ...EMPTY_FORM };
  return {
    projectNumber: profile.projectNumber ?? "",
    projectCategory: profile.projectCategory ?? "",
    siteName: profile.siteName ?? "",
    address: profile.address ?? "",
    city: profile.city ?? "",
    region: profile.region ?? "",
    latitude: profile.latitude ?? "",
    longitude: profile.longitude ?? "",
    landArea: profile.landArea ?? "",
    builtArea: profile.builtArea ?? "",
    floorCount: profile.floorCount === null ? "" : String(profile.floorCount),
    employerPartyId: profile.employerPartyId ?? "",
    leadConsultantPartyId: profile.leadConsultantPartyId ?? "",
    mainContractorPartyId: profile.mainContractorPartyId ?? "",
    projectManagerUserId: profile.projectManagerUserId ?? "",
    contractMethod: profile.contractMethod ?? "",
    deliveryMethod: profile.deliveryMethod ?? "",
    permitNumbers: profile.permitNumbers.join("، "),
    plannedStartDate: profile.plannedStartDate ?? "",
    plannedEndDate: profile.plannedEndDate ?? "",
    actualStartDate: profile.actualStartDate ?? "",
    actualEndDate: profile.actualEndDate ?? "",
    plannedPhysicalProgress: profile.plannedPhysicalProgress ?? "",
    reportedPhysicalProgress: profile.reportedPhysicalProgress ?? "",
    notes: profile.notes,
  };
}

/** `""` is how the form says "no value"; the API clears the column for null. */
function orNull(value: string): string | null {
  return value.trim() ? value.trim() : null;
}

function bodyFrom(form: ProfileForm): Record<string, unknown> {
  return {
    projectNumber: orNull(form.projectNumber),
    projectCategory: orNull(form.projectCategory),
    siteName: orNull(form.siteName),
    address: orNull(form.address),
    city: orNull(form.city),
    region: orNull(form.region),
    latitude: orNull(form.latitude),
    longitude: orNull(form.longitude),
    landArea: orNull(form.landArea),
    builtArea: orNull(form.builtArea),
    floorCount: orNull(form.floorCount),
    employerPartyId: orNull(form.employerPartyId),
    leadConsultantPartyId: orNull(form.leadConsultantPartyId),
    mainContractorPartyId: orNull(form.mainContractorPartyId),
    projectManagerUserId: orNull(form.projectManagerUserId),
    contractMethod: orNull(form.contractMethod),
    deliveryMethod: orNull(form.deliveryMethod),
    permitNumbers: form.permitNumbers
      .split(/[،,\n]/)
      .map((value) => value.trim())
      .filter(Boolean),
    plannedStartDate: orNull(form.plannedStartDate),
    plannedEndDate: orNull(form.plannedEndDate),
    actualStartDate: orNull(form.actualStartDate),
    actualEndDate: orNull(form.actualEndDate),
    plannedPhysicalProgress: orNull(form.plannedPhysicalProgress),
    reportedPhysicalProgress: orNull(form.reportedPhysicalProgress),
    notes: form.notes.trim(),
  };
}

/**
 * The AEC record of one project.
 *
 * Rendered inside the project's «شناسنامهٔ پروژه» tab, under the generic record:
 * the workspace's own facts (customer, dates, tags, phases) stay where they
 * were and this adds the industry's — site, areas, the three contract parties,
 * permits and the planned-versus-reported progress pair.
 */
export function AecProjectProfileCard({
  projectId,
  canManage,
  lookups,
}: {
  projectId: string;
  canManage: boolean;
  lookups: WorkspaceLookups;
}) {
  const [profile, setProfile] = useState<AecProjectProfile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<{ profile: AecProjectProfile | null }>(`/api/aec/projects/${projectId}/profile`).then(
      ({ ok, data }) => {
        setLoaded(true);
        if (ok) setProfile(data.profile);
        else setError(workspaceError((data as unknown as { error?: string }).error));
      },
    );
  }, [projectId]);

  useEffect(load, [load]);

  if (!loaded) return <SectionCardSkeleton rows={4} />;

  return (
    <div className="flex flex-col gap-3">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      {profile === null ? (
        <SectionCard title="شناسنامهٔ عمرانی پروژه">
          {canManage ? (
            <EmptyState
              icon={MapPinIcon}
              title="شناسنامهٔ عمرانی ثبت نشده است"
              action={
                <PrimaryButton onClick={() => setEditing(true)}>
                  <PlusIcon className="size-4" aria-hidden />
                  تکمیل شناسنامه
                </PrimaryButton>
              }
            >
              شمارهٔ پروژه، کارگاه، متراژ، طرف‌های قرارداد، مجوزها و پیشرفت فیزیکی اینجا ثبت می‌شود.
            </EmptyState>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">
              شناسنامهٔ عمرانی این پروژه هنوز ثبت نشده است.
            </p>
          )}
        </SectionCard>
      ) : (
        <SectionCard
          title="شناسنامهٔ عمرانی پروژه"
          description="اطلاعات اجرایی و قراردادی این پروژه — جدا از پروندهٔ عمومی میز کار."
          actions={
            canManage ? (
              <SecondaryButton onClick={() => setEditing(true)}>
                <PencilIcon className="size-4" aria-hidden />
                ویرایش
              </SecondaryButton>
            ) : null
          }
        >
          <dl className="grid gap-3 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="شمارهٔ پروژه" value={profile.projectNumber} />
            <Fact label="دستهٔ پروژه" value={profile.projectCategory} />
            <Fact label="کارگاه" value={profile.siteName} />
            <Fact label="نشانی" value={profile.address} span />
            <Fact label="شهر" value={profile.city} />
            <Fact label="منطقه" value={profile.region} />
            <Fact
              label="مختصات"
              value={
                profile.latitude && profile.longitude
                  ? `${toPersianDigits(profile.latitude)} / ${toPersianDigits(profile.longitude)}`
                  : null
              }
            />
            <Fact label="مساحت زمین" value={profile.landArea ? `${toPersianDigits(profile.landArea)} م²` : null} />
            <Fact label="مساحت زیربنا" value={profile.builtArea ? `${toPersianDigits(profile.builtArea)} م²` : null} />
            <Fact
              label="تعداد طبقات"
              value={profile.floorCount === null ? null : toPersianDigits(String(profile.floorCount))}
            />
            <Fact label="کارفرما" value={profile.employerPartyName} />
            <Fact label="مشاور / طراح" value={profile.leadConsultantPartyName} />
            <Fact label="پیمانکار اصلی" value={profile.mainContractorPartyName} />
            <Fact label="مدیر پروژه" value={profile.projectManagerName} />
            <Fact label="روش قرارداد" value={profile.contractMethod} />
            <Fact label="روش تحویل" value={profile.deliveryMethod} />
            <Fact
              label="مجوزها"
              value={profile.permitNumbers.length ? profile.permitNumbers.join("، ") : null}
              span
            />
            <Fact label="شروع برنامه‌ای" value={<DateCell date={profile.plannedStartDate} relative={false} />} />
            <Fact label="پایان برنامه‌ای" value={<DateCell date={profile.plannedEndDate} relative={false} />} />
            <Fact label="شروع واقعی" value={<DateCell date={profile.actualStartDate} relative={false} />} />
            <Fact label="پایان واقعی" value={<DateCell date={profile.actualEndDate} relative={false} />} />

            {/*
              §5's two progress columns, shown as the pair they are: what the
              plan says and what the site reported. The gap is the useful
              number — a project can be on time and behind at once.
            */}
            <div className="sm:col-span-2 lg:col-span-3">
              <dt className="text-xs text-muted-foreground">پیشرفت فیزیکی</dt>
              <dd className="mt-2 flex flex-col gap-2">
                <ProgressBar
                  percent={Number(profile.plannedPhysicalProgress ?? 0)}
                  label={`پیشرفت برنامه‌ای ${profile.projectNumber ?? ""}`}
                />
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>برنامه‌ای: {percentText(profile.plannedPhysicalProgress)}</span>
                  <span aria-hidden>•</span>
                  <span>گزارش‌شده: {percentText(profile.reportedPhysicalProgress)}</span>
                  {progressGap(profile) === null ? null : (
                    <StatusBadge tone={progressGap(profile)! < 0 ? "danger" : "positive"}>
                      {progressGap(profile)! < 0
                        ? `${toPersianDigits(String(Math.abs(progressGap(profile)!)))}٪ عقب‌تر از برنامه`
                        : `${toPersianDigits(String(progressGap(profile)!))}٪ جلوتر از برنامه`}
                    </StatusBadge>
                  )}
                </div>
                <ProgressBar
                  percent={Number(profile.reportedPhysicalProgress ?? 0)}
                  label={`پیشرفت گزارش‌شده ${profile.projectNumber ?? ""}`}
                />
              </dd>
            </div>

            {profile.notes ? <Fact label="یادداشت" value={profile.notes} span /> : null}
          </dl>
        </SectionCard>
      )}

      {editing ? (
        <AecProfileDialog
          projectId={projectId}
          lookups={lookups}
          profile={profile}
          onClose={() => setEditing(false)}
          onSaved={(next) => {
            setProfile(next);
            setEditing(false);
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

/** The rounded gap between reported and planned progress, or null when either is unknown. */
function progressGap(profile: AecProjectProfile): number | null {
  if (profile.plannedPhysicalProgress === null || profile.reportedPhysicalProgress === null) return null;
  return Math.round((Number(profile.reportedPhysicalProgress) - Number(profile.plannedPhysicalProgress)) * 10) / 10;
}

function percentText(value: string | null): string {
  return value === null ? "—" : `${toPersianDigits(value)}٪`;
}

function Fact({ label, value, span }: { label: string; value: React.ReactNode; span?: boolean }) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div className={span ? "sm:col-span-2 lg:col-span-3" : undefined}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{empty ? <span className="text-muted-foreground">—</span> : value}</dd>
    </div>
  );
}

function AecProfileDialog({
  projectId,
  lookups,
  profile,
  onClose,
  onSaved,
  onError,
}: {
  projectId: string;
  lookups: WorkspaceLookups;
  profile: AecProjectProfile | null;
  onClose: () => void;
  onSaved: (profile: AecProjectProfile) => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState<ProfileForm>(() => formFrom(profile));
  const [saving, setSaving] = useState(false);

  const set = (key: keyof ProfileForm) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function submit() {
    if (saving) return;
    setSaving(true);
    const { ok, data } = await api<{ profile: AecProjectProfile }>(
      `/api/aec/projects/${projectId}/profile`,
      { method: "PUT", body: JSON.stringify(bodyFrom(form)) },
    );
    setSaving(false);
    if (ok) onSaved(data.profile);
    else onError(workspaceError((data as unknown as { error?: string }).error));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-3xl`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">شناسنامهٔ عمرانی پروژه</h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>

        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="شمارهٔ پروژه">
            <input className={inputClass} value={form.projectNumber} onChange={(e) => set("projectNumber")(e.target.value)} />
          </Field>
          <Field label="دستهٔ پروژه" hint="مسکونی، تجاری، صنعتی، عمومی…">
            <input className={inputClass} value={form.projectCategory} onChange={(e) => set("projectCategory")(e.target.value)} />
          </Field>
          <Field label="کارگاه">
            <input className={inputClass} value={form.siteName} onChange={(e) => set("siteName")(e.target.value)} />
          </Field>

          <Field label="شهر">
            <input className={inputClass} value={form.city} onChange={(e) => set("city")(e.target.value)} />
          </Field>
          <Field label="منطقه">
            <input className={inputClass} value={form.region} onChange={(e) => set("region")(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="عرض جغرافیایی">
              <PersianNumberInput
                className={inputClass}
                allowNegative
                allowDecimal
                step="any"
                value={form.latitude}
                onChange={(e) => set("latitude")(e.target.value)}
              />
            </Field>
            <Field label="طول جغرافیایی">
              <PersianNumberInput
                className={inputClass}
                allowNegative
                allowDecimal
                step="any"
                value={form.longitude}
                onChange={(e) => set("longitude")(e.target.value)}
              />
            </Field>
          </div>

          <div className="sm:col-span-2 lg:col-span-3">
            <Field label="نشانی">
              <input className={inputClass} value={form.address} onChange={(e) => set("address")(e.target.value)} />
            </Field>
          </div>

          <Field label="مساحت زمین (م²)">
            <PersianNumberInput className={inputClass} allowDecimal value={form.landArea} onChange={(e) => set("landArea")(e.target.value)} />
          </Field>
          <Field label="مساحت زیربنا (م²)">
            <PersianNumberInput className={inputClass} allowDecimal value={form.builtArea} onChange={(e) => set("builtArea")(e.target.value)} />
          </Field>
          <Field label="تعداد طبقات">
            <PersianNumberInput className={inputClass} value={form.floorCount} onChange={(e) => set("floorCount")(e.target.value)} />
          </Field>

          <PickerField
            label="کارفرما"
            value={form.employerPartyId}
            onChange={set("employerPartyId")}
            options={lookups.parties.map((party) => ({ id: party.id, label: party.name }))}
          />
          <PickerField
            label="مشاور / طراح"
            value={form.leadConsultantPartyId}
            onChange={set("leadConsultantPartyId")}
            options={lookups.parties.map((party) => ({ id: party.id, label: party.name }))}
          />
          <PickerField
            label="پیمانکار اصلی"
            value={form.mainContractorPartyId}
            onChange={set("mainContractorPartyId")}
            options={lookups.parties.map((party) => ({ id: party.id, label: party.name }))}
          />
          <PickerField
            label="مدیر پروژه"
            hint="از میان اعضای کسب‌وکار"
            value={form.projectManagerUserId}
            onChange={set("projectManagerUserId")}
            options={lookups.members.map((member) => ({ id: member.id, label: member.fullName }))}
          />
          <Field label="روش قرارداد" hint="مقطوع، امانی، فهرست بها…">
            <input className={inputClass} value={form.contractMethod} onChange={(e) => set("contractMethod")(e.target.value)} />
          </Field>
          <Field label="روش تحویل">
            <input className={inputClass} value={form.deliveryMethod} onChange={(e) => set("deliveryMethod")(e.target.value)} />
          </Field>

          <div className="sm:col-span-2 lg:col-span-3">
            <Field label="مجوزها" hint="با ویرگول جدا کنید">
              <input className={inputClass} value={form.permitNumbers} onChange={(e) => set("permitNumbers")(e.target.value)} />
            </Field>
          </div>

          <DateField label="شروع برنامه‌ای" value={form.plannedStartDate} onChange={set("plannedStartDate")} />
          <DateField label="پایان برنامه‌ای" value={form.plannedEndDate} onChange={set("plannedEndDate")} />
          <div className="hidden lg:block" aria-hidden />
          <DateField label="شروع واقعی" value={form.actualStartDate} onChange={set("actualStartDate")} />
          <DateField label="پایان واقعی" value={form.actualEndDate} onChange={set("actualEndDate")} />
          <div className="hidden lg:block" aria-hidden />

          <Field label="پیشرفت برنامه‌ای (٪)">
            <PersianNumberInput
              className={inputClass}
              allowDecimal
              value={form.plannedPhysicalProgress}
              onChange={(e) => set("plannedPhysicalProgress")(e.target.value)}
            />
          </Field>
          <Field label="پیشرفت گزارش‌شده (٪)" hint="آنچه کارگاه گزارش می‌کند">
            <PersianNumberInput
              className={inputClass}
              allowDecimal
              value={form.reportedPhysicalProgress}
              onChange={(e) => set("reportedPhysicalProgress")(e.target.value)}
            />
          </Field>

          <div className="sm:col-span-2 lg:col-span-3">
            <Field label="یادداشت">
              <textarea
                className={`${inputClass} min-h-24`}
                value={form.notes}
                onChange={(e) => set("notes")(e.target.value)}
              />
            </Field>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/80 p-4">
          <SecondaryButton onClick={onClose}>
            انصراف
          </SecondaryButton>
          <PrimaryButton onClick={() => void submit()} disabled={saving}>
            {saving ? "در حال ذخیره…" : "ذخیره"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * External participants (§6)
 * ------------------------------------------------------------------------- */

interface RoleOption {
  key: string;
  label: string;
  group: string;
}

const GROUP_LABELS: Record<string, string> = {
  client: "کارفرما",
  consultant: "مشاور و طراحی",
  contractor: "پیمانکاری و تأمین",
  field: "کارگاه و نظارت",
};

/**
 * The companies and people outside the business who are on this project.
 *
 * §6 is explicit about what this is not: recording a participant grants nothing
 * — no login, no membership, no business-wide access. The tab therefore shows
 * the party's own CRM name and its professional role, and says in one line that
 * these records are directory entries; the API's integration test asserts the
 * same thing against the database.
 */
export function AecParticipantsTab({
  projectId,
  canManage,
  lookups,
}: {
  projectId: string;
  canManage: boolean;
  lookups: WorkspaceLookups;
}) {
  const [participants, setParticipants] = useState<Participant[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Participant | "new" | null>(null);

  const roles: RoleOption[] = useMemo(() => lookups.participantRoles ?? [], [lookups.participantRoles]);
  const roleLabels = useMemo(
    () => new Map(roles.map((role) => [role.key, role.label])),
    [roles],
  );

  const load = useCallback(() => {
    api<{ participants: Participant[] }>(`/api/aec/projects/${projectId}/participants`).then(
      ({ ok, data }) => {
        if (ok) setParticipants(data.participants);
        else setError(workspaceError((data as unknown as { error?: string }).error));
      },
    );
  }, [projectId]);

  useEffect(load, [load]);

  async function remove(participant: Participant) {
    if (busy) return;
    setBusy(true);
    const { ok, data } = await api<{ participants: Participant[] }>(
      `/api/aec/projects/${projectId}/participants/${participant.id}`,
      { method: "DELETE" },
    );
    setBusy(false);
    if (ok) setParticipants(data.participants);
    else setError(workspaceError((data as unknown as { error?: string }).error));
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <SectionCard
        title="طرف‌های پروژه"
        description="کارفرما، مشاوران، پیمانکاران و عوامل کارگاه — از دفترچهٔ طرف‌های کسب‌وکار. ثبت این افراد هیچ دسترسی ورود یا عضویتی ایجاد نمی‌کند."
        actions={
          canManage && participants !== null ? (
            <PrimaryButton onClick={() => setEditing("new")}>
              <PlusIcon className="size-4" aria-hidden />
              افزودن طرف
            </PrimaryButton>
          ) : null
        }
        flush
      >
        {participants === null ? (
          <SectionCardSkeleton rows={4} />
        ) : participants.length === 0 ? (
          <EmptyState icon={UsersIcon} title="طرفی برای این پروژه ثبت نشده است">
            {canManage
              ? "کارفرما، مشاور یا پیمانکار را از دفترچهٔ طرف‌ها انتخاب کنید و نقش حرفه‌ای او را مشخص کنید."
              : "هنوز طرفی برای این پروژه ثبت نشده است."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border/80">
            {participants.map((participant) => (
              <li key={participant.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{participant.partyName}</p>
                  <p className="text-xs text-muted-foreground">
                    {roleLabels.get(participant.role) ?? participant.role}
                    {participant.contactName ? ` — ${participant.contactName}` : ""}
                  </p>
                </div>
                {participant.startedAt || participant.endedAt ? (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <DateCell date={participant.startedAt} relative={false} className="text-xs" />
                    <span aria-hidden>→</span>
                    <DateCell date={participant.endedAt} relative={false} className="text-xs" />
                  </span>
                ) : null}
                {canManage ? (
                  <div className="flex gap-1.5">
                    <SecondaryButton onClick={() => setEditing(participant)}>
                      <PencilIcon className="size-4" aria-hidden />
                      <span className="sr-only">ویرایش {participant.partyName}</span>
                    </SecondaryButton>
                    <SecondaryButton onClick={() => void remove(participant)} disabled={busy}>
                      <Trash2Icon className="size-4" aria-hidden />
                      <span className="sr-only">حذف {participant.partyName}</span>
                    </SecondaryButton>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {editing ? (
        <ParticipantDialog
          projectId={projectId}
          lookups={lookups}
          roles={roles}
          participant={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(next) => {
            setParticipants(next);
            setEditing(null);
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function ParticipantDialog({
  projectId,
  lookups,
  roles,
  participant,
  onClose,
  onSaved,
  onError,
}: {
  projectId: string;
  lookups: WorkspaceLookups;
  roles: RoleOption[];
  participant: Participant | null;
  onClose: () => void;
  onSaved: (participants: Participant[]) => void;
  onError: (message: string) => void;
}) {
  const [partyId, setPartyId] = useState(participant?.partyId ?? "");
  const [role, setRole] = useState(participant?.role ?? roles[0]?.key ?? "");
  const [contactName, setContactName] = useState(participant?.contactName ?? "");
  const [notes, setNotes] = useState(participant?.notes ?? "");
  const [startedAt, setStartedAt] = useState(participant?.startedAt ?? "");
  const [endedAt, setEndedAt] = useState(participant?.endedAt ?? "");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (saving) return;
    const body = {
      partyId,
      role,
      contactName: contactName.trim(),
      notes: notes.trim(),
      startedAt: startedAt || null,
      endedAt: endedAt || null,
    };
    setSaving(true);
    const { ok, data } = participant
      ? await api<{ participants: Participant[] }>(
          `/api/aec/projects/${projectId}/participants/${participant.id}`,
          { method: "PATCH", body: JSON.stringify({ role, contactName, notes, startedAt, endedAt }) },
        )
      : await api<{ participants: Participant[] }>(`/api/aec/projects/${projectId}/participants`, {
          method: "POST",
          body: JSON.stringify(body),
        });
    setSaving(false);
    if (ok) onSaved(data.participants);
    else onError(workspaceError((data as unknown as { error?: string }).error));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-lg`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">
            {participant ? "ویرایش طرف پروژه" : "افزودن طرف پروژه"}
          </h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>

        <div className="grid gap-3 p-4">
          {participant ? (
            <p className="text-sm">
              <span className="text-muted-foreground">طرف: </span>
              {participant.partyName}
            </p>
          ) : (
            <PickerField
              label="طرف"
              hint="از دفترچهٔ طرف‌های کسب‌وکار"
              value={partyId}
              onChange={setPartyId}
              options={lookups.parties.map((party) => ({ id: party.id, label: party.name }))}
            />
          )}

          <Field label="نقش حرفه‌ای" hint="نقش‌ها بر اساس پروفایل کسب‌وکار شما محدود شده‌اند">
            <select className={inputClass} value={role} onChange={(e) => setRole(e.target.value)}>
              {roles.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label} — {GROUP_LABELS[option.group] ?? option.group}
                </option>
              ))}
            </select>
          </Field>

          <Field label="نام رابط">
            <input className={inputClass} value={contactName} onChange={(e) => setContactName(e.target.value)} />
          </Field>

          <DateField label="شروع همکاری" value={startedAt} onChange={setStartedAt} />
          <DateField label="پایان همکاری" value={endedAt} onChange={setEndedAt} />

          <Field label="یادداشت">
            <textarea className={`${inputClass} min-h-20`} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/80 p-4">
          <SecondaryButton onClick={onClose}>
            انصراف
          </SecondaryButton>
          <PrimaryButton
            type="button"
            onClick={() => void submit()}
            disabled={saving || (!participant && !partyId) || !role}
          >
            {saving ? "در حال ذخیره…" : "ذخیره"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
