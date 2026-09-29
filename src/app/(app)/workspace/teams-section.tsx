"use client";

/**
 * «تیم‌ها» — who is on which project, and with what role.
 *
 * Project roles are the SECOND permission layer, not a replacement for the
 * first: a user needs the platform permission («مشاهدهٔ میز کار» و بالاتر) to
 * reach the module at all, and then their row here decides what they may do
 * inside a particular project. The screen says that in words, because a role
 * picker that silently does nothing for a user without the platform permission
 * would be worse than no picker.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { PlusIcon, Trash2Icon, UsersIcon } from "lucide-react";
import {
  EmptyState,
  LoadingSkeleton,
  SectionCard,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import { api, ErrorBox, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { formatJalali } from "@/lib/jalali";
import {
  WORKSPACE_CAPABILITY_MIN_ROLE,
  WORKSPACE_ROLES,
  WORKSPACE_ROLE_DESCRIPTIONS,
  WORKSPACE_ROLE_LABELS,
  roleCan,
  type WorkspaceRole,
} from "@/lib/workspace-shared";
import { PickerField, SelectField, workspaceError } from "./workspace-ui";
import type { WorkspaceLookups } from "./use-workspace-lookups";

interface MemberRow {
  id: string;
  projectId: string;
  userId: string;
  fullName: string;
  role: WorkspaceRole;
  createdAt: string;
}

const CAPABILITY_LABELS: Record<keyof typeof WORKSPACE_CAPABILITY_MIN_ROLE, string> = {
  view: "مشاهده",
  contribute: "مشارکت",
  edit: "ویرایش",
  manage: "مدیریت",
  administer: "راهبری",
};

export function TeamsSection({
  lookups,
  canManage,
  projectId: fixedProjectId,
}: {
  lookups: WorkspaceLookups;
  canManage: boolean;
  projectId?: string;
}) {
  const [projectId, setProjectId] = useState(fixedProjectId ?? "");
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [error, setError] = useState("");
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState<WorkspaceRole | "">("editor");
  const [busy, setBusy] = useState(false);

  // Default to the first project so the screen is never an empty picker over a
  // business that does have projects.
  useEffect(() => {
    if (!projectId && lookups.projects.length) setProjectId(lookups.projects[0].id);
  }, [projectId, lookups.projects]);

  const load = useCallback(() => {
    if (!projectId) {
      setMembers([]);
      return;
    }
    setMembers(null);
    api<{ members: MemberRow[] }>(`/api/workspace/projects/${projectId}/members`).then(
      ({ ok, data }) => {
        if (ok) setMembers(data.members);
        else {
          setMembers([]);
          setError(workspaceError((data as unknown as { error?: string }).error));
        }
      },
    );
  }, [projectId]);

  useEffect(load, [load]);

  async function setRole(userId: string, role: WorkspaceRole) {
    if (busy) return;
    setBusy(true);
    const { ok, data } = await api<{ members: MemberRow[] }>(
      `/api/workspace/projects/${projectId}/members`,
      { method: "PUT", body: JSON.stringify({ userId, role }) },
    );
    setBusy(false);
    if (ok) setMembers(data.members);
    else setError(workspaceError((data as unknown as { error?: string }).error));
  }

  async function remove(userId: string) {
    if (busy) return;
    setBusy(true);
    const { ok, data } = await api<{ members: MemberRow[] }>(
      `/api/workspace/projects/${projectId}/members?userId=${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
    setBusy(false);
    if (ok) setMembers(data.members);
    else setError(workspaceError((data as unknown as { error?: string }).error));
  }

  async function add() {
    if (!addUserId || !addRole || busy) return;
    await setRole(addUserId, addRole);
    setAddUserId("");
  }

  // ⚡ Bolt: Extract O(N) lookup set and filtering into useMemo to prevent
  // recreating the array and Set on every component render.
  const addable = useMemo(() => {
    const memberIds = new Set((members ?? []).map((m) => m.userId));
    return lookups.members.filter((m) => !memberIds.has(m.id));
  }, [members, lookups.members]);

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <SectionCard
        title="تیم پروژه"
        description="نقش هر عضو در یک پروژهٔ مشخص. این نقش‌ها روی مجوزهای کاربری کسب‌وکار سوار می‌شوند و جای آن‌ها را نمی‌گیرند."
      >
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          {fixedProjectId ? null : (
            <PickerField
              label="پروژه"
              value={projectId}
              onChange={setProjectId}
              options={lookups.projects.map((p) => ({ id: p.id, label: p.name }))}
              placeholder="— پروژه‌ای انتخاب کنید —"
            />
          )}
        </div>

        {!projectId ? (
          <EmptyState icon={UsersIcon} title="پروژه‌ای انتخاب نشده است">
            برای دیدن و تغییر اعضا، ابتدا یک پروژه انتخاب کنید.
          </EmptyState>
        ) : members === null ? (
          <LoadingSkeleton rows={4} label="در حال بارگذاری اعضا" />
        ) : members.length === 0 ? (
          <EmptyState icon={UsersIcon} title="این پروژه هنوز عضوی ندارد">
            مالک پروژه به‌صورت خودکار عضو است؛ بقیه را از فرم پایین اضافه کنید.
          </EmptyState>
        ) : (
          <DataTable caption="اعضای پروژه">
            <DataTableHead>
              <tr>
                <Th>عضو</Th>
                <Th>نقش در پروژه</Th>
                <Th>از تاریخ</Th>
                <Th>حذف</Th>
              </tr>
            </DataTableHead>
            <DataTableBody>
              {members.map((member) => (
                <DataTableRow key={member.id}>
                  <Td>
                    <span className="font-medium">{member.fullName}</span>
                  </Td>
                  <Td>
                    {canManage ? (
                      <select
                        className={inputClass}
                        value={member.role}
                        disabled={busy}
                        aria-label={`نقش ${member.fullName}`}
                        onChange={(e) => setRole(member.userId, e.target.value as WorkspaceRole)}
                      >
                        {WORKSPACE_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {WORKSPACE_ROLE_LABELS[role]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <StatusBadge tone={member.role === "owner" ? "active" : "neutral"}>
                        {WORKSPACE_ROLE_LABELS[member.role]}
                      </StatusBadge>
                    )}
                  </Td>
                  <Td>
                    <span className="tabular-nums">{formatJalali(member.createdAt)}</span>
                  </Td>
                  <Td>
                    {canManage ? (
                      <SecondaryButton onClick={() => remove(member.userId)} disabled={busy}>
                        <Trash2Icon className="size-4" aria-hidden />
                        <span className="sr-only">حذف {member.fullName}</span>
                      </SecondaryButton>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>

      {canManage && projectId ? (
        <SectionCard title="افزودن عضو" description="فقط کاربران فعال همین کسب‌وکار">
          <div className="grid gap-3 p-4 sm:grid-cols-3">
            <PickerField
              label="کاربر"
              value={addUserId}
              onChange={setAddUserId}
              options={addable.map((m) => ({ id: m.id, label: m.fullName }))}
              placeholder={addable.length ? "— انتخاب کنید —" : "همهٔ کاربران عضو هستند"}
            />
            <SelectField
              label="نقش"
              value={addRole}
              onChange={setAddRole}
              options={WORKSPACE_ROLES}
              labels={WORKSPACE_ROLE_LABELS}
              hint={addRole ? WORKSPACE_ROLE_DESCRIPTIONS[addRole] : undefined}
            />
            <Field label=" " as="div">
              <PrimaryButton type="button" onClick={add} disabled={!addUserId || busy}>
                <PlusIcon className="size-4" aria-hidden />
                افزودن به تیم
              </PrimaryButton>
            </Field>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="نقش‌ها چه اجازه‌ای می‌دهند"
        description="هر نقش همهٔ توانایی‌های نقش پایین‌تر را هم دارد."
      >
        <DataTable caption="اجازه‌های هر نقش در پروژه">
          <DataTableHead>
            <tr>
              <Th>نقش</Th>
              {(Object.keys(CAPABILITY_LABELS) as Array<keyof typeof CAPABILITY_LABELS>).map(
                (capability) => (
                  <Th key={capability}>{CAPABILITY_LABELS[capability]}</Th>
                ),
              )}
            </tr>
          </DataTableHead>
          <DataTableBody>
            {WORKSPACE_ROLES.map((role) => (
              <DataTableRow key={role}>
                <Td>
                  <div className="font-medium">{WORKSPACE_ROLE_LABELS[role]}</div>
                  <div className="text-xs text-muted-foreground">
                    {WORKSPACE_ROLE_DESCRIPTIONS[role]}
                  </div>
                </Td>
                {(Object.keys(CAPABILITY_LABELS) as Array<keyof typeof CAPABILITY_LABELS>).map(
                  (capability) => (
                    <Td key={capability}>
                      {roleCan(role, capability) ? (
                        <StatusBadge tone="positive">بله</StatusBadge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </Td>
                  ),
                )}
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      </SectionCard>
    </div>
  );
}
