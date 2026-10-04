"use client";

/**
 * Phase 13 — the team screen. Three cards plus the personnel files:
 *  1. Members — name, role, branches, login phone, status; the full editor
 *     (role, per-permission overrides, branches, default branch), credential
 *     resets, suspend, remove.
 *  2. Invitations — invite by email, show the link exactly once, revoke.
 *  3. Add staff — PIN-based cashier/waiter/kitchen, who have no email.
 *
 * The member row's actions map one-to-one onto what the API actually accepts
 * (`PATCH /api/team/:id` carries `fullName`, `role`, `permissions`,
 * `locationIds`, `defaultLocationId`, `phone`; `PUT …/credentials` carries
 * `pin`/`password`) — before, the API offered all of it and the screen showed
 * a role-and-toggles editor and nothing else, so a member's name or branches
 * could only be fixed by removing and re-adding the person.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ALL_PERMISSIONS,
  isOwnerOnlyPermission,
  PERMISSION_METADATA,
  roleBasePermissions,
  type Permission,
} from "@/lib/permissions";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH, isValidPin } from "@/lib/pin-policy";
import { roleLabel } from "@/lib/role-labels";
import { ASSIGNABLE_ROLES, INVITABLE_ROLES, PIN_ROLES } from "@/lib/roles";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatPhoneDisplay } from "@/lib/phone";
import { RolesManager } from "@/components/team/roles-manager";
import { IamSyncCard } from "@/components/team/iam-sync-card";
import { LocalToHybridGuide } from "@/components/team/local-to-hybrid-guide";
import { partyScopeFor } from "@/lib/parties-scopes";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { LoadingSkeleton, SectionCard } from "../page-chrome";
import { PartiesSection } from "../parties/parties-section";
import {
  ErrorBox,
  Field,
  InfoBox,
  PrimaryButton,
  SecondaryButton,
  api,
  errorMessage,
  inputClass,
} from "../ui";


const PERMISSION_LABELS: Record<string, string> = {
  "orders.create": "ثبت سفارش",
  "orders.void": "ابطال سفارش",
  "orders.amend_closed": "ویرایش یا حذف سفارش بسته‌شده",
  "orders.discount": "اعمال تخفیف",
  "payments.take": "دریافت وجه",
  "payments.refund": "بازپرداخت",
  "tables.manage": "مدیریت میزها",
  "reservations.manage": "مدیریت رزرو",
  "kitchen.view": "نمایش آشپزخانه",
  "delivery.manage": "مدیریت ارسال",
  "menu.view": "مشاهدهٔ منو",
  "menu.edit": "ویرایش منو",
  "inventory.view": "مشاهدهٔ انبار",
  "inventory.adjust": "اصلاح موجودی",
  "purchases.manage": "مدیریت خرید",
  // The party permission covers all three roles, so the label says «اشخاص» — a
  // manager granting it to a cashier is also letting them edit suppliers and
  // personnel, and the label must not hide that.
  "parties.view": "مشاهدهٔ اشخاص",
  "parties.manage": "مدیریت اشخاص",
  // Phase G — «میز کار من». The two carved-out keys say what they commit the
  // business to, not which screen they open: a member reading «مدیریت
  // قراردادها» must understand it means signing, not filing.
  "workspace.view": "مشاهدهٔ میز کار",
  "workspace.manage": "مدیریت پروژه‌ها و وظایف",
  "workspace.contracts_manage": "مدیریت قراردادهای اجرایی",
  "workspace.approve": "تأیید درخواست‌ها",
  "workspace.admin": "مدیریت همهٔ پروژه‌ها",
  "ledger.view": "مشاهدهٔ دفتر",
  "ledger.post": "ثبت سند",
  "ledger.approve": "تأیید سند",
  "ledger.close_period": "بستن دوره",
  "accounts.edit": "ویرایش سرفصل‌ها",
  "reports.view": "مشاهدهٔ گزارش",
  "reports.export": "خروجی گزارش",
  "team.manage": "مدیریت تیم",
  "settings.manage": "تنظیمات",
  "locations.manage": "مدیریت شعبه",
  "backup.manage": "پشتیبان‌گیری",
  "api.manage": "مدیریت کلیدهای API",
};

interface Member {
  id: string;
  role: string;
  customRoleId: string | null;
  customRoleName: string | null;
  fullName: string;
  email: string | null;
  isActive: boolean;
  status: "invited" | "active" | "suspended" | "locked" | "inactive" | "offboarded";
  locationScope: "all" | "selected" | "home" | "none";
  hasPin: boolean;
  hasLogin: boolean;
  /** Phase 42 — the login phone (E.164) and whether the member has proven it with an OTP. */
  phone: string | null;
  phoneVerified: boolean;
  locationIds: string[];
  defaultLocationId: string | null;
  overrides: { granted?: string[]; revoked?: string[] };
  effectivePermissions: string[];
  createdAt: string;
}

/** A branch as `/api/team` hands it to the screen — enough to assign people to. */
interface TeamLocation {
  id: string;
  name: string;
  isActive: boolean;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  fullName: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  createdAt: string;
}

const INVITATION_STATUS_LABELS: Record<Invitation["status"], string> = {
  pending: "در انتظار",
  accepted: "پذیرفته‌شده",
  revoked: "لغوشده",
  expired: "منقضی",
};

/** Which role options the editor offers — every assignable role, labelled once. */
const ROLE_OPTIONS = ASSIGNABLE_ROLES.map((value) => ({ value, label: roleLabel(value) }));

export function TeamManager({
  currentUserId,
  role,
  permissions,
}: {
  currentUserId: string;
  role: string;
  /** The member's effective permission keys — forwarded to the personnel directory. */
  permissions?: readonly string[];
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [locations, setLocations] = useState<TeamLocation[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [deploymentProfile, setDeploymentProfile] = useState<"cloud" | "hybrid" | "local">("cloud");
  /** The member whose full editor dialog is open (name, role, branches, permissions). */
  const [editing, setEditing] = useState<Member | null>(null);
  /** Phase 42 — which member's login-phone editor is open. */
  const [phoneEditing, setPhoneEditing] = useState<Member | null>(null);
  /** Which member's PIN/password reset dialog is open. */
  const [credentialsEditing, setCredentialsEditing] = useState<Member | null>(null);

  const load = useCallback(async () => {
    const [membersRes, invitesRes] = await Promise.all([
      api<{ members: Member[]; locations?: TeamLocation[]; deploymentProfile?: "cloud" | "hybrid" | "local" }>("/api/team"),
      api<{ invitations: Invitation[] }>("/api/team/invitations"),
    ]);
    if (membersRes.ok) {
      setMembers(membersRes.data.members);
      if (membersRes.data.deploymentProfile) setDeploymentProfile(membersRes.data.deploymentProfile);
      // Branches travel with the members: assigning a person to a place needs
      // the place's name, and a second permission-gated call for a list this
      // screen already owns would only be a way to make it fail separately.
      if (membersRes.data.locations) setLocations(membersRes.data.locations);
    } else {
      setError(errorMessage((membersRes.data as { error?: string }).error));
    }
    if (invitesRes.ok) {
      setInvitations(invitesRes.data.invitations);
    } else if (membersRes.ok) {
      setError(errorMessage((invitesRes.data as { error?: string }).error));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function mutate(url: string, init: RequestInit) {
    setError("");
    const res = await api<{ error?: string; reason?: string }>(url, init);
    if (!res.ok) {
      setError(res.data.reason || errorMessage(res.data.error));
      return false;
    }
    await load();
    return true;
  }

  const locationName = useMemo(
    () => new Map(locations.map((location) => [location.id, location.name])),
    [locations],
  );

  if (loading) return <LoadingSkeleton rows={3} />;
  const isOwner = role === "owner";

  return (
    <div className="space-y-6">
      <ErrorBox>{error}</ErrorBox>
      <div role="status" className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
        <p className="font-semibold text-foreground">
          {deploymentProfile === "cloud" ? "مدیریت ابری" : deploymentProfile === "hybrid" ? "دسترسی ابری و محدودیت‌های این سایت" : "مدیریت محلی"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {deploymentProfile === "hybrid"
            ? "این سایت در حالت قطع اتصال فقط می‌تواند دسترسی را محدود کند. افزایش سطح دسترسی به تأیید فضای ابری نیاز دارد."
            : deploymentProfile === "local"
              ? "این کسب‌وکار به فضای ابری Eshobe وابسته نیست و مدیریت کاربران به‌صورت محلی انجام می‌شود."
              : "هویت، نقش‌ها، نشست‌ها و دسترسی‌ها از فضای ابری مدیریت می‌شوند."}
        </p>
      </div>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">مدیریت اعضا</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">اعضا و دسترسی‌ها</h2>
          </div>
        }
        description="اعضای کسب‌وکار، نقش‌ها و سطوح دسترسی آن‌ها را در سامانه مدیریت کنید."
      >
        <div className="space-y-3">
          {members.length === 0 ? (
            <InfoBox>هنوز عضوی برای این کسب‌وکار ثبت نشده است.</InfoBox>
          ) : null}
          {members.map((member) => (
            <div key={member.id} className="rounded-xl border border-border/80 p-3 sm:p-4 transition-colors hover:bg-muted/60 dark:hover:bg-muted/50">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-foreground">
                    {member.fullName}
                    {member.id === currentUserId && (
                      <span className="ms-2 text-xs font-normal text-muted-foreground">(شما)</span>
                    )}
                    {member.status !== "active" && (
                      <span className="ms-2 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
                        {({ invited: "دعوت‌شده", suspended: "تعلیق‌شده", locked: "قفل‌شده", inactive: "غیرفعال", offboarded: "قطع همکاری" } as const)[member.status]}
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {roleLabel(member.role)}{member.customRoleName ? ` / ${member.customRoleName}` : ""}
                    {member.email ? ` · ${member.email}` : ""}
                    {member.hasPin ? " · ورود با رمز عددی" : ""}
                    {member.locationScope === "all"
                      ? " · همهٔ شعبه‌ها"
                      : member.locationScope === "none"
                        ? " · بدون دسترسی شعبه"
                        : member.locationScope === "home"
                          ? ` · شعبهٔ اصلی: ${locationName.get(member.defaultLocationId ?? "") ?? "—"}`
                          : ` · شعبه‌های انتخابی: ${member.locationIds
                              .map((id) => locationName.get(id) ?? "—")
                              .join("، ") || "هیچ‌کدام"}`}
                  </p>
                  <p className="mt-1 text-xs">
                    {member.phone ? (
                      <>
                        <span dir="ltr">{toPersianDigits(formatPhoneDisplay(member.phone))}</span>
                        {member.phoneVerified ? (
                          <span className="ms-2 text-emerald-600 dark:text-emerald-400">موبایل تأییدشده</span>
                        ) : (
                          <span className="ms-2 text-amber-600 dark:text-amber-400">
                            تأییدنشده — در اولین ورود با کد پیامکی تأیید می‌شود
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">بدون شمارهٔ موبایل</span>
                    )}
                  </p>
                </div>
                <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
                  {(isOwner || member.role !== "owner") ? <SecondaryButton onClick={() => setEditing(member)}>ویرایش</SecondaryButton> : null}
                  {(isOwner || member.role !== "owner") ? <SecondaryButton onClick={() => setPhoneEditing(member)}>
                    شمارهٔ موبایل
                  </SecondaryButton> : null}
                  {(isOwner || member.role !== "owner") ? <SecondaryButton onClick={() => setCredentialsEditing(member)}>
                    رمز ورود
                  </SecondaryButton> : null}
                  {(isOwner || member.role !== "owner") ? <SecondaryButton
                    onClick={() => {
                      if (member.isActive && !confirm(`حساب «${member.fullName}» تعلیق شود؟ دسترسی او بلافاصله قطع خواهد شد.`)) return;
                      void mutate(`/api/team/${member.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ isActive: !member.isActive }),
                      });
                    }}
                  >
                    {member.isActive ? "تعلیق" : "فعال‌سازی"}
                  </SecondaryButton> : null}
                  {(isOwner || member.role !== "owner") ? <SecondaryButton
                    onClick={() => {
                      if (!confirm(`همکاری «${member.fullName}» خاتمه یابد؟ دسترسی، نشست‌ها و اعتبارنامه‌های فعال لغو می‌شوند و سوابق تاریخی حفظ خواهند شد.`)) return;
                      void mutate(`/api/team/${member.id}`, { method: "DELETE" });
                    }}
                    className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    قطع همکاری
                  </SecondaryButton> : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      <RolesManager deploymentProfile={deploymentProfile} />
      {deploymentProfile === "local" ? <LocalToHybridGuide members={members} /> : null}
      {deploymentProfile === "hybrid" ? <IamSyncCard /> : null}

      {editing ? (
        <MemberEditorDialog
          member={editing}
          locations={locations}
          canManageOwners={isOwner}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}

      {phoneEditing ? (
        <PhoneEditorDialog
          member={phoneEditing}
          onClose={() => setPhoneEditing(null)}
          onSaved={() => {
            setPhoneEditing(null);
            void load();
          }}
        />
      ) : null}

      {credentialsEditing ? (
        <CredentialsEditorDialog
          member={credentialsEditing}
          onClose={() => setCredentialsEditing(null)}
          onSaved={() => setCredentialsEditing(null)}
        />
      ) : null}

      <InviteSection invitations={invitations} canManageOwners={isOwner} onChanged={load} onError={setError} />
      <AddStaffSection onChanged={load} onError={setError} />

      {/*
        Personnel as parties (scope `team`): a staff member is a counterparty for
        payroll, advances and the phone number the shift lead calls, and those live on
        `parties` with `employee_user_id` pointing back at the account above. Shown
        here rather than in a screen of its own so the two views of one person cannot
        disagree about the name — and so editing a phone number here is editing it
        everywhere, the POS's customer picker included.
      */}
      <div>
        <p className="mb-2 text-xs font-semibold text-amber-700 dark:text-amber-300">پروندهٔ کارکنان</p>
        <PartiesSection scope={partyScopeFor("team")} role={role} permissions={permissions} />
      </div>
    </div>
  );
}

/**
 * The full member editor — everything a membership carries that a row of
 * buttons cannot ask for in one line: the name, the role (which re-bases the
 * permission ticks), the branch assignment, the default branch, and the
 * per-permission overrides.
 *
 * The name edit doubles as the repair path for the personnel file: the route
 * keeps the party record named after the member (see `ensureEmployeeParty`),
 * so «علی رضایی» in the list above and «علی رضایی» in the payroll file stay
 * one person.
 */
function MemberEditorDialog({
  member,
  locations,
  canManageOwners,
  onClose,
  onSaved,
}: {
  member: Member;
  locations: TeamLocation[];
  canManageOwners: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState(member.fullName);
  const [role, setRole] = useState(member.role);
  const [customRoleId, setCustomRoleId] = useState(member.customRoleId ?? "");
  const [customRoles, setCustomRoles] = useState<Array<{id:string;name:string;permissions:string[];isActive:boolean}>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set(member.effectivePermissions));
  const [locationScope, setLocationScope] = useState(member.locationScope);
  const [branchIds, setBranchIds] = useState<string[]>(member.locationIds);
  const [defaultLocationId, setDefaultLocationId] = useState(member.defaultLocationId ?? "");
  const [permissionSearch, setPermissionSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void api<{roles:Array<{id:string;name:string;permissions:string[];isActive:boolean}>}>("/api/team/roles").then((res) => { if (res.ok) setCustomRoles(res.data.roles.filter((item) => item.isActive)); }); }, []);

  // Re-base the ticks whenever the role changes, so the boxes always show what
  // that role would actually grant.
  function changeRole(next: string) {
    setRole(next);
    setCustomRoleId("");
    setSelected(new Set(roleBasePermissions(next as never)));
  }

  function toggleBranch(id: string, checked: boolean) {
    setBranchIds((current) => {
      const next = checked ? [...current, id] : current.filter((entry) => entry !== id);
      // Unticking the default branch moves the default back to "none chosen"
      // rather than leaving it pointing at a branch the member no longer has.
      if (!checked && defaultLocationId === id) setDefaultLocationId("");
      return next;
    });
  }

  function chooseDefaultBranch(id: string) {
    setDefaultLocationId(id);
    // The default is one of the assigned branches by definition — tick it
    // rather than storing a default the access rules would ignore.
    if (id) setBranchIds((current) => (current.includes(id) ? current : [...current, id]));
  }

  const customPreset = customRoles.find((item) => item.id === customRoleId)?.permissions;
  const preset = new Set<string>(customPreset ?? roleBasePermissions(role as never));
  const isOwnerRole = role === "owner";

  async function save() {
    const name = fullName.trim();
    if (!name) {
      setError("نام عضو را بنویسید.");
      return;
    }
    setBusy(true);
    setError("");
    const granted = [...selected].filter((p) => !preset.has(p)).sort();
    const revoked = [...preset].filter((p) => !selected.has(p)).sort();
    const res = await api<{ error?: string; reason?: string }>(`/api/team/${member.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        fullName: name,
        role,
        customRoleId: customRoleId || null,
        // An owner's set is not reducible (permissions.ts), so none is sent.
        ...(isOwnerRole ? {} : { permissions: { granted, revoked } }),
        locationScope: isOwnerRole ? "all" : locationScope,
        locationIds: locationScope === "selected" ? branchIds : [],
        defaultLocationId: locationScope === "home" ? (defaultLocationId || null) : null,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.data.reason || errorMessage(res.data.error));
      return;
    }
    onSaved();
  }

  return (
    <Sheet open onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent side="left" className="w-full max-w-none overflow-y-auto p-0 sm:max-w-2xl">
        <SheetHeader className="sticky top-0 z-10 border-b bg-background px-5 py-4 text-start">
          <SheetTitle>ویرایش «{member.fullName}»</SheetTitle>
          <nav aria-label="بخش‌های عضو" className="mt-3 flex gap-2 overflow-x-auto pb-1 text-xs">
            <a className="rounded-full bg-muted px-3 py-1.5 focus-visible:ring" href="#member-profile">پروفایل و نقش</a>
            <a className="rounded-full bg-muted px-3 py-1.5 focus-visible:ring" href="#member-branches">شعبه‌ها</a>
            <a className="rounded-full bg-muted px-3 py-1.5 focus-visible:ring" href="#member-access">دسترسی‌ها</a>
          </nav>
        </SheetHeader>
        <div className="space-y-5 px-5 py-4">
        <div id="member-profile" className="scroll-mt-28">
        <ErrorBox>{error}</ErrorBox>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="نام و نام خانوادگی *">
            <input
              className={inputClass}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </Field>
          <Field label="نقش">
            <SearchableSelect
              value={role}
              onChange={changeRole}
              options={canManageOwners ? ROLE_OPTIONS : ROLE_OPTIONS.filter((option) => option.value !== "owner")}
            />
          </Field>
          <Field label="نقش سفارشی" hint="در صورت انتخاب، الگوی دسترسی نقش سیستمی را جایگزین می‌کند.">
            <SearchableSelect value={customRoleId} disabled={isOwnerRole} onChange={(value) => {
              setCustomRoleId(value);
              const custom = customRoles.find((item) => item.id === value);
              setSelected(new Set(custom?.permissions ?? roleBasePermissions(role as never)));
            }} options={[{value:"",label:"بدون نقش سفارشی"},...customRoles.map((item)=>({value:item.id,label:item.name}))]} />
          </Field>
        </div></div>

        <div id="member-branches" className="scroll-mt-28 space-y-4"><Field label="دامنهٔ شعبه">
          <SearchableSelect
            value={isOwnerRole ? "all" : locationScope}
            onChange={(value) => setLocationScope(value as Member["locationScope"])}
            disabled={isOwnerRole}
            options={[
              { value: "all", label: "همهٔ شعبه‌ها" },
              { value: "selected", label: "شعبه‌های انتخابی" },
              { value: "home", label: "فقط شعبهٔ اصلی" },
              { value: "none", label: "بدون دسترسی شعبه" },
            ]}
          />
        </Field>

        {locationScope === "selected" ? <Field label="شعبه‌ها" hint="فقط شعبه‌های انتخاب‌شده در دسترس خواهند بود.">
          {locations.length === 0 ? (
            <p className="text-xs text-muted-foreground">شعبه‌ای ثبت نشده است.</p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {locations.map((location) => (
                <label key={location.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={branchIds.includes(location.id)}
                    onCheckedChange={(checked) => toggleBranch(location.id, checked === true)}
                  />
                  <span>
                    {location.name}
                    {!location.isActive ? (
                      <span className="ms-1 text-xs text-muted-foreground">(غیرفعال)</span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          )}
        </Field> : null}

        {locationScope === "home" ? <Field label="شعبهٔ اصلی" hint="تنها شعبه‌ای که این عضو به آن دسترسی دارد.">
          <SearchableSelect
            value={defaultLocationId}
            onChange={chooseDefaultBranch}
            options={[
              { value: "", label: "— انتخاب نشده —" },
              ...locations.map((location) => ({ value: location.id, label: location.name })),
            ]}
          />
        </Field> : null}

        </div>
        <div id="member-access" className="scroll-mt-28">{isOwnerRole ? (
          <InfoBox>مالک به همهٔ بخش‌ها دسترسی دارد و دسترسی‌هایش قابل محدود کردن نیست.</InfoBox>
        ) : (
          <Field label="دسترسی‌ها" hint="تیک‌ها نسبت به نقش پایه خوانده می‌شوند: برداشتن تیکِ پیش‌فرض یعنی گرفتن آن دسترسی، و تیکِ اضافه یعنی اعطای آن.">
            <input
              className={`${inputClass} mb-3`}
              value={permissionSearch}
              onChange={(event) => setPermissionSearch(event.target.value)}
              placeholder="جست‌وجوی نام، کلید یا گروه دسترسی"
              aria-label="جست‌وجوی دسترسی‌ها"
            />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {ALL_PERMISSIONS.filter((permission) => {
                if (isOwnerOnlyPermission(permission)) return false;
                const metadata = PERMISSION_METADATA.get(permission);
                const haystack = `${permission} ${PERMISSION_LABELS[permission] ?? ""} ${metadata?.group ?? ""} ${metadata?.description ?? ""}`.toLowerCase();
                return haystack.includes(permissionSearch.trim().toLowerCase());
              }).map((permission: Permission) => (
                <label key={permission} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(permission)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(permission);
                      else next.delete(permission);
                      setSelected(next);
                    }}
                  />
                  <span>
                    {PERMISSION_LABELS[permission] ?? permission}
                    {(["high", "critical"] as const).includes(PERMISSION_METADATA.get(permission)?.risk as "high" | "critical") ? (
                      <span className="ms-1 text-xs text-amber-600 dark:text-amber-400" title="دسترسی پرخطر">⚠</span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          </Field>
        )}

        </div></div>
        <SheetFooter className="sticky bottom-0 border-t bg-background px-5 py-4">
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton onClick={save} disabled={busy}>ذخیره</PrimaryButton>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Phase 42 — set or clear one member's login phone.
 *
 * An owner typing a number proves nothing about who holds it, so whatever is
 * saved here lands *unverified* — the member proves it with an OTP at their
 * next door login (or from the security center), and only then does it
 * become usable for the phone login. The hint says so, because an owner who
 * is not told will assume typing the number was the whole job.
 */
function PhoneEditorDialog({
  member,
  onClose,
  onSaved,
}: {
  member: Member;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [phone, setPhone] = useState(member.phone ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    const res = await api<{ error?: string; reason?: string }>(`/api/team/${member.id}`, {
      method: "PATCH",
      body: JSON.stringify({ phone: phone.trim() }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.data.reason || errorMessage(res.data.error));
      return;
    }
    onSaved();
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>شمارهٔ موبایل «{member.fullName}»</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>
        <Field
          label="شمارهٔ موبایل ورود"
          hint="با کد پیامکی که در اولین ورود به خود عضو می‌رسد تأیید می‌شود؛ خالی بگذارید تا حذف شود."
        >
          <input
            className={inputClass}
            dir="ltr"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="09121234567"
          />
        </Field>
        <DialogFooter>
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton onClick={save} disabled={busy}>
            ذخیرهٔ شماره
          </PrimaryButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The credential reset — a PIN for the shared-device roles, a password for
 * the email roles, matching `PUT /api/team/:id/credentials` (the owner's
 * force-reset path; a member changing their *own* password must prove the
 * current one, which is the security center's business, not this dialog's).
 *
 * The two are separate buttons and separate requests on purpose: resetting a
 * password changes the person's *platform* login everywhere they are a
 * member, and that deserves its own explicit press rather than riding along
 * with a PIN change.
 */
function CredentialsEditorDialog({
  member,
  onClose,
  onSaved,
}: {
  member: Member;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isPinMember = member.hasPin || (PIN_ROLES as readonly string[]).includes(member.role);
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function resetPin() {
    if (!isValidPin(pin)) {
      setError("رمز عددی باید ۴ تا ۱۲ رقم باشد.");
      return;
    }
    setBusy(true);
    setError("");
    setDone("");
    const res = await api<{ error?: string }>(`/api/team/${member.id}/credentials`, {
      method: "PUT",
      body: JSON.stringify({ pin }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data.error));
      return;
    }
    setPin("");
    setDone("رمز عددی جدید ثبت شد.");
  }

  async function resetPassword() {
    if (password.length < 8) {
      setError("رمز عبور باید حداقل ۸ نویسه باشد.");
      return;
    }
    setBusy(true);
    setError("");
    setDone("");
    const res = await api<{ error?: string }>(`/api/team/${member.id}/credentials`, {
      method: "PUT",
      body: JSON.stringify({ password }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data.error));
      return;
    }
    setPassword("");
    setDone("رمز عبور جدید ثبت شد؛ ورود این شخص در همهٔ کسب‌وکارهایش با همین رمز باز می‌شود.");
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>رمز ورود «{member.fullName}»</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>
        {done ? <InfoBox>{done}</InfoBox> : null}

        {isPinMember ? (
          <Field
            label={`رمز عددی جدید (${toPersianDigits(PIN_MIN_LENGTH)} تا ${toPersianDigits(PIN_MAX_LENGTH)} رقم)`}
            hint="در هر شعبه باید یکتا باشد."
          >
            <input
              className={`${inputClass} w-48 text-center tracking-[0.25em]`}
              dir="ltr"
              inputMode="numeric"
              maxLength={PIN_MAX_LENGTH}
              value={pin}
              onChange={(e) => setPin(toLatinDigits(e.target.value).replace(/[^0-9]/g, ""))}
            />
          </Field>
        ) : null}

        {member.hasLogin ? (
          <Field
            label="رمز عبور جدید"
            hint="این رمز برای ورودِ ایمیلی این شخص در همهٔ کسب‌وکارها یکی است."
          >
            <input
              className={inputClass}
              dir="ltr"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
            />
          </Field>
        ) : null}

        {!isPinMember && !member.hasLogin ? (
          <InfoBox>این عضو نه رمز عددی دارد و نه ورود ایمیلی؛ ابتدا نقش یا روش ورودش را در ویرایش عضو تعیین کنید.</InfoBox>
        ) : null}

        <DialogFooter>
          <SecondaryButton onClick={onClose}>بستن</SecondaryButton>
          {isPinMember ? (
            <PrimaryButton onClick={resetPin} disabled={busy || !pin}>
              ثبت رمز عددی
            </PrimaryButton>
          ) : null}
          {member.hasLogin ? (
            <PrimaryButton onClick={resetPassword} disabled={busy || password.length < 8}>
              ثبت رمز عبور
            </PrimaryButton>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteSection({
  invitations,
  canManageOwners,
  onChanged,
  onError,
}: {
  invitations: Invitation[];
  canManageOwners: boolean;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<string>("manager");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);

  async function invite() {
    setBusy(true);
    onError("");
    setLink("");
    const res = await api<{ url?: string; error?: string }>("/api/team/invitations", {
      method: "POST",
      body: JSON.stringify({ email, fullName, role }),
    });
    setBusy(false);
    if (!res.ok) {
      onError(errorMessage(res.data.error));
      return;
    }
    setLink(res.data.url ?? "");
    setEmail("");
    setFullName("");
    await onChanged();
  }

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">دعوت و همکاری</p>
          <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">دعوت همکار</h2>
        </div>
      }
      description="همکاران جدید را با ارسال لینک دعوت به سیستم اضافه کنید."
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="نام">
          <input className={inputClass} value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="ایمیل">
          <input
            className={inputClass}
            dir="ltr"
            value={email}
            type="email"
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="نقش">
          <SearchableSelect
            value={role}
            onChange={setRole}
            options={INVITABLE_ROLES.filter((r) => canManageOwners || r !== "owner").map((r) => ({ value: r, label: roleLabel(r) }))}
          />
        </Field>
      </div>
      <div className="mt-4">
        <PrimaryButton onClick={invite} disabled={busy || !email || !fullName}>
          ساخت لینک دعوت
        </PrimaryButton>
      </div>

      {link && (
        <div className="mt-4">
          <InfoBox>
            این لینک فقط همین یک‌بار نمایش داده می‌شود. آن را برای همکارتان بفرستید:
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input className={`${inputClass} min-w-0 flex-1`} aria-label="لینک دعوت" dir="ltr" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
              <SecondaryButton onClick={() => void navigator.clipboard.writeText(link)}>کپی لینک</SecondaryButton>
            </div>
          </InfoBox>
        </div>
      )}

      {invitations.length > 0 && (
        <ul className="mt-4 divide-y divide-border/80 text-sm">
          {invitations.map((invitation) => (
            <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span>
                {invitation.fullName} · <span dir="ltr">{invitation.email}</span> ·{" "}
                {roleLabel(invitation.role)} ·{" "}
                <span className="text-muted-foreground">
                  {INVITATION_STATUS_LABELS[invitation.status]}
                  {invitation.status === "pending" &&
                    ` تا ${toPersianDigits(formatJalali(new Date(invitation.expiresAt)))}`}
                </span>
              </span>
              {invitation.status === "pending" && (
                <SecondaryButton
                  onClick={async () => {
                    const result = await api<{ error?: string }>(`/api/team/invitations/${invitation.id}`, { method: "DELETE" });
                    if (!result.ok) {
                      onError(errorMessage(result.data.error));
                      return;
                    }
                    await onChanged();
                  }}
                >
                  لغو
                </SecondaryButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function AddStaffSection({
  onChanged,
  onError,
}: {
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<string>("cashier");
  const [pin, setPin] = useState("");
  // Phase 42 — optional login phone, stored unverified until the member's
  // first OTP proves it (mirrors PhoneEditorDialog above).
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * Switching the role empties the PIN and the phone: a PIN is per-role
   * length-wise identical but per-member unique, and a number typed for one
   * person must not silently ride along into another's account. (Before, the
   * PIN typed for a cashier stayed in the box while the owner picked
   * «آشپزخانه», and if they did not notice, the kitchen member was created
   * with the cashier's intended PIN.)
   */
  function changeRole(next: string) {
    if (next === role) return;
    setRole(next);
    setPin("");
    setPhone("");
  }

  async function add() {
    setBusy(true);
    onError("");
    const res = await api<{ error?: string }>("/api/team", {
      method: "POST",
      body: JSON.stringify({ role, fullName, pin, phone: phone.trim() || undefined }),
    });
    setBusy(false);
    if (!res.ok) {
      onError(errorMessage(res.data.error));
      return;
    }
    setFullName("");
    setPin("");
    setPhone("");
    await onChanged();
  }

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">پرسنل صندوق و آشپزخانه</p>
          <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">افزودن کارکنان صندوق و آشپزخانه</h2>
        </div>
      }
      description="این کارکنان با رمز عددی روی دستگاه مشترک وارد می‌شوند و ایمیل ندارند."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="نام">
          <input className={inputClass} value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="نقش">
          <SearchableSelect
            value={role}
            onChange={changeRole}
            options={PIN_ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
          />
        </Field>
        <Field
          label={`رمز عددی (${toPersianDigits(PIN_MIN_LENGTH)} تا ${toPersianDigits(PIN_MAX_LENGTH)} رقم)`}
          hint="در هر شعبه باید یکتا باشد."
        >
          <input
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            maxLength={PIN_MAX_LENGTH}
            value={pin}
            onChange={(e) => setPin(toLatinDigits(e.target.value).replace(/[^0-9]/g, ""))}
          />
        </Field>
        <Field
          label="شمارهٔ موبایل"
          hint="اختیاری؛ برای ورود با پیامک. بار اول با کد تأیید فعال می‌شود."
        >
          <input
            className={inputClass}
            dir="ltr"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="09121234567"
          />
        </Field>
      </div>
      <div className="mt-4">
        {/* The same shape rule the backend gates on (pin-policy.ts) — the
            button says no before the request leaves, instead of answering
            with a 400 after it does. */}
        <PrimaryButton onClick={add} disabled={busy || !fullName.trim() || !isValidPin(pin)}>
          افزودن
        </PrimaryButton>
      </div>
    </SectionCard>
  );
}
