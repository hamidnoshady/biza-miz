"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PermissionEditor } from "./permission-editor";
import {
  ALL_PERMISSIONS,
  PERMISSION_METADATA,
  roleBasePermissions,
  type Permission,
} from "@/lib/permissions";
import { permissionGroupLabel, permissionsInGroup, PERMISSION_GROUP_ORDER } from "@/lib/permission-registry";
import { ALL_ROLES, loginCredentialModelForRole } from "@/lib/roles";
import { roleLabel } from "@/lib/role-labels";
import { SecurityConfirmDialog } from "@/components/auth/security-confirm-dialog";
import {
  api,
  ErrorBox,
  Field,
  InfoBox,
  PrimaryButton,
  SecondaryButton,
  inputClass,
} from "@/app/dashboard/ui";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface TenantRole {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  defaultLocationScope: "all" | "selected" | "home" | "none";
  isActive: boolean;
  revision: number;
  memberCount: number;
  updatedAt: string;
}

/** The scope labels the role form and the role cards share. */
const SCOPE_LABELS: Record<TenantRole["defaultLocationScope"], string> = {
  all: "همهٔ شعبه‌ها",
  selected: "شعبه‌های انتخابی",
  home: "فقط شعبهٔ اصلی",
  none: "بدون دسترسی شعبه",
};

/**
 * What a system role *is*, in the two facts an owner actually asks about
 * (issue #947, TEAM-F08).
 *
 * The cards used to say «الگوی ثابت سامانه» — true and useless. The questions a
 * business has when it assigns a role are «how much can this role reach?» and
 * «how does this person sign in?», and both were already answerable from the
 * catalogue this screen sits next to: `roleBasePermissions` is the preset and
 * `loginCredentialModelForRole` is the credential the role expects. Deriving the
 * summary rather than writing a paragraph per role means the card cannot drift
 * from what the server will actually grant.
 */
function systemRoleSummary(role: string): { capabilities: string; reach: string; credential: string } {
  const preset = roleBasePermissions(role as (typeof ALL_ROLES)[number]);
  const reach = PERMISSION_GROUP_ORDER.filter((group) =>
    permissionsInGroup(group).some((meta) => preset.includes(meta.key)),
  );
  return {
    capabilities:
      role === "owner"
        ? `${preset.length.toLocaleString("fa-IR")} دسترسی — همهٔ قابلیت‌ها، بدون استثنا`
        : `${preset.length.toLocaleString("fa-IR")} دسترسی`,
    reach: reach.length ? reach.map(permissionGroupLabel).join(" · ") : "بدون دسترسی عملیاتی",
    credential:
      loginCredentialModelForRole(role as (typeof ALL_ROLES)[number]) === "pin"
        ? "ورود با رمز عددی روی دستگاه مشترک — بدون ایمیل"
        : "ورود با ایمیل و رمز عبور",
  };
}

/**
 * Issue #854 (P2.4) — the reads here are `team.view` (any member who may see the
 * roster may see which roles exist), while every write is
 * `team.permissions.manage`. Before this the screen offered "ایجاد نقش سفارشی",
 * "ویرایش" and "بایگانی" to anyone who could reach the tab, and the refusal only
 * arrived after the editor was filled in and saved.
 *
 * Issue #947 (TEAM-F08) — the writes are now the application's own dialogs. Archiving
 * a role asked with `window.confirm` and `window.prompt`: an unstyled native pair a
 * screen reader cannot label, in a flow where the second answer *is* the audit
 * reason. The archive confirmation is `SecurityConfirmDialog` with its reason field,
 * its refusal is shown in the card's own error slot instead of being dropped on the
 * floor, and a hybrid site keeps its read-only behaviour (access only narrows there,
 * and retiring a role is a change the cloud owns).
 */
export function RolesManager({
  deploymentProfile,
  canManagePermissions,
}: {
  deploymentProfile: "cloud" | "hybrid" | "local";
  canManagePermissions: boolean;
}) {
  const [roles, setRoles] = useState<TenantRole[]>([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<TenantRole | null | "new">(null);
  /** The role whose archive dialog is open, and that dialog's own state. */
  const [archiving, setArchiving] = useState<TenantRole | null>(null);
  const [archiveReason, setArchiveReason] = useState("");
  const [archiveError, setArchiveError] = useState("");
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");

  const load = useCallback(async () => {
    const res = await api<{ roles: TenantRole[]; error?: string }>("/api/team/roles");
    if (res.ok) setRoles(res.data.roles);
    else setError(res.data.error ?? "دریافت نقش‌ها ناموفق بود.");
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const locked = deploymentProfile === "hybrid" || !canManagePermissions;

  /** The custom roles the search field narrows the list to. */
  const visibleCustomRoles = useMemo(() => {
    const needle = memberSearch.trim().toLowerCase();
    if (!needle) return roles;
    return roles.filter((role) =>
      [role.name, role.description].join(" ").toLowerCase().includes(needle),
    );
  }, [roles, memberSearch]);

  /**
   * Retiring a role is an access change, so the server insists on a reason. The
   * refusal is rendered inside the dialog that asked for it — the handler used to
   * `await api(...)` and then ignore the result entirely, so a role that failed to
   * archive simply stayed on screen with no explanation.
   */
  async function archiveConfirmed() {
    if (!archiving) return;
    setArchiveBusy(true);
    setArchiveError("");
    const res = await api<{ error?: string; reason?: string }>(
      `/api/team/roles/${archiving.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          expectedRevision: archiving.revision,
          isActive: false,
          reason: archiveReason.trim(),
        }),
      },
    );
    setArchiveBusy(false);
    if (!res.ok) {
      setArchiveError(res.data.reason || res.data.error || "بایگانی نقش ناموفق بود.");
      /*
       * Issue #947 (TEAM-F08) — a revision conflict is recoverable, so the screen does
       * the recovery: the message alone («صفحه را تازه کنید») would leave the owner
       * holding a stale revision with no way to see what changed. The list is re-read
       * here and the dialog keeps its place holding the corrected revision, so «بله،
       * بایگانی شود» works on the next press.
       */
      if (res.data.error === "revision_conflict") {
        const refreshed = await api<{ roles: TenantRole[] }>("/api/team/roles");
        if (refreshed.ok) {
          setRoles(refreshed.data.roles);
          const current = refreshed.data.roles.find((role) => role.id === archiving.id);
          if (current) setArchiving(current);
        }
      }
      return;
    }
    setArchiving(null);
    setArchiveReason("");
    await load();
  }

  return (
    <section aria-labelledby="roles-heading" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="roles-heading" className="font-semibold">نقش‌ها و دسترسی‌ها</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            نقش‌های سیستمی ثابت‌اند؛ نقش‌های سفارشی قابل ایجاد، ویرایش و بایگانی هستند.
          </p>
        </div>
        <PrimaryButton disabled={locked} onClick={() => setEditing("new")}>ایجاد نقش سفارشی</PrimaryButton>
      </div>
      {deploymentProfile === "hybrid" ? (
        <InfoBox>تعریف یا افزایش دسترسی نقش در سایت Hybrid فقط پس از تأیید فضای ابری انجام می‌شود.</InfoBox>
      ) : !canManagePermissions ? (
        <InfoBox>نمایش نقش‌ها برای شما فقط‌خواندنی است؛ ایجاد یا ویرایش نقش به مجوز «مدیریت دسترسی‌ها» نیاز دارد.</InfoBox>
      ) : null}
      <ErrorBox>{error}</ErrorBox>

      <h3 className="mt-4 text-xs font-semibold text-amber-700 dark:text-amber-300">نقش‌های سیستمی</h3>
      <div className="mt-2 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {ALL_ROLES.map((role) => {
          const summary = systemRoleSummary(role);
          return (
            <div key={role} className="rounded-xl border border-border p-3">
              <span className="rounded-full bg-muted px-2 py-1 text-xs">سیستمی</span>
              <p className="mt-2 font-medium">{roleLabel(role)}</p>
              <p className="text-xs text-muted-foreground">{summary.capabilities}</p>
              {/* Which parts of the product this role opens — the question an
                  owner is really asking when comparing «صندوق‌دار» and «مدیر». */}
              <p className="mt-1 text-xs text-muted-foreground">{summary.reach}</p>
              <p className="mt-1 text-xs text-muted-foreground">{summary.credential}</p>
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-amber-700 dark:text-amber-300">نقش‌های سفارشی</h3>
        {roles.length > 3 ? (
          <div className="w-56">
            {/* A plain labelled filter: `SearchableSelect` picks a value, this
                narrows a list, and using the former for the latter announced an
                empty combobox to screen readers. */}
            <label className="sr-only" htmlFor="custom-role-filter">
              جست‌وجوی نقش سفارشی
            </label>
            <input
              id="custom-role-filter"
              className={inputClass}
              value={memberSearch}
              onChange={(event) => setMemberSearch(event.target.value)}
              placeholder="جست‌وجوی نقش…"
              type="search"
            />
          </div>
        ) : null}
      </div>
      <div className="mt-2 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {roles.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            هنوز نقش سفارشی ساخته نشده است؛ نقش‌های سیستمی بالا همیشه در دسترس‌اند.
          </p>
        ) : visibleCustomRoles.length === 0 ? (
          <p className="text-xs text-muted-foreground">نقشی با این نام پیدا نشد.</p>
        ) : null}
        {visibleCustomRoles.map((role) => {
          const risky = role.permissions.filter((permission) => {
            const meta = PERMISSION_METADATA.get(permission as Permission);
            return meta?.risk === "high" || meta?.risk === "critical";
          }).length;
          return (
            <div key={role.id} className="rounded-xl border border-border p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="rounded-full bg-primary/10 px-2 py-1 text-xs text-primary">
                  {role.isActive ? "سفارشی" : "بایگانی‌شده"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {role.memberCount.toLocaleString("fa-IR")} عضو
                </span>
              </div>
              <p className="mt-2 font-medium">{role.name}</p>
              <p className="min-h-8 text-xs text-muted-foreground">{role.description || "بدون توضیح"}</p>
              {/* The two facts a card is asked for: how much it reaches, and the
                  branch policy new members of it inherit. */}
              <p className="mt-1 text-xs text-muted-foreground">
                {role.permissions.length.toLocaleString("fa-IR")} دسترسی
                {risky > 0 ? ` · ${risky.toLocaleString("fa-IR")} حساس` : ""} ·{" "}
                {SCOPE_LABELS[role.defaultLocationScope]}
              </p>
              <div className="mt-3 flex gap-2">
                <SecondaryButton disabled={locked || !role.isActive} onClick={() => setEditing(role)}>
                  ویرایش
                </SecondaryButton>
                <SecondaryButton
                  disabled={locked || !role.isActive}
                  onClick={() => {
                    setArchiveError("");
                    setArchiveReason("");
                    if (role.memberCount) {
                      // A refusal the owner can act on, in the card's own error
                      // slot, rather than opening a dialog that cannot succeed.
                      setError("پیش از بایگانی، اعضای این نقش را به نقش دیگری منتقل کنید.");
                      return;
                    }
                    setArchiving(role);
                  }}
                >
                  بایگانی
                </SecondaryButton>
              </div>
            </div>
          );
        })}
      </div>

      {editing ? (
        <RoleDialog
          role={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}

      {/* Issue #947 (TEAM-F08) — the archive confirmation, with its reason. */}
      <SecurityConfirmDialog
        open={archiving !== null}
        title={archiving ? `بایگانی نقش «${archiving.name}»` : ""}
        description="این نقش دیگر به کسی قابل تخصیص نیست."
        consequences={[
          "اعضایی که این نقش را دارند، دسترسی‌های آن نقش را از دست می‌دهند و به الگوی نقش سیستمی خود بازمی‌گردند.",
          "نقش بایگانی می‌شود و از فهرست قابل تخصیص خارج می‌شود؛ سابقهٔ حسابرسی دست‌نخورده می‌ماند.",
          "دلیل ثبت‌شده با نام شما در سابقهٔ دسترسی ثبت می‌شود.",
        ]}
        confirmLabel="بله، بایگانی شود"
        busy={archiveBusy}
        error={archiveError}
        reason={{
          label: "دلیل بایگانی این نقش",
          hint: "حداقل ۸ نویسه؛ همراه با نام شما در سابقهٔ حسابرسی ثبت می‌شود.",
          value: archiveReason,
          onChange: setArchiveReason,
          minLength: 8,
        }}
        onOpenChange={(next) => {
          if (!next) {
            setArchiving(null);
            setArchiveError("");
          }
        }}
        onConfirm={() => void archiveConfirmed()}
      />
    </section>
  );
}

function RoleDialog({ role, onClose, onSaved }: { role: TenantRole | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [selected, setSelected] = useState(new Set(role?.permissions ?? []));
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** Issue #854 (GAP 10): the branch policy new members of this role inherit. */
  const [scope, setScope] = useState<"all" | "selected" | "home" | "none">(
    role?.defaultLocationScope ?? "selected",
  );
  /**
   * Issue #854 (P2.4) — when the server will require a reason.
   *
   * A new role always changes what can be granted; an edit does when it adds or
   * removes capabilities. This mirrors `updateTenantRole` exactly, so the form asks
   * for the sentence in the same cases the service insists on it.
   */
  const permissionsChanged =
    [...selected].sort().join("\u0000") !== [...(role?.permissions ?? [])].sort().join("\u0000");
  const scopeChanged = role ? scope !== role.defaultLocationScope : false;
  const reasonRequired = !role || permissionsChanged || scopeChanged;
  /** Which risk levels this selection adds — shown before «ذخیره», not after. */
  const riskyKeys = useMemo(
    () =>
      [...selected].filter((permission) => {
        const meta = PERMISSION_METADATA.get(permission as Permission);
        return meta?.risk === "high" || meta?.risk === "critical";
      }),
    [selected],
  );
  const [riskyConfirmed, setRiskyConfirmed] = useState(false);

  async function save() {
    if (!name.trim()) {
      setError("نام نقش را وارد کنید.");
      return;
    }
    if (reasonRequired && reason.trim().length < 8) {
      setError("برای تعریف یا تغییر دسترسی‌های این نقش، دلیل را ثبت کنید (حداقل ۸ نویسه).");
      return;
    }
    /*
     * Issue #947 (TEAM-F08) — the risky-grant confirmation is now an in-dialog
     * acknowledgement with the granted keys *named*, instead of a `confirm()` whose
     * text («این نقش شامل دسترسی‌های حساس است») told the owner nothing about which
     * ones they were about to hand out.
     */
    if (riskyKeys.length > 0 && !riskyConfirmed) {
      setError("دسترسی‌های حساس انتخاب‌شده را تأیید کنید تا ذخیره ممکن شود.");
      return;
    }
    setBusy(true);
    setError("");
    const res = await api<{ error?: string; reason?: string }>(
      role ? `/api/team/roles/${role.id}` : "/api/team/roles",
      {
        method: role ? "PATCH" : "POST",
        body: JSON.stringify({
          ...(role ? { expectedRevision: role.revision } : {}),
          name: name.trim(),
          description: description.trim(),
          permissions: [...selected],
          ...(role ? (scopeChanged ? { defaultLocationScope: scope } : {}) : { defaultLocationScope: scope }),
          reason: reason.trim() || undefined,
        }),
      },
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.data.reason || res.data.error || "ذخیره ناموفق بود.");
      return;
    }
    onSaved();
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{role ? "ویرایش نقش سفارشی" : "نقش سفارشی جدید"}</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="نام نقش">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="توضیح">
            <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <div className="mt-3">
          <Field
            label="سیاست پیش‌فرض شعبه برای اعضای جدید"
            hint="وقتی عضوی این نقش را بدون انتخاب شعبه بگیرد، این سیاست اعمال می‌شود."
          >
            <select className={inputClass} value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
              <option value="all">همهٔ شعبه‌ها</option>
              <option value="selected">شعبه‌های انتخابی (نیاز به انتخاب هنگام عضوگیری)</option>
              <option value="home">فقط شعبهٔ اصلی (نیاز به تعیین هنگام عضوگیری)</option>
              <option value="none">بدون دسترسی شعبه</option>
            </select>
          </Field>
        </div>
        <PermissionEditor preset={new Set()} selected={selected} onChange={(next) => { setSelected(next); setRiskyConfirmed(false); }} />
        {riskyKeys.length > 0 ? (
          <div className="mt-3 rounded-xl border border-amber-300/60 bg-amber-50/60 p-3 text-xs dark:bg-amber-950/20">
            <p className="font-semibold text-amber-800 dark:text-amber-200">
              {riskyKeys.length.toLocaleString("fa-IR")} دسترسی حساس در این نقش هست:
            </p>
            <ul className="mt-1 list-disc space-y-1 ps-4 text-muted-foreground">
              {riskyKeys.map((permission) => (
                <li key={permission}>{PERMISSION_METADATA.get(permission as Permission)?.label ?? permission}</li>
              ))}
            </ul>
            <label className="mt-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={riskyConfirmed}
                onChange={(event) => setRiskyConfirmed(event.target.checked)}
              />
              <span>این دسترسی‌ها را بررسی کردم و می‌خواهم به این نقش داده شوند.</span>
            </label>
          </div>
        ) : null}
        {reasonRequired ? (
          <Field label="دلیل این تغییر دسترسی" hint="با نام شما و خودِ تغییر در سابقهٔ حسابرسی ثبت می‌شود.">
            <textarea className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} />
          </Field>
        ) : null}
        <DialogFooter>
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton disabled={busy} onClick={save}>ذخیره</PrimaryButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
