"use client";

/**
 * «قراردادها» — EXECUTION contracts only.
 *
 * The split the brief asks for, made visible: this screen holds the contracts
 * that deliver a project (پیمانکار، تأمین‌کننده، مشاور، پیمانکار جزء), while the
 * relationship contracts — sales, service, partnership — stay on the customer's
 * file in the CRM. The note in the header says so on screen, because a user who
 * cannot find their sales agreement here should be told where it is rather than
 * left to conclude the product lost it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileSignatureIcon, PlusIcon, XIcon } from "lucide-react";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  LoadingSkeleton,
  SectionCard,
  overlayPanelClass,
} from "@/app/dashboard/page-chrome";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import { FilterChip, FilterChipRow, SearchField } from "@/app/dashboard/filters";
import {
  api,
  ErrorBox,
  Field,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import {
  CONTRACT_DEFAULT_REMINDER_DAYS,
  CONTRACT_STATUSES,
  CONTRACT_STATUS_LABELS,
  CONTRACT_TYPES,
  CONTRACT_TYPE_LABELS,
  type WorkspaceApprovalStatus,
  type WorkspaceContractStatus,
  type WorkspaceContractType,
} from "@/lib/workspace-shared";
import {
  ApprovalStatusBadge,
  ContractStatusBadge,
  DateCell,
  DateField,
  PickerField,
  SelectField,
  workspaceError,
  LoadMoreFooter,
} from "./workspace-ui";
import { usePagedList } from "./use-paged-list";

interface ContractSummary {
  total: number;
  active: number;
  pending: number;
  valueRial: number;
}
import type { WorkspaceLookups } from "./use-workspace-lookups";

export interface ContractRow {
  id: string;
  projectId: string | null;
  projectName: string | null;
  partyId: string | null;
  partyName: string | null;
  title: string;
  contractType: WorkspaceContractType;
  valueRial: number | null;
  startDate: string | null;
  endDate: string | null;
  status: WorkspaceContractStatus;
  reminderDays: number | null;
  notes: string;
  documentCount: number;
  approvalStatus: WorkspaceApprovalStatus | null;
}

export function ContractsSection({
  lookups,
  canManageContracts,
  canRequestApproval,
  initialExpiring,
  projectId,
}: {
  lookups: WorkspaceLookups;
  canManageContracts: boolean;
  canRequestApproval: boolean;
  initialExpiring?: number;
  /** Inside a project page: only that project's contracts, and new ones default to it. */
  projectId?: string;
}) {
  const money = useMoney();
  const [error, setError] = useState("");
  const [status, setStatus] = useState<WorkspaceContractStatus | "">("");
  const [expiring, setExpiring] = useState(initialExpiring ?? 0);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<ContractRow | null>(null);
  const [creating, setCreating] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (status) params.set("status", status);
    if (expiring) params.set("expiringWithinDays", String(expiring));
    if (search.trim()) params.set("q", search.trim());
    const qs = params.toString();
    return `/api/workspace/contracts${qs ? `?${qs}` : ""}`;
  }, [projectId, status, expiring, search]);
  const list = usePagedList<ContractRow, ContractSummary>(query, "contracts");
  const contracts = list.rows;
  const load = list.reload;
  useEffect(() => {
    if (list.error) setError(list.error);
  }, [list.error]);

  // Server totals over the whole filtered set — not the loaded page.
  const totals = {
    count: list.summary?.total ?? 0,
    active: list.summary?.active ?? 0,
    value: list.summary?.valueRial ?? 0,
    pending: list.summary?.pending ?? 0,
  };

  async function requestApproval(contract: ContractRow) {
    const { ok, data } = await api("/api/workspace/approvals", {
      method: "POST",
      body: JSON.stringify({
        subjectType: "contract",
        subjectId: contract.id,
        projectId: contract.projectId,
        title: contract.title,
      }),
    });
    if (ok) load();
    else setError(workspaceError((data as unknown as { error?: string }).error));
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <KpiRow>
        <KpiCard
          label="قراردادها"
          value={toPersianDigits(String(totals.count))}
          icon={FileSignatureIcon}
        />
        <KpiCard label="جاری" value={toPersianDigits(String(totals.active))} />
        <KpiCard label="مجموع مبلغ" value={money.format(totals.value)} />
        <KpiCard label="در انتظار تأیید" value={toPersianDigits(String(totals.pending))} />
      </KpiRow>

      <SectionCard
        title="قراردادهای اجرایی"
        description="قرارداد با پیمانکار، تأمین‌کننده، مشاور و پیمانکار جزء. قراردادهای فروش و خدمات مشتری در پروندهٔ همان مشتری در «مدیریت ارتباط با مشتری» نگهداری می‌شوند."
        actions={
          canManageContracts ? (
            <PrimaryButton type="button" onClick={() => setCreating(true)}>
              <PlusIcon className="size-4" aria-hidden />
              قرارداد جدید
            </PrimaryButton>
          ) : null
        }
        flush
      >
        <div className="flex flex-col gap-3 border-b border-border/80 p-4">
          <SearchField
            label="جست‌وجوی قرارداد"
            value={search}
            onChange={setSearch}
            placeholder="عنوان قرارداد…"
            onClear={() => setSearch("")}
          />
          <FilterChipRow label="فیلتر وضعیت قرارداد">
            <FilterChip selected={status === "" && !expiring} onClick={() => { setStatus(""); setExpiring(0); }}>
              همه
            </FilterChip>
            {CONTRACT_STATUSES.map((value) => (
              <FilterChip key={value} selected={status === value} onClick={() => setStatus(value)}>
                {CONTRACT_STATUS_LABELS[value]}
              </FilterChip>
            ))}
            <FilterChip selected={expiring === 30} onClick={() => setExpiring(expiring === 30 ? 0 : 30)}>
              انقضا در ۳۰ روز
            </FilterChip>
          </FilterChipRow>
        </div>

        {contracts === null ? (
          <LoadingSkeleton rows={5} label="در حال بارگذاری قراردادها" />
        ) : contracts.length === 0 ? (
          <EmptyState icon={FileSignatureIcon} title="قراردادی ثبت نشده است">
            قرارداد پیمانکار یا تأمین‌کنندهٔ هر پروژه را اینجا ثبت کنید تا مبلغ، مهلت و اسناد آن یکجا بماند.
          </EmptyState>
        ) : (
          <DataTable caption="فهرست قراردادهای اجرایی" frame={false}>
            <DataTableHead>
              <Th>عنوان</Th>
              <Th>نوع</Th>
              <Th>طرف قرارداد</Th>
              <Th>پروژه</Th>
              <Th>مبلغ</Th>
              <Th>انقضا</Th>
              <Th>وضعیت</Th>
              <Th>تأیید</Th>
            </DataTableHead>
            <DataTableBody>
              {contracts.map((contract) => (
                <DataTableRow key={contract.id} onClick={() => setEditing(contract)}>
                  <Td>
                    <span className="font-medium">{contract.title}</span>
                  </Td>
                  <Td>{CONTRACT_TYPE_LABELS[contract.contractType]}</Td>
                  <Td>{contract.partyName ?? <span className="text-muted-foreground">—</span>}</Td>
                  <Td>{contract.projectName ?? <span className="text-muted-foreground">—</span>}</Td>
                  <Td className="tabular-nums">
                    {contract.valueRial === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      money.format(contract.valueRial)
                    )}
                  </Td>
                  <Td>
                    <DateCell date={contract.endDate} />
                  </Td>
                  <Td>
                    <ContractStatusBadge status={contract.status} />
                  </Td>
                  <Td>
                    {contract.approvalStatus ? (
                      <ApprovalStatusBadge status={contract.approvalStatus} />
                    ) : canRequestApproval && contract.status === "draft" ? (
                      <SecondaryButton onClick={() => requestApproval(contract)}>
                        درخواست تأیید
                      </SecondaryButton>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
        <LoadMoreFooter
          loaded={contracts?.length ?? 0}
          page={list.page}
          loading={list.loadingMore}
          onLoadMore={list.loadMore}
        />
      </SectionCard>

      {creating || editing ? (
        <ContractDialog
          lookups={lookups}
          contract={editing ?? undefined}
          defaultProjectId={projectId}
          canManage={canManageContracts}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            load();
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function ContractDialog({
  lookups,
  contract,
  defaultProjectId,
  canManage,
  onClose,
  onSaved,
  onError,
}: {
  lookups: WorkspaceLookups;
  contract?: ContractRow;
  defaultProjectId?: string;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const money = useMoney();
  const [title, setTitle] = useState(contract?.title ?? "");
  const [contractType, setContractType] = useState<WorkspaceContractType | "">(
    contract?.contractType ?? "contractor",
  );
  const [status, setStatus] = useState<WorkspaceContractStatus | "">(contract?.status ?? "draft");
  const [projectId, setProjectId] = useState(contract?.projectId ?? defaultProjectId ?? "");
  const [partyId, setPartyId] = useState(contract?.partyId ?? "");
  const [value, setValue] = useState(
    contract?.valueRial != null ? String(money.toInput(contract.valueRial)) : "",
  );
  const [startDate, setStartDate] = useState(contract?.startDate ?? "");
  const [endDate, setEndDate] = useState(contract?.endDate ?? "");
  const [reminderDays, setReminderDays] = useState(
    String(contract?.reminderDays ?? CONTRACT_DEFAULT_REMINDER_DAYS),
  );
  const [notes, setNotes] = useState(contract?.notes ?? "");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!title.trim() || saving) return;
    setSaving(true);
    const payload = {
      title,
      contractType: contractType || "other",
      status: status || "draft",
      projectId: projectId || null,
      partyId: partyId || null,
      valueRial: value.trim() ? money.parse(value) : null,
      startDate: startDate || null,
      endDate: endDate || null,
      reminderDays: reminderDays.trim() ? Number(reminderDays) : null,
      notes,
    };
    const { ok, data } = contract
      ? await api(`/api/workspace/contracts/${contract.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      : await api("/api/workspace/contracts", { method: "POST", body: JSON.stringify(payload) });
    setSaving(false);
    if (ok) onSaved();
    else onError(workspaceError((data as unknown as { error?: string }).error));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-2xl`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">
            {contract ? "ویرایش قرارداد" : "قرارداد اجرایی جدید"}
          </h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="عنوان قرارداد">
              <input
                className={inputClass}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
              />
            </Field>
          </div>
          <SelectField
            label="نوع"
            value={contractType}
            onChange={setContractType}
            options={CONTRACT_TYPES}
            labels={CONTRACT_TYPE_LABELS}
          />
          <SelectField
            label="وضعیت"
            value={status}
            onChange={setStatus}
            options={CONTRACT_STATUSES}
            labels={CONTRACT_STATUS_LABELS}
          />
          <PickerField
            label="پروژه"
            value={projectId}
            onChange={setProjectId}
            options={lookups.projects.map((p) => ({ id: p.id, label: p.name }))}
            placeholder="— بدون پروژه —"
            hint="قرارداد چارچوبی می‌تواند پیش از پروژه ثبت شود."
          />
          <PickerField
            label="طرف قرارداد"
            value={partyId}
            onChange={setPartyId}
            options={lookups.parties.map((p) => ({ id: p.id, label: p.name }))}
          />
          <Field label={`مبلغ (${money.unitLabel})`}>
            <input
              className={inputClass}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode="numeric"
            />
          </Field>
          <Field label="یادآوری پیش از انقضا (روز)">
            <input
              className={inputClass}
              value={reminderDays}
              onChange={(e) => setReminderDays(e.target.value)}
              inputMode="numeric"
            />
          </Field>
          <DateField label="تاریخ شروع" value={startDate} onChange={setStartDate} />
          <DateField label="تاریخ انقضا" value={endDate} onChange={setEndDate} />
          <div className="sm:col-span-2">
            <Field label="یادداشت">
              <textarea
                className={`${inputClass} min-h-20`}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border/80 p-4">
          <SecondaryButton onClick={onClose}>بستن</SecondaryButton>
          {canManage ? (
            <PrimaryButton type="button" onClick={submit} disabled={!title.trim() || saving}>
              {saving ? "در حال ذخیره" : "ذخیره"}
            </PrimaryButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}
