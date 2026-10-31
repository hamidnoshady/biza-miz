"use client";

/**
 * CRM → بریف کارفرما — what each client actually asked for (issue #1128 §A).
 *
 * ## Reading this screen
 *
 * A brief is the only record of the requirement that belongs to the *client*
 * rather than to the agency. Everything downstream is measured against it: a
 * proposal prices it, a project delivers it, a change request departs from it. So
 * the screen's central act is not editing — it is **confirming**, and once a brief
 * is confirmed the substance stops being editable here. That is not a missing
 * feature: the correction is a new brief that supersedes this one, which is also
 * what leaves the trail an edit in place would destroy.
 *
 * What *does* stay writable on a confirmed brief is our own note and the pointer
 * to the project the brief becomes. The project normally arrives after
 * confirmation, and freezing that would break the handoff into My Workspace — the
 * one transition this table exists to serve.
 *
 * ## The approver is the client's own contact
 *
 * §A asks that the stakeholder be recorded "without exposing another client's
 * information". Here that is a shape rather than a warning: the approver picker is
 * populated from the chosen client's own relationships, so another client's
 * decision-maker is not among the options. Migration 0271 refuses the write anyway
 * — the picker is a convenience, the constraint is the rule.
 *
 * ## Permissions are computed by `crm-section.tsx`, never here
 *
 * `canManage` and `canDelete` arrive as props from the same table the API guards
 * with, so a control is never drawn on a permission its own endpoint refuses.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { PlusIcon, RefreshCwIcon, Trash2Icon, PencilIcon } from "lucide-react";
import {
  AGENCY_BRIEF_ACTION_LABELS,
  AGENCY_BRIEF_CHANNELS,
  AGENCY_BRIEF_CHANNEL_LABELS,
  AGENCY_BRIEF_STATUS_LABELS,
  AGENCY_BRIEF_STATUS_TONES,
  AGENCY_BRIEF_STATUSES,
  isAgencyBriefStatus,
  type AgencyBriefAction,
  type AgencyBriefStatus,
} from "@/lib/agency-brief";
import { api, ErrorBox, Field, InfoBox, PrimaryButton, SecondaryButton, errorMessage, inputClass } from "@/app/dashboard/ui";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead } from "@/app/dashboard/data-table";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { CustomerSearchField } from "./customer-search";

/* ------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Declared here rather than imported: the service module imports `pg`, and a
 * client component that reached through it would drag the driver into the browser
 * bundle. The vocabulary above *is* shared, because `agency-brief.ts` is pure —
 * that split is the whole reason the two files exist.
 */
interface BriefDeliverableWire {
  title: string;
  format: string | null;
  quantity: number | null;
}

interface BriefWire {
  id: string;
  briefNumber: string;
  partyId: string;
  partyName: string;
  dealId: string | null;
  dealTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  title: string;
  status: AgencyBriefStatus;
  objective: string;
  audience: string;
  channels: string[];
  deliverables: BriefDeliverableWire[];
  budgetRial: number | null;
  startDate: string | null;
  deliveryDate: string | null;
  acceptanceCriteria: string;
  note: string;
  approverPartyId: string | null;
  approverName: string;
  sentAt: string | null;
  confirmedAt: string | null;
  confirmedByName: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  actions: AgencyBriefAction[];
  frozen: boolean;
}

interface ContactOption {
  id: string;
  name: string;
  kind: string;
  roleTitle: string | null;
}

/* ------------------------------------------------------------------------- */
/* The editor's own draft state                                               */
/* ------------------------------------------------------------------------- */

interface BriefDraft {
  partyId: string | null;
  partyName: string;
  title: string;
  objective: string;
  audience: string;
  channels: string[];
  deliverables: BriefDeliverableWire[];
  budgetRial: string;
  startDate: string;
  deliveryDate: string;
  acceptanceCriteria: string;
  note: string;
  approverPartyId: string | null;
  approverName: string;
  projectId: string | null;
}

function emptyDraft(): BriefDraft {
  return {
    partyId: null,
    partyName: "",
    title: "",
    objective: "",
    audience: "",
    channels: [],
    deliverables: [],
    budgetRial: "",
    startDate: "",
    deliveryDate: "",
    acceptanceCriteria: "",
    note: "",
    approverPartyId: null,
    approverName: "",
    projectId: null,
  };
}

function draftFrom(brief: BriefWire, money: ReturnType<typeof useMoney>): BriefDraft {
  return {
    partyId: brief.partyId,
    partyName: brief.partyName,
    title: brief.title,
    objective: brief.objective,
    audience: brief.audience,
    channels: [...brief.channels],
    deliverables: brief.deliverables.map((item) => ({ ...item })),
    budgetRial: brief.budgetRial === null ? "" : String(money.toInput(brief.budgetRial)),
    startDate: brief.startDate ?? "",
    deliveryDate: brief.deliveryDate ?? "",
    acceptanceCriteria: brief.acceptanceCriteria,
    note: brief.note,
    approverPartyId: brief.approverPartyId,
    approverName: brief.approverName,
    projectId: brief.projectId,
  };
}

/**
 * The body a save sends.
 *
 * A field the draft cannot express is left *out* rather than sent as an empty
 * string, because the service reads absence as "leave it alone" and an empty
 * string as a decision — sending both for every field would clear whatever the
 * form does not show.
 */
function bodyFrom(
  draft: BriefDraft,
  frozen: boolean,
  money: ReturnType<typeof useMoney>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { note: draft.note.trim() };
  if (frozen) {
    // A confirmed brief accepts only our own note and the pointers to the work it
    // became; everything else is refused by the service and by migration 0271.
    if (draft.projectId) body.projectId = draft.projectId;
    return body;
  }
  body.partyId = draft.partyId;
  body.title = draft.title.trim();
  body.objective = draft.objective.trim();
  body.audience = draft.audience.trim();
  body.channels = draft.channels;
  body.deliverables = draft.deliverables;
  body.acceptanceCriteria = draft.acceptanceCriteria.trim();
  body.approverPartyId = draft.approverPartyId;
  body.approverName = draft.approverName.trim();
  body.startDate = draft.startDate || null;
  body.deliveryDate = draft.deliveryDate || null;
  // Empty is *absent*, not zero: the service refuses a zero budget, and a client
  // who would not say is a different fact from one who said nothing.
  const budgetDigits = digitsOf(draft.budgetRial);
  body.budgetRial = budgetDigits === "" ? null : money.fromInput(Number(budgetDigits));
  if (draft.projectId) body.projectId = draft.projectId;
  return body;
}

/**
 * The app's own date formatter, never the browser's.
 *
 * Reaching for a built-in locale formatter would render a Gregorian date in a
 * Persian product — silently, and only for some locales — which is exactly what
 * `crm-rtl.test.ts` exists to refuse. A brief's dates arrive as ISO from Postgres
 * and are displayed on the Shamsi calendar like every other date in the app.
 *
 * Money is not formatted here at all: `useMoney()` owns the business's unit, so a
 * tenant that works in toman is never shown a rial figure, and the column keeps
 * storing rial exactly as §D's registers do.
 */
function formatDate(value: string | null): string {
  return value ? formatJalali(value) : "—";
}

/** Digits only, in Latin, so a money or quantity field survives Persian input. */
function digitsOf(value: string): string {
  return toLatinDigits(value).replace(/[^\d]/g, "");
}

/* ------------------------------------------------------------------------- */
/* The screen                                                                 */
/* ------------------------------------------------------------------------- */

export function BriefsSection({
  canManage,
  canDelete,
}: {
  canManage: boolean;
  canDelete: boolean;
}) {
  const money = useMoney();
  const [briefs, setBriefs] = useState<BriefWire[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("open");
  const [search, setSearch] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const [editing, setEditing] = useState<{ brief: BriefWire | null } | null>(null);
  const [draft, setDraft] = useState<BriefDraft>(emptyDraft);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [acting, setActing] = useState<{ brief: BriefWire; action: AgencyBriefAction } | null>(null);
  const [confirmerName, setConfirmerName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actingBusy, setActingBusy] = useState(false);

  const [contacts, setContacts] = useState<ContactOption[]>([]);

  const params = useMemo(() => {
    const query = new URLSearchParams();
    if (statusFilter === "open") query.set("openOnly", "1");
    else if (statusFilter !== "all" && isAgencyBriefStatus(statusFilter)) {
      query.set("status", statusFilter);
    }
    const trimmed = search.trim();
    if (trimmed) query.set("q", trimmed);
    return query.toString();
  }, [statusFilter, search]);

  const load = useCallback(async () => {
    setLoadError(null);
    const { ok, data, aborted } = await api<{ briefs?: BriefWire[]; error?: string }>(
      `/api/crm/briefs${params ? `?${params}` : ""}`,
    );
    if (aborted) return;
    if (!ok) {
      setLoadError(errorMessage(data.error) ?? "بارگذاری بریف‌ها ناموفق بود");
      setBriefs(null);
      return;
    }
    setBriefs(data.briefs ?? []);
  }, [params]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  // The approver picker is the chosen client's own contacts — both directions of
  // the relationship, which is exactly what migration 0271's trigger accepts.
  const editorPartyId = editing?.brief === null ? draft.partyId : (draft.partyId ?? null);
  useEffect(() => {
    if (!editing || !editorPartyId) {
      setContacts([]);
      return;
    }
    let cancelled = false;
    void api<{ relationships?: Array<Record<string, unknown>> }>(
      `/api/crm/customers/${editorPartyId}/relationships`,
    ).then(({ ok, data }) => {
      if (cancelled || !ok) {
        if (!cancelled) setContacts([]);
        return;
      }
      const rows = (data.relationships ?? []).map((row) => {
        const inverse = row.inverse === true;
        return {
          id: String(inverse ? row.fromPartyId : row.toPartyId),
          name: String(inverse ? row.fromName : row.toName),
          kind: String(row.kind ?? ""),
          roleTitle: typeof row.roleTitle === "string" ? row.roleTitle : null,
        };
      });
      // Never offer the client as its own approver.
      setContacts(rows.filter((row) => row.id !== editorPartyId));
    });
    return () => {
      cancelled = true;
    };
  }, [editing, editorPartyId]);

  function openNew() {
    setSaveError(null);
    setDraft(emptyDraft());
    setEditing({ brief: null });
  }

  function openEdit(brief: BriefWire) {
    setSaveError(null);
    setDraft(draftFrom(brief, money));
    setEditing({ brief });
  }

  async function save() {
    if (!editing) return;
    setSaving(true);
    setSaveError(null);
    const frozen = editing.brief?.frozen ?? false;
    const body = bodyFrom(draft, frozen, money);
    const { ok, data } = await api<{ brief?: BriefWire; error?: string }>(
      editing.brief ? `/api/crm/briefs/${editing.brief.id}` : "/api/crm/briefs",
      {
        method: editing.brief ? "PATCH" : "POST",
        body: JSON.stringify(body),
      },
    );
    setSaving(false);
    if (!ok || !data.brief) {
      setSaveError(errorMessage(data.error) ?? "ذخیرهٔ بریف ناموفق بود");
      return;
    }
    setEditing(null);
    setReloadKey((key) => key + 1);
  }

  function openAction(brief: BriefWire, action: AgencyBriefAction) {
    setActionError(null);
    // Confirming falls back to the approver the brief already names, so the field
    // arrives pre-filled with the person the agency recorded as the client's
    // decision-maker rather than empty.
    setConfirmerName(action === "confirm" ? brief.approverName : "");
    setActing({ brief, action });
  }

  async function runAction() {
    if (!acting) return;
    setActingBusy(true);
    setActionError(null);
    const { ok, data } = await api<{ brief?: BriefWire; error?: string }>(
      `/api/crm/briefs/${acting.brief.id}/status`,
      {
        method: "POST",
        body: JSON.stringify({
          action: acting.action,
          ...(acting.action === "confirm" ? { confirmedByName: confirmerName.trim() } : {}),
        }),
      },
    );
    setActingBusy(false);
    if (!ok) {
      setActionError(errorMessage(data.error) ?? "این تغییر وضعیت ناموفق بود");
      return;
    }
    setActing(null);
    setReloadKey((key) => key + 1);
  }

  async function remove(brief: BriefWire) {
    setActionError(null);
    const { ok, data } = await api<{ error?: string }>(`/api/crm/briefs/${brief.id}`, {
      method: "DELETE",
    });
    if (!ok) {
      setLoadError(errorMessage(data.error) ?? "حذف بریف ناموفق بود");
      return;
    }
    setReloadKey((key) => key + 1);
  }

  if (briefs === null && loadError === null) {
    return <SectionCardSkeleton />;
  }

  const frozen = editing?.brief?.frozen ?? false;

  return (
    <div className="space-y-4">
      <SectionCard
        title="بریف‌های کارفرما"
        description="آنچه مشتری خواسته، پیش از آنکه قیمتی داده یا کاری ساخته شود."
        actions={
          <div className="flex items-center gap-2">
            <SecondaryButton onClick={() => setReloadKey((key) => key + 1)}>
              <RefreshCwIcon className="size-4" aria-hidden="true" />
              تازه‌سازی
            </SecondaryButton>
            {canManage ? (
              <PrimaryButton type="button" onClick={openNew}>
                <PlusIcon className="size-4" aria-hidden="true" />
                بریف تازه
              </PrimaryButton>
            ) : null}
          </div>
        }
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="جست‌وجو">
            <input
              className={inputClass}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="نام بریف، شماره یا نام کارفرما…"
              aria-label="جست‌وجوی بریف"
            />
          </Field>
          <Field label="وضعیت">
            <select
              className={inputClass}
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              aria-label="فیلتر وضعیت بریف"
            >
              <option value="open">باز (پیش‌نویس و ارسال‌شده)</option>
              <option value="all">همه</option>
              {AGENCY_BRIEF_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {AGENCY_BRIEF_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {loadError ? <ErrorBox>{loadError}</ErrorBox> : null}

        {!loadError && briefs !== null && briefs.length === 0 ? (
          <EmptyState title="بریفی نیست">
            {canManage
              ? "نخستین بریف کارفرما را بنویسید: هدف، مخاطب، کانال‌ها، اقلام تحویلی و آنچه پذیرش کار را تعریف می‌کند."
              : "بریفی برای نمایش نیست."}
          </EmptyState>
        ) : null}

        {!loadError && briefs !== null && briefs.length > 0 ? (
          <DataTable caption="بریف‌های کارفرما">
            <DataTableHead>
              <th className="py-2 text-start font-medium">شماره</th>
              <th className="py-2 text-start font-medium">عنوان</th>
              <th className="py-2 text-start font-medium">کارفرما</th>
              <th className="py-2 text-start font-medium">وضعیت</th>
              <th className="py-2 text-start font-medium">بودجه</th>
              <th className="py-2 text-start font-medium">تحویل</th>
              <th className="py-2 text-start font-medium">تأییدکننده</th>
              <th className="py-2 text-end font-medium">عملیات</th>
            </DataTableHead>
            <DataTableBody>
                {briefs.map((brief) => (
                  <tr key={brief.id} className="border-b last:border-0">
                    <td className="py-2 whitespace-nowrap">{toPersianDigits(brief.briefNumber)}</td>
                    <td className="py-2">
                      <div className="font-medium">{brief.title}</div>
                      {brief.projectName ? (
                        <div className="text-xs text-muted-foreground">{brief.projectName}</div>
                      ) : null}
                    </td>
                    <td className="py-2">{brief.partyName || "—"}</td>
                    <td className="py-2">
                      <StatusBadge tone={AGENCY_BRIEF_STATUS_TONES[brief.status]} dot>
                        {AGENCY_BRIEF_STATUS_LABELS[brief.status]}
                      </StatusBadge>
                    </td>
                    <td className="py-2 whitespace-nowrap">
                      {brief.budgetRial === null ? "—" : money.format(brief.budgetRial)}
                    </td>
                    <td className="py-2 whitespace-nowrap">{formatDate(brief.deliveryDate)}</td>
                    <td className="py-2 whitespace-nowrap">
                      {brief.approverName || brief.confirmedByName || "—"}
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        {/* The acts are the brief's own, read off the row: the
                            screen never offers a button the route would refuse. */}
                        {canManage
                          ? brief.actions.map((action) => (
                              <SecondaryButton
                                key={action}
                                type="button"
                                onClick={() => openAction(brief, action)}
                              >
                                {AGENCY_BRIEF_ACTION_LABELS[action]}
                              </SecondaryButton>
                            ))
                          : null}
                        {canManage ? (
                          <SecondaryButton type="button" onClick={() => openEdit(brief)}>
                            <PencilIcon className="size-4" aria-hidden="true" />
                            ویرایش
                          </SecondaryButton>
                        ) : null}
                        {canDelete && brief.status === "draft" ? (
                          <SecondaryButton type="button" onClick={() => void remove(brief)}>
                            <Trash2Icon className="size-4" aria-hidden="true" />
                            حذف
                          </SecondaryButton>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
            </DataTableBody>
          </DataTable>
        ) : null}

        <InfoBox>
          بریف تأییدشده منجمد است: آنچه کارفرما پذیرفته زیر پای پیشنهاد و پروژه
          تغییر نمی‌کند. اصلاح، بریف تازه‌ای است که قبلی را جایگزین می‌کند.
          بودجهٔ بریف تنها چیزی است که کارفرما گفته قصد دارد بپردازد — نه مطالبهٔ
          قطعی و نه سندی در حسابداری.
        </InfoBox>
      </SectionCard>

      <Sheet open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>
              {editing?.brief
                ? `ویرایش ${toPersianDigits(editing.brief.briefNumber)}`
                : "بریف تازهٔ کارفرما"}
            </SheetTitle>
          </SheetHeader>

          <div className="space-y-4 px-4 pb-4">
            {saveError ? <ErrorBox>{saveError}</ErrorBox> : null}

            {frozen ? (
              <InfoBox>
                این بریف تأیید شده است. آنچه کارفرما پذیرفته تغییر نمی‌کند؛ تنها
                یادداشت داخلی و اشاره به پروژه‌ای که این بریف به آن تبدیل شده
                قابل نوشتن است.
              </InfoBox>
            ) : null}

            <Field label="کارفرما" hint="بریف بدون کارفرما معنی ندارد.">
              {frozen ? (
                <div className={inputClass}>{draft.partyName || "—"}</div>
              ) : (
                <CustomerSearchField
                  selectedId={draft.partyId}
                  selectedName={draft.partyName}
                  onPick={(match) =>
                    setDraft((current) => ({
                      ...current,
                      partyId: match.id,
                      partyName: match.name,
                      // A different client has different contacts, so the
                      // approver chosen for the previous one cannot carry over.
                      approverPartyId: null,
                      approverName: "",
                    }))
                  }
                  onClear={() =>
                    setDraft((current) => ({
                      ...current,
                      partyId: null,
                      partyName: "",
                      approverPartyId: null,
                      approverName: "",
                    }))
                  }
                  emptyText="کارفرمایی پیدا نشد."
                  ariaLabel="جست‌وجوی کارفرمای بریف"
                />
              )}
            </Field>

            <Field label="عنوان بریف">
              {frozen ? (
                <div className={inputClass}>{draft.title}</div>
              ) : (
                <input
                  className={inputClass}
                  value={draft.title}
                  onChange={(event) => setDraft((c) => ({ ...c, title: event.target.value }))}
                  placeholder="مثلاً کمپین نوروز ۱۴۰۵"
                />
              )}
            </Field>

            <Field
              label="هدف"
              hint="پیش از ارسال به کارفرما لازم است؛ تأیید بریف بی‌هدف، تأیید هیچ است."
            >
              {frozen ? (
                <div className={inputClass}>{draft.objective || "—"}</div>
              ) : (
                <textarea
                  className={inputClass}
                  rows={3}
                  value={draft.objective}
                  onChange={(event) => setDraft((c) => ({ ...c, objective: event.target.value }))}
                />
              )}
            </Field>

            <Field label="مخاطب">
              {frozen ? (
                <div className={inputClass}>{draft.audience || "—"}</div>
              ) : (
                <input
                  className={inputClass}
                  value={draft.audience}
                  onChange={(event) => setDraft((c) => ({ ...c, audience: event.target.value }))}
                />
              )}
            </Field>

            <Field label="کانال‌ها" as="div" hint="کانال‌هایی که کار در آن‌ها منتشر می‌شود.">
              <div className="flex flex-wrap gap-2" role="group" aria-label="کانال‌های بریف">
                {AGENCY_BRIEF_CHANNELS.map((channel) => {
                  const on = draft.channels.includes(channel);
                  return (
                    <button
                      key={channel}
                      type="button"
                      disabled={frozen}
                      aria-pressed={on}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          channels: on
                            ? current.channels.filter((entry) => entry !== channel)
                            : [...current.channels, channel],
                        }))
                      }
                      className={
                        on
                          ? "rounded-full border border-primary bg-primary/10 px-3 py-1 text-xs"
                          : "rounded-full border px-3 py-1 text-xs text-muted-foreground"
                      }
                    >
                      {AGENCY_BRIEF_CHANNEL_LABELS[channel]}
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="اقلام تحویلی" as="div">
              <div className="space-y-2">
                {draft.deliverables.map((item, index) => (
                  <div key={index} className="flex flex-wrap items-center gap-2">
                    <input
                      className={inputClass}
                      value={item.title}
                      disabled={frozen}
                      placeholder="مثلاً تیزر ۳۰ ثانیه"
                      aria-label={`عنوان قلم ${toPersianDigits(index + 1)}`}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          deliverables: current.deliverables.map((entry, at) =>
                            at === index ? { ...entry, title: event.target.value } : entry,
                          ),
                        }))
                      }
                    />
                    <select
                      className={inputClass}
                      value={item.format ?? ""}
                      disabled={frozen}
                      aria-label={`قالب قلم ${toPersianDigits(index + 1)}`}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          deliverables: current.deliverables.map((entry, at) =>
                            at === index
                              ? { ...entry, format: event.target.value || null }
                              : entry,
                          ),
                        }))
                      }
                    >
                      <option value="">بدون قالب</option>
                      <option value="brief">بریف</option>
                      <option value="copy">متن تبلیغاتی</option>
                      <option value="static_creative">طرح گرافیکی</option>
                      <option value="logo">لوگو</option>
                      <option value="video">ویدیو</option>
                      <option value="print_ready">فایل آمادهٔ چاپ</option>
                      <option value="ad_variant">نسخهٔ تبلیغ</option>
                      <option value="contract">قرارداد</option>
                      <option value="report">گزارش</option>
                    </select>
                    <PersianNumberInput
                      className={`${inputClass} w-24`}
                      inputMode="numeric"
                      allowNegative={false}
                      disabled={frozen}
                      value={item.quantity === null ? "" : String(item.quantity)}
                      aria-label={`تعداد قلم ${toPersianDigits(index + 1)}`}
                      onChange={(event) => {
                        const digits = digitsOf(event.target.value);
                        setDraft((current) => ({
                          ...current,
                          deliverables: current.deliverables.map((entry, at) =>
                            at === index
                              ? { ...entry, quantity: digits === "" ? null : Number(digits) }
                              : entry,
                          ),
                        }));
                      }}
                    />
                    {!frozen ? (
                      <SecondaryButton
                        type="button"
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            deliverables: current.deliverables.filter((_, at) => at !== index),
                          }))
                        }
                      >
                        <Trash2Icon className="size-4" aria-hidden="true" />
                      </SecondaryButton>
                    ) : null}
                  </div>
                ))}
                {!frozen ? (
                  <SecondaryButton
                    type="button"
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        deliverables: [
                          ...current.deliverables,
                          { title: "", format: null, quantity: null },
                        ],
                      }))
                    }
                  >
                    <PlusIcon className="size-4" aria-hidden="true" />
                    افزودن قلم
                  </SecondaryButton>
                ) : null}
              </div>
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                label={`بودجهٔ کارفرما (${money.unitLabel})`}
                hint="آنچه کارفرما گفته قصد دارد بپردازد؛ نه مطالبهٔ قطعی و نه سند حسابداری."
              >
                {frozen ? (
                  <div className={inputClass}>
                    {editing?.brief?.budgetRial == null ? "—" : money.format(editing.brief.budgetRial)}
                  </div>
                ) : (
                  <PersianNumberInput
                    className={inputClass}
                    inputMode="numeric"
                    allowNegative={false}
                    value={draft.budgetRial}
                    placeholder="۰"
                    aria-label={`بودجهٔ کارفرما به ${money.unitLabel}`}
                    onChange={(event) => setDraft((c) => ({ ...c, budgetRial: event.target.value }))}
                  />
                )}
              </Field>
              <Field label="تاریخ شروع">
                {frozen ? (
                  <div className={inputClass}>{formatDate(draft.startDate || null)}</div>
                ) : (
                  <input
                    className={inputClass}
                    type="date"
                    value={draft.startDate}
                    onChange={(event) => setDraft((c) => ({ ...c, startDate: event.target.value }))}
                  />
                )}
              </Field>
              <Field label="تاریخ تحویل">
                {frozen ? (
                  <div className={inputClass}>{formatDate(draft.deliveryDate || null)}</div>
                ) : (
                  <input
                    className={inputClass}
                    type="date"
                    value={draft.deliveryDate}
                    onChange={(event) => setDraft((c) => ({ ...c, deliveryDate: event.target.value }))}
                  />
                )}
              </Field>
            </div>

            <Field label="معیارهای پذیرش" hint="کار تحویلی چه شرایطی داشت پذیرفته است؟">
              {frozen ? (
                <div className={inputClass}>{draft.acceptanceCriteria || "—"}</div>
              ) : (
                <textarea
                  className={inputClass}
                  rows={3}
                  value={draft.acceptanceCriteria}
                  onChange={(event) =>
                    setDraft((c) => ({ ...c, acceptanceCriteria: event.target.value }))
                  }
                />
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="تأییدکنندهٔ سمت کارفرما"
                hint="فقط از میان تماس‌های همین کارفرما؛ تماس کارفرمای دیگر اینجا در دسترس نیست."
              >
                {frozen ? (
                  <div className={inputClass}>{draft.approverName || "—"}</div>
                ) : (
                  <select
                    className={inputClass}
                    value={draft.approverPartyId ?? ""}
                    disabled={!draft.partyId}
                    onChange={(event) => {
                      const id = event.target.value;
                      const match = contacts.find((row) => row.id === id);
                      setDraft((current) => ({
                        ...current,
                        approverPartyId: id || null,
                        approverName: match ? match.name : "",
                      }));
                    }}
                  >
                    <option value="">انتخاب نشده</option>
                    {contacts.map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.name}
                        {contact.roleTitle ? ` — ${contact.roleTitle}` : ""}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="نام تأییدکننده">
                {frozen ? (
                  <div className={inputClass}>{draft.approverName || "—"}</div>
                ) : (
                  <input
                    className={inputClass}
                    value={draft.approverName}
                    onChange={(event) => setDraft((c) => ({ ...c, approverName: event.target.value }))}
                  />
                )}
              </Field>
            </div>

            {!frozen && draft.partyId && contacts.length === 0 ? (
              <InfoBox>
                این کارفرما هنوز تماسی ثبت نشده است. تأییدکننده را می‌توان با نام
                نوشت، اما برای اینکه بریف‌های بعدی او را از میان تماس‌ها انتخاب
                کنید، نخست در پروندهٔ مشتری یک نسبت ثبت کنید.
              </InfoBox>
            ) : null}

            <Field label="یادداشت داخلی" hint="تنها بخشی که پس از تأیید هم قابل ویرایش است.">
              <textarea
                className={inputClass}
                rows={2}
                value={draft.note}
                onChange={(event) => setDraft((c) => ({ ...c, note: event.target.value }))}
              />
            </Field>
          </div>

          <SheetFooter>
            <SecondaryButton type="button" onClick={() => setEditing(null)}>
              انصراف
            </SecondaryButton>
            <PrimaryButton
              type="button"
              disabled={saving || (!frozen && (!draft.partyId || draft.title.trim() === ""))}
              onClick={() => void save()}
            >
              {saving ? "در حال ذخیره…" : "ذخیره"}
            </PrimaryButton>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Sheet open={acting !== null} onOpenChange={(open) => !open && setActing(null)}>
        <SheetContent className="w-full gap-0 sm:max-w-md">
          <SheetHeader>
            <SheetTitle>
              {acting ? AGENCY_BRIEF_ACTION_LABELS[acting.action] : ""}
            </SheetTitle>
          </SheetHeader>
          <div className="space-y-4 px-4 pb-4">
            {actionError ? <ErrorBox>{actionError}</ErrorBox> : null}
            {acting ? (
              <InfoBox>
                {toPersianDigits(acting.brief.briefNumber)} — {acting.brief.title}
              </InfoBox>
            ) : null}
            {acting?.action === "confirm" ? (
              <Field
                label="تأیید از سوی"
                hint="نام کسی در سمت کارفرما که این بریف را پذیرفته است. بدون نام، تأیید ثبت نمی‌شود."
              >
                <input
                  className={inputClass}
                  value={confirmerName}
                  onChange={(event) => setConfirmerName(event.target.value)}
                />
              </Field>
            ) : null}
            {acting?.action === "supersede" ? (
              <InfoBox>
                این بریف تأییدشده جای خود را به بریف تازه‌ای می‌دهد. خودش حذف
                نمی‌شود: همین ردیف، رکورد آنچه کارفرما پذیرفته باقی می‌ماند.
              </InfoBox>
            ) : null}
          </div>
          <SheetFooter>
            <SecondaryButton type="button" onClick={() => setActing(null)}>
              انصراف
            </SecondaryButton>
            <PrimaryButton
              type="button"
              disabled={actingBusy || (acting?.action === "confirm" && confirmerName.trim() === "")}
              onClick={() => void runAction()}
            >
              {actingBusy ? "در حال ثبت…" : "ثبت"}
            </PrimaryButton>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
