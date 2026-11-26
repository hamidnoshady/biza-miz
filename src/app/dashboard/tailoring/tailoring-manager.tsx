"use client";

/**
 * GH #1567 Phase 6A — the alteration / made-to-measure desk for a fashion
 * business.
 *
 * One screen, sized for the one-person boutique first: a board of the
 * branch's jobs (the active branch — the shell's branch switcher is the
 * branch filter, and the API refuses another branch's jobs), a status filter
 * and a search, and one right-side sheet that carries a job from intake to
 * pickup. Larger shops get the same screen; the event trail names who did
 * each step.
 *
 * Nothing here invents a second workflow:
 *   - customers are the canonical CRM parties (the shared CustomerPicker,
 *     including its quick-create),
 *   - money is the ordinary order/invoice — a priced job links the sale and
 *     cannot be picked up without it,
 *   - every step goes through `planTailoringTransition` server-side under an
 *     optimistic lock (`expectedVersion`), so two people editing one job get
 *     a conflict, not a silent overwrite.
 *
 * Permissions decide what mounts, not just what is disabled: a manager with
 * `tailoring.manage` but without `tailoring.measurements` gets the board and
 * the workflow and never mounts the measurements panel, so no request for
 * body measurements is ever made on their behalf.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { PlusIcon, ScissorsIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import {
  TAILORING_STATUS_LABELS,
  type TailoringKind,
  type TailoringStatus,
} from "@/lib/tailoring-workflow";
import { CustomerPicker, type PickerCustomer } from "../customer-picker";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "../data-table";
import { FilterChip, FilterChipRow } from "../filters";
import { IndustryManagerShell } from "../industry-manager-shell";
import { JalaliDatePicker } from "../jalali-date-picker";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "../page-chrome";
import { api, ErrorBox, InfoBox } from "../ui";
import { formatDate, MeasurementsPanel } from "./measurements-panel";
import { tailoringErrorMessage } from "./tailoring-errors";

export interface TailoringJob {
  id: string;
  locationId: string;
  partyId: string;
  partyName: string | null;
  measurementProfileId: string | null;
  kind: TailoringKind;
  description: string;
  status: TailoringStatus;
  estimateRial: string | null;
  approvedAt: string | null;
  dueDate: string | null;
  orderId: string | null;
  fittingCount: number;
  reworkCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface JobEvent {
  id: string;
  fromStatus: TailoringStatus | null;
  toStatus: TailoringStatus;
  actorName: string;
  note: string | null;
  at: string;
}

export interface TailoringPermissions {
  canManage: boolean;
  canMeasure: boolean;
  canExport: boolean;
  canErase: boolean;
  canRetention: boolean;
  canViewOrders: boolean;
}

export const KIND_LABELS: Record<TailoringKind, string> = {
  alteration: "تعمیر و اصلاح",
  made_to_measure: "دوخت سفارشی",
};

/** The happy path, for the progress line; `cancelled` is off the path. */
const PATH: readonly TailoringStatus[] = ["intake", "estimated", "approved", "fitting", "qc", "ready", "picked_up"];

/** Board filters: what a tailor asks of the queue, not one chip per state. */
const FILTERS = [
  { key: "active", label: "در جریان", match: (s: TailoringStatus) => s !== "picked_up" && s !== "cancelled" },
  { key: "approval", label: "منتظر تأیید مشتری", match: (s: TailoringStatus) => s === "estimated" },
  { key: "fitting", label: "پرو", match: (s: TailoringStatus) => s === "approved" || s === "fitting" },
  { key: "qc", label: "کنترل کیفیت", match: (s: TailoringStatus) => s === "qc" },
  { key: "ready", label: "آمادهٔ تحویل", match: (s: TailoringStatus) => s === "ready" },
  { key: "done", label: "تحویل شده", match: (s: TailoringStatus) => s === "picked_up" },
  { key: "cancelled", label: "لغو شده", match: (s: TailoringStatus) => s === "cancelled" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

export function statusTone(status: TailoringStatus): "active" | "positive" | "neutral" | "danger" {
  if (status === "ready" || status === "picked_up") return "positive";
  if (status === "cancelled") return "danger";
  if (status === "intake") return "neutral";
  return "active";
}

/** «مرحلهٔ ۳ از ۷» — cancelled jobs have no progress. */
export function progressLabel(status: TailoringStatus): string {
  const index = PATH.indexOf(status);
  if (index < 0) return "—";
  return `مرحلهٔ ${toPersianDigits(String(index + 1))} از ${toPersianDigits(String(PATH.length))}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isOverdue(job: Pick<TailoringJob, "dueDate" | "status">, today = todayIso()): boolean {
  return Boolean(job.dueDate) && job.dueDate! < today && job.status !== "picked_up" && job.status !== "cancelled";
}

type ManagerTab = "jobs" | "measurements" | "retention";

export function TailoringManager({ permissions }: { permissions: TailoringPermissions }) {
  const tabs = useMemo(() => [
    ...(permissions.canManage ? [{ key: "jobs" as const, label: "سفارش‌های خیاطی" }] : []),
    ...(permissions.canMeasure ? [{ key: "measurements" as const, label: "اندازه‌های مشتری" }] : []),
    ...(permissions.canRetention ? [{ key: "retention" as const, label: "نگهداری داده" }] : []),
  ], [permissions]);
  const [tab, setTab] = useState<ManagerTab>(tabs[0]?.key ?? "jobs");

  if (tabs.length === 0) {
    return <EmptyState title="دسترسی ندارید" icon={ScissorsIcon}>برای این بخش به دسترسی «خیاطی» یا «اندازه‌های بدن» نیاز است.</EmptyState>;
  }

  return (
    <IndustryManagerShell idPrefix="tailoring" navLabel="بخش‌های خیاطی و دوخت" tabs={tabs} activeTab={tab} onTabChange={setTab} error="">
      {tab === "jobs" && permissions.canManage ? <JobsBoard permissions={permissions} /> : null}
      {tab === "measurements" && permissions.canMeasure ? <CustomerMeasurements permissions={permissions} /> : null}
      {tab === "retention" && permissions.canRetention ? <RetentionSection /> : null}
    </IndustryManagerShell>
  );
}

function JobsBoard({ permissions }: { permissions: TailoringPermissions }) {
  const money = useMoney();
  const [jobs, setJobs] = useState<TailoringJob[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<FilterKey>("active");
  const [search, setSearch] = useState("");
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const res = await api<{ jobs?: TailoringJob[]; error?: string }>("/api/tailoring/jobs");
    if (!res.ok) {
      setError(tailoringErrorMessage(res.data.error));
      setJobs((prev) => prev ?? []);
      return;
    }
    setError("");
    setJobs(res.data.jobs ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, (jobs ?? []).filter((job) => f.match(job.status)).length])), [jobs]);
  const visible = useMemo(() => {
    const active = FILTERS.find((f) => f.key === filter)!;
    const needle = search.trim().toLowerCase();
    return (jobs ?? [])
      .filter((job) => active.match(job.status))
      .filter((job) => !needle || (job.partyName ?? "").toLowerCase().includes(needle) || job.description.toLowerCase().includes(needle));
  }, [jobs, filter, search]);

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      <SectionCard
        title="سفارش‌های خیاطی این شعبه"
        description="پذیرش، برآورد، تأیید مشتری، پرو، کنترل کیفیت و تحویل — همه در یک جا."
        actions={(
          <Button type="button" onClick={() => setCreating(true)}>
            <PlusIcon aria-hidden="true" />
            سفارش جدید
          </Button>
        )}
      >
        <div className="space-y-3">
          <FilterChipRow label="فیلتر وضعیت سفارش خیاطی">
            {FILTERS.map((f) => (
              <FilterChip key={f.key} selected={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.label} ({toPersianDigits(String(counts[f.key] ?? 0))})
              </FilterChip>
            ))}
          </FilterChipRow>
          <div className="relative max-w-sm">
            <SearchIcon aria-hidden="true" className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground" />
            <Input
              aria-label="جست‌وجوی مشتری یا شرح کار"
              placeholder="جست‌وجوی مشتری یا شرح کار"
              className="ps-9"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>
      </SectionCard>

      {jobs === null ? (
        <SectionCardSkeleton rows={4} label="در حال خواندن سفارش‌های خیاطی" />
      ) : visible.length === 0 ? (
        <EmptyState
          title={jobs.length === 0 ? "هنوز سفارش خیاطی ثبت نشده" : "سفارشی با این فیلتر نیست"}
          icon={ScissorsIcon}
          action={jobs.length === 0 ? (
            <Button type="button" onClick={() => setCreating(true)}>ثبت اولین سفارش</Button>
          ) : (
            <Button type="button" variant="outline" onClick={() => { setFilter("active"); setSearch(""); }}>پاک‌کردن فیلترها</Button>
          )}
        >
          {jobs.length === 0
            ? "تعمیر، کوتاه‌کردن یا دوخت سفارشی را برای یک مشتری ثبت کنید؛ پیشرفت کار تا تحویل همین‌جا دیده می‌شود."
            : "فیلتر دیگری را انتخاب کنید یا عبارت جست‌وجو را تغییر دهید."}
        </EmptyState>
      ) : (
        <DataTable caption="سفارش‌های خیاطی">
          <DataTableHead>
            <Th>مشتری</Th>
            <Th>کار</Th>
            <Th>وضعیت</Th>
            <Th>پیشرفت</Th>
            <Th>موعد تحویل</Th>
            <Th>برآورد</Th>
          </DataTableHead>
          <DataTableBody>
            {visible.map((job) => (
              <DataTableRow key={job.id} onClick={() => setOpenJobId(job.id)} aria-label={`باز کردن سفارش ${job.partyName ?? ""}`}>
                <Td>{job.partyName ?? "—"}</Td>
                <Td>
                  <span className="block font-medium">{KIND_LABELS[job.kind]}</span>
                  <span className="block max-w-xs truncate text-xs text-muted-foreground">{job.description}</span>
                </Td>
                <Td>
                  <StatusBadge tone={statusTone(job.status)}>{TAILORING_STATUS_LABELS[job.status]}</StatusBadge>
                  {job.reworkCount > 0 ? <span className="ms-1 text-xs text-muted-foreground">دوباره‌کاری {toPersianDigits(String(job.reworkCount))}</span> : null}
                </Td>
                <Td>{progressLabel(job.status)}</Td>
                <Td>
                  {job.dueDate ? formatDate(job.dueDate) : "—"}
                  {isOverdue(job) ? <> <StatusBadge tone="danger">دیرکرد</StatusBadge></> : null}
                </Td>
                <Td>{job.estimateRial !== null ? money.formatText(job.estimateRial) : "—"}</Td>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}

      <Sheet open={creating} onOpenChange={setCreating}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>سفارش خیاطی جدید</SheetTitle>
            <SheetDescription>مشتری، نوع کار و شرح آن را ثبت کنید. برآورد و تأیید مشتری در مرحلهٔ بعد ثبت می‌شود.</SheetDescription>
          </SheetHeader>
          {creating ? (
            <CreateJobForm
              permissions={permissions}
              onCreated={(job) => {
                setCreating(false);
                void load();
                setOpenJobId(job.id);
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      <Sheet open={openJobId !== null} onOpenChange={(open) => { if (!open) setOpenJobId(null); }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
          {openJobId ? <JobDetail jobId={openJobId} permissions={permissions} onChanged={() => void load()} /> : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function CreateJobForm({ permissions, onCreated }: { permissions: TailoringPermissions; onCreated: (job: TailoringJob) => void }) {
  const [customer, setCustomer] = useState<PickerCustomer | null>(null);
  const [kind, setKind] = useState<TailoringKind>("alteration");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [profileId, setProfileId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (!customer) {
      setError("مشتری را انتخاب یا اضافه کنید.");
      return;
    }
    if (!description.trim()) {
      setError(tailoringErrorMessage("tailoring_description_required"));
      return;
    }
    setBusy(true);
    setError("");
    const res = await api<{ job?: TailoringJob; error?: string }>("/api/tailoring/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        partyId: customer.id,
        kind,
        description: description.trim(),
        dueDate: dueDate || null,
        measurementProfileId: profileId,
      }),
    });
    setBusy(false);
    if (!res.ok || !res.data.job) {
      setError(tailoringErrorMessage(res.data.error));
      return;
    }
    onCreated(res.data.job);
  }

  return (
    // Not a <form>: the measurements panel inside has forms of its own, and
    // forms must not nest.
    <div className="space-y-4 px-4 pb-6">
      <ErrorBox>{error}</ErrorBox>
      <div className="space-y-1.5">
        <Label>مشتری</Label>
        <CustomerPicker customer={customer} onChange={(next) => { setCustomer(next); setProfileId(null); }} idPrefix="tailoring-new" />
      </div>
      <FilterChipRow label="نوع کار">
        {(Object.keys(KIND_LABELS) as TailoringKind[]).map((key) => (
          <FilterChip key={key} selected={kind === key} onClick={() => setKind(key)}>{KIND_LABELS[key]}</FilterChip>
        ))}
      </FilterChipRow>
      <p className="text-xs text-muted-foreground">
        {kind === "made_to_measure" ? "دوخت سفارشی پیش از کنترل کیفیت دست‌کم یک پرو لازم دارد." : "تعمیر ساده می‌تواند بدون پرو به کنترل کیفیت برود."}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="tailoring-new-description">شرح کار و جزئیات لباس</Label>
        <Textarea
          id="tailoring-new-description"
          value={description}
          maxLength={1000}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="مثلاً: کوتاه‌کردن سرآستین کت سرمه‌ای، ۲ سانت"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="tailoring-new-due">موعد تحویل</Label>
        <JalaliDatePicker id="tailoring-new-due" value={dueDate} onChange={setDueDate} />
      </div>
      {customer && permissions.canMeasure ? (
        <MeasurementsPanel
          partyId={customer.id}
          customerName={customer.name}
          canExport={permissions.canExport}
          canErase={false}
          onCurrentVersion={setProfileId}
        />
      ) : customer ? (
        <InfoBox>اندازه‌های بدن فقط برای کاربران دارای دسترسی «اندازه‌های بدن» نمایش داده می‌شود.</InfoBox>
      ) : null}
      {profileId ? <p className="text-xs text-muted-foreground">نسخهٔ فعلی اندازه‌ها به این سفارش پیوست می‌شود.</p> : null}
      <Button type="button" disabled={busy} onClick={() => void submit()}>ثبت سفارش</Button>
    </div>
  );
}

interface OrderOption {
  id: string;
  order_number: string;
  status: string;
  customer_id: string | null;
  customer_name: string | null;
  total: string;
  opened_at: string;
}

function JobDetail({ jobId, permissions, onChanged }: { jobId: string; permissions: TailoringPermissions; onChanged: () => void }) {
  const money = useMoney();
  const [job, setJob] = useState<TailoringJob | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [estimate, setEstimate] = useState("");
  const [approved, setApproved] = useState(false);
  const [orderQuery, setOrderQuery] = useState("");
  const [orders, setOrders] = useState<OrderOption[] | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ job?: TailoringJob; events?: JobEvent[]; error?: string }>(`/api/tailoring/jobs/${jobId}`);
    if (!res.ok || !res.data.job) {
      setError(tailoringErrorMessage(res.data.error));
      return;
    }
    setJob(res.data.job);
    setEvents(res.data.events ?? []);
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function step(to: TailoringStatus, extra: Record<string, unknown> = {}) {
    if (!job) return;
    setBusy(true);
    setError("");
    const res = await api<{ job?: TailoringJob; error?: string }>(`/api/tailoring/jobs/${job.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "transition", to, expectedVersion: job.version, note: note.trim() || null, ...extra }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(tailoringErrorMessage(res.data.error));
      if (res.data.error === "tailoring_job_changed") void load();
      return;
    }
    setNote("");
    setApproved(false);
    await load();
    onChanged();
  }

  async function searchOrders() {
    if (!job) return;
    const q = orderQuery.trim() || job.partyName || "";
    const res = await api<{ orders?: OrderOption[]; error?: string }>(`/api/orders/history?pageSize=20&q=${encodeURIComponent(q)}`);
    if (!res.ok) {
      setError(tailoringErrorMessage(res.data.error));
      return;
    }
    // Same rule the server enforces: this customer (or no customer), not voided.
    setOrders((res.data.orders ?? []).filter((order) => order.status !== "voided" && (!order.customer_id || order.customer_id === job.partyId)));
  }

  async function linkOrder(orderId: string) {
    if (!job) return;
    setBusy(true);
    setError("");
    const res = await api<{ error?: string }>(`/api/tailoring/jobs/${job.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "link_order", orderId }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(tailoringErrorMessage(res.data.error));
      return;
    }
    setOrders(null);
    await load();
    onChanged();
  }

  if (!job) {
    return (
      <div className="space-y-3 p-4">
        <SheetHeader className="p-0">
          <SheetTitle>سفارش خیاطی</SheetTitle>
          <SheetDescription>جزئیات سفارش</SheetDescription>
        </SheetHeader>
        {error ? <ErrorBox>{error}</ErrorBox> : <SectionCardSkeleton rows={3} label="در حال خواندن سفارش" />}
      </div>
    );
  }

  const priced = job.estimateRial !== null && BigInt(job.estimateRial) > BigInt(0);
  const closed = job.status === "picked_up" || job.status === "cancelled";
  const canCancel = !closed && job.status !== "ready";
  const pathIndex = PATH.indexOf(job.status);

  return (
    <div className="space-y-4 px-4 pb-6">
      <SheetHeader className="px-0">
        <SheetTitle>{job.partyName ?? "مشتری"} — {KIND_LABELS[job.kind]}</SheetTitle>
        <SheetDescription>{job.description}</SheetDescription>
      </SheetHeader>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={statusTone(job.status)}>{TAILORING_STATUS_LABELS[job.status]}</StatusBadge>
        {job.dueDate ? <span className="text-sm text-muted-foreground">موعد: {formatDate(job.dueDate)}</span> : null}
        {isOverdue(job) ? <StatusBadge tone="danger">دیرکرد</StatusBadge> : null}
        {job.estimateRial !== null ? <span className="text-sm">برآورد: {money.formatText(job.estimateRial)}</span> : null}
      </div>
      <ol aria-label="مراحل سفارش" className="flex flex-wrap gap-1.5 text-xs">
        {PATH.map((status, index) => (
          <li
            key={status}
            aria-current={status === job.status ? "step" : undefined}
            className={index <= pathIndex ? "rounded-full bg-muted px-2 py-0.5 font-medium text-foreground" : "rounded-full px-2 py-0.5 text-muted-foreground"}
          >
            {TAILORING_STATUS_LABELS[status]}
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">
        پرو: {toPersianDigits(String(job.fittingCount))} · دوباره‌کاری: {toPersianDigits(String(job.reworkCount))}
        {job.orderId ? " · فروش پیوند شده" : priced ? " · فروش هنوز پیوند نشده" : ""}
      </p>
      <ErrorBox>{error}</ErrorBox>

      {!closed ? (
        <SectionCard title="مرحلهٔ بعد">
          <div className="space-y-3">
            {job.status === "intake" || job.status === "estimated" ? (
              <div className="space-y-1.5">
                <Label htmlFor="tailoring-estimate">مبلغ برآورد ({money.unitLabel})</Label>
                <Input
                  id="tailoring-estimate"
                  inputMode="numeric"
                  dir="ltr"
                  value={estimate}
                  onChange={(event) => setEstimate(event.target.value)}
                  placeholder={job.estimateRial !== null ? money.formatText(job.estimateRial, { withUnit: false }) : ""}
                />
              </div>
            ) : null}
            {job.status === "estimated" ? (
              <div className="flex items-center gap-2">
                <Checkbox id="tailoring-approved" checked={approved} onCheckedChange={(checked) => setApproved(checked === true)} />
                <Label htmlFor="tailoring-approved">مشتری برآورد و شرح کار را تأیید کرد.</Label>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="tailoring-note">یادداشت این مرحله (اختیاری)</Label>
              <Textarea id="tailoring-note" value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
            </div>
            <div className="flex flex-wrap gap-2">
              {job.status === "intake" || job.status === "estimated" ? (
                <Button
                  type="button"
                  variant={job.status === "estimated" ? "outline" : "default"}
                  disabled={busy || !estimate.trim()}
                  onClick={() => void step("estimated", { estimateRial: money.parseText(estimate) })}
                >
                  {job.status === "estimated" ? "اصلاح برآورد" : "ثبت برآورد"}
                </Button>
              ) : null}
              {job.status === "estimated" ? (
                <Button type="button" disabled={busy || !approved} onClick={() => void step("approved", { customerApproved: true })}>
                  ثبت تأیید مشتری
                </Button>
              ) : null}
              {job.status === "approved" || job.status === "fitting" ? (
                <>
                  <Button type="button" variant={job.status === "fitting" ? "outline" : "default"} disabled={busy} onClick={() => void step("fitting")}>
                    {job.status === "fitting" ? "ثبت پروی دیگر" : "ثبت پرو"}
                  </Button>
                  <Button
                    type="button"
                    disabled={busy || (job.status === "approved" && job.kind === "made_to_measure")}
                    onClick={() => void step("qc")}
                  >
                    ارسال به کنترل کیفیت
                  </Button>
                </>
              ) : null}
              {job.status === "qc" ? (
                <>
                  <Button type="button" disabled={busy} onClick={() => void step("ready", { qcPassed: true })}>کنترل کیفیت قبول — آمادهٔ تحویل</Button>
                  <Button type="button" variant="outline" disabled={busy} onClick={() => void step("fitting", { qcPassed: false })}>رد کنترل کیفیت — دوباره‌کاری</Button>
                </>
              ) : null}
              {job.status === "ready" ? (
                <Button type="button" disabled={busy || (priced && !job.orderId)} onClick={() => void step("picked_up")}>
                  تحویل به مشتری
                </Button>
              ) : null}
              {canCancel ? (
                <Button type="button" variant="destructive" disabled={busy} onClick={() => void step("cancelled")}>لغو سفارش</Button>
              ) : null}
            </div>
            {job.status === "approved" && job.kind === "made_to_measure" ? (
              <p className="text-xs text-muted-foreground">{tailoringErrorMessage("tailoring_fitting_required")}</p>
            ) : null}
            {job.status === "ready" && priced && !job.orderId ? (
              <p className="text-xs text-muted-foreground">{tailoringErrorMessage("tailoring_order_required")}</p>
            ) : null}
          </div>
        </SectionCard>
      ) : null}

      {!closed && !job.orderId ? (
        <SectionCard title="پیوند فروش" description="مبلغ از مسیر عادی سفارش و فاکتور دریافت می‌شود؛ اینجا فقط فروش به این کار پیوند می‌خورد.">
          {permissions.canViewOrders ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Input
                  aria-label="جست‌وجوی سفارش با شماره یا نام مشتری"
                  className="max-w-xs"
                  value={orderQuery}
                  onChange={(event) => setOrderQuery(event.target.value)}
                  placeholder={job.partyName ?? "شمارهٔ سفارش"}
                />
                <Button type="button" variant="outline" onClick={() => void searchOrders()}>جست‌وجوی فروش</Button>
              </div>
              {orders === null ? null : orders.length === 0 ? (
                <EmptyState>فروشی برای این مشتری در این شعبه پیدا نشد. ابتدا فروش را در صندوق ثبت کنید.</EmptyState>
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {orders.map((order) => (
                    <li key={order.id} className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm">
                      <span>
                        سفارش {toPersianDigits(order.order_number)} · {money.formatText(order.total)} · {formatDate(order.opened_at)}
                      </span>
                      <Button type="button" size="sm" disabled={busy} onClick={() => void linkOrder(order.id)}>پیوند</Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <InfoBox>برای پیوند فروش به دسترسی «مشاهدهٔ سفارش‌ها» نیاز است.</InfoBox>
          )}
        </SectionCard>
      ) : null}

      {permissions.canMeasure ? (
        <MeasurementsPanel
          partyId={job.partyId}
          customerName={job.partyName ?? "مشتری"}
          canExport={permissions.canExport}
          canErase={permissions.canErase}
        />
      ) : (
        <InfoBox>اندازه‌های بدن فقط برای کاربران دارای دسترسی «اندازه‌های بدن» نمایش داده می‌شود.</InfoBox>
      )}

      <SectionCard title="تاریخچهٔ سفارش">
        <ol className="space-y-2 text-sm">
          {events.map((event) => (
            <li key={event.id} className="border-s-2 border-border ps-3">
              <span className="font-medium">
                {event.fromStatus ? `${TAILORING_STATUS_LABELS[event.fromStatus]} ← ` : ""}{TAILORING_STATUS_LABELS[event.toStatus]}
              </span>
              <span className="block text-xs text-muted-foreground">{event.actorName} · {formatDate(event.at)}</span>
              {event.note ? <span className="block text-xs">{event.note}</span> : null}
            </li>
          ))}
        </ol>
      </SectionCard>
    </div>
  );
}

function CustomerMeasurements({ permissions }: { permissions: TailoringPermissions }) {
  const [customer, setCustomer] = useState<PickerCustomer | null>(null);
  return (
    <div className="space-y-4">
      <SectionCard title="انتخاب مشتری" description="اندازه‌های هر مشتری جداگانه و با تاریخچهٔ نسخه نگهداری می‌شود.">
        <CustomerPicker customer={customer} onChange={setCustomer} idPrefix="tailoring-measure" />
      </SectionCard>
      {customer ? (
        <MeasurementsPanel
          partyId={customer.id}
          customerName={customer.name}
          canExport={permissions.canExport}
          canErase={permissions.canErase}
        />
      ) : (
        <EmptyState>برای ثبت یا مشاهدهٔ اندازه‌ها، ابتدا مشتری را انتخاب کنید.</EmptyState>
      )}
    </div>
  );
}

interface RetentionState {
  retentionDays: number;
  preview: { retentionDays: number; cutoff: string; versions: number; customers: number; applied: boolean };
}

function RetentionSection() {
  const [state, setState] = useState<RetentionState | null>(null);
  const [days, setDays] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    const res = await api<RetentionState & { error?: string }>("/api/tailoring/retention");
    if (!res.ok) {
      setError(tailoringErrorMessage(res.data.error));
      return;
    }
    setState(res.data);
    setDays(String(res.data.retentionDays));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError("");
    const res = await api<{ error?: string }>("/api/tailoring/retention", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      setError(tailoringErrorMessage(res.data.error));
      return;
    }
    setNotice(done);
    setConfirm(false);
    await load();
  }

  if (!state) return error ? <ErrorBox>{error}</ErrorBox> : <SectionCardSkeleton rows={2} label="در حال خواندن تنظیم نگهداری" />;

  return (
    <SectionCard title="مدت نگهداری اندازه‌ها" description="اندازه‌هایی که از این مدت قدیمی‌ترند پاک می‌شوند؛ ردیف نسخه و گزارش دسترسی می‌ماند.">
      <div className="space-y-4">
        <ErrorBox>{error}</ErrorBox>
        {notice ? <InfoBox>{notice}</InfoBox> : null}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void post({ action: "set", days: Number(days) }, "مدت نگهداری ذخیره شد.");
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="tailoring-retention-days">مدت نگهداری (روز، ۳۰ تا ۳۶۵۰)</Label>
            <Input id="tailoring-retention-days" type="number" min={30} max={3650} dir="ltr" value={days} onChange={(event) => setDays(event.target.value)} />
          </div>
          <Button type="submit" variant="outline" disabled={busy}>ذخیره</Button>
        </form>
        <p className="text-sm">
          پیش‌نمایش: {toPersianDigits(String(state.preview.versions))} نسخه از {toPersianDigits(String(state.preview.customers))} مشتری
          قدیمی‌تر از {formatDate(state.preview.cutoff)} است.
        </p>
        {state.preview.versions > 0 ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox id="tailoring-purge-confirm" checked={confirm} onCheckedChange={(checked) => setConfirm(checked === true)} />
              <Label htmlFor="tailoring-purge-confirm">پاک‌سازی این نسخه‌ها را تأیید می‌کنم.</Label>
            </div>
            <Button type="button" variant="destructive" disabled={busy || !confirm} onClick={() => void post({ action: "purge", confirm: true }, "نسخه‌های قدیمی پاک شدند.")}>
              پاک‌سازی نسخه‌های قدیمی
            </Button>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
