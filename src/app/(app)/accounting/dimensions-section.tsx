"use client";

/**
 * Accounting → «ابعاد حسابداری».
 *
 * Two tabs over one catalogue:
 *
 *   * «مدیریت ابعاد» — which kinds the business uses (each is off until it is
 *     switched on), and the values of each kind: create, rename, re-parent,
 *     restrict to a branch, date, archive and restore. A value that has ever
 *     been posted to is archived, never removed, and the screen says so.
 *   * «گزارش‌های ابعاد» — the matrix, the profit by profit centre and the
 *     cost-centre account card (`dimension-reports-panel.tsx`).
 *
 * Project and branch are not managed here: a project is still a project in «My
 * Workspace», and a branch is still a branch. This screen never creates a cost
 * centre from a project, which is the duplication the issue rules out.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { PencilIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { TabBar, TabPanel, type Tab } from "@/app/dashboard/tab-bar";
import { FilterChip, FilterChipRow, SearchField } from "@/app/dashboard/filters";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { ErrorBox, Field, InfoBox, SecondaryButton, api, inputClass } from "@/app/dashboard/ui";
import {
  DIMENSION_KINDS,
  dimensionErrorMessage,
  dimensionKindLabel,
  dimensionLabelProblem,
  dimensionValueProblem,
  type DimensionKind,
  type DimensionSettingRecord,
  type DimensionValueRecord,
} from "@/lib/accounting-dimensions";
import { toPersianDigits } from "@/lib/digits";
import { DimensionReportsPanel } from "./dimension-reports-panel";
import { filterDimensionValues, isoToJalaliText } from "./dimension-catalog";

type SectionTab = "manage" | "reports";

const TABS: readonly Tab<SectionTab>[] = [
  { key: "manage", label: "مدیریت ابعاد" },
  { key: "reports", label: "گزارش‌های ابعاد" },
];

interface LocationOption {
  id: string;
  name: string;
}

interface CatalogResponse {
  settings: DimensionSettingRecord[];
  values: DimensionValueRecord[];
}

interface ValueForm {
  /** Set when editing; absent when creating. */
  id?: string;
  kind: DimensionKind;
  code: string;
  name: string;
  parentId: string;
  locationId: string;
  effectiveFrom: string;
  effectiveTo: string;
  isActive: boolean;
}

function blankForm(kind: DimensionKind): ValueForm {
  return { kind, code: "", name: "", parentId: "", locationId: "", effectiveFrom: "", effectiveTo: "", isActive: true };
}

function formFrom(value: DimensionValueRecord): ValueForm {
  return {
    id: value.id,
    kind: value.kind,
    code: value.code,
    name: value.name,
    parentId: value.parentId ?? "",
    locationId: value.locationId ?? "",
    effectiveFrom: value.effectiveFrom ?? "",
    effectiveTo: value.effectiveTo ?? "",
    isActive: value.isActive,
  };
}

function rangeText(value: DimensionValueRecord): string {
  if (!value.effectiveFrom && !value.effectiveTo) return "همیشه";
  const from = value.effectiveFrom ? isoToJalaliText(value.effectiveFrom) : "…";
  const to = value.effectiveTo ? isoToJalaliText(value.effectiveTo) : "…";
  return `${from} تا ${to}`;
}

export function DimensionsSection({ canManage }: { canManage: boolean }) {
  const [tab, setTab] = useState<SectionTab>("manage");
  const [settings, setSettings] = useState<DimensionSettingRecord[]>([]);
  const [values, setValues] = useState<DimensionValueRecord[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");

  const [kind, setKind] = useState<DimensionKind>("cost_center");
  const [search, setSearch] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [form, setForm] = useState<ValueForm | null>(null);
  const [formError, setFormError] = useState("");
  const [detailLabel, setDetailLabel] = useState("");

  const kindLabel = useCallback(
    (k: DimensionKind) => {
      const setting = settings.find((s) => s.kind === k);
      return dimensionKindLabel(k, setting?.label ?? null);
    },
    [settings],
  );

  const load = useCallback(async () => {
    const [catalog, places] = await Promise.all([
      api<CatalogResponse>("/api/ledger/dimensions?includeArchived=1"),
      api<{ locations?: LocationOption[] }>("/api/locations/active"),
    ]);
    if (!catalog.ok) {
      setLoadError("ابعاد حسابداری بارگذاری نشد.");
    } else {
      setLoadError("");
      setSettings(catalog.data.settings ?? []);
      setValues(catalog.data.values ?? []);
      const detail = (catalog.data.settings ?? []).find((s) => s.kind === "detail");
      setDetailLabel(detail?.label ?? "");
    }
    if (places.ok) setLocations(places.data.locations ?? []);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const enabled = useMemo(() => settings.filter((s) => s.isEnabled).map((s) => s.kind), [settings]);
  const visibleValues = useMemo(
    () => filterDimensionValues(values, { kind, search, includeArchived }),
    [values, kind, search, includeArchived],
  );

  /** Parents a value may be attached to: active values of its kind, never itself. */
  const parentOptions = useMemo(() => {
    if (!form) return [];
    return values
      .filter((v) => v.kind === form.kind && v.isActive && v.id !== form.id)
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((v) => ({ value: v.id, label: `${v.code} · ${v.name}`, searchString: `${v.code} ${v.name}` }));
  }, [values, form]);

  /** One write: its refusal, as a sentence, or `null` when it went through. Never sets state itself. */
  async function send(url: string, init: RequestInit): Promise<string | null> {
    const result = await api<{ error?: string }>(url, init);
    if (!result.ok) return dimensionErrorMessage(result.data.error ?? "");
    return null;
  }

  /** A write from a control outside any form: its outcome goes to the page-level notice line. */
  async function mutate(url: string, init: RequestInit, done: string): Promise<boolean> {
    setBusy(true);
    setActionError("");
    setNotice("");
    const error = await send(url, init);
    setBusy(false);
    if (error) {
      setActionError(error);
      return false;
    }
    setNotice(done);
    await load();
    return true;
  }

  async function toggleKind(target: DimensionKind, isEnabled: boolean) {
    await mutate(
      "/api/ledger/dimensions/settings",
      { method: "PUT", body: JSON.stringify({ changes: [{ kind: target, isEnabled }] }) },
      isEnabled
        ? `«${dimensionKindLabel(target, detailLabel)}» فعال شد. از این پس می‌توانید در سندها و هزینه‌ها به آن نسبت دهید.`
        : `«${dimensionKindLabel(target, detailLabel)}» غیرفعال شد. سندهای قبلی تغییر نمی‌کنند.`,
    );
  }

  async function saveDetailLabel() {
    const problem = dimensionLabelProblem(detailLabel);
    if (problem) {
      setActionError(dimensionErrorMessage(problem));
      return;
    }
    await mutate(
      "/api/ledger/dimensions/settings",
      { method: "PUT", body: JSON.stringify({ changes: [{ kind: "detail", label: detailLabel.trim() }] }) },
      "نام بُعد تحلیلی ذخیره شد.",
    );
  }

  async function saveValue() {
    if (!form) return;
    const problem = dimensionValueProblem({
      code: form.code,
      name: form.name,
      effectiveFrom: form.effectiveFrom || null,
      effectiveTo: form.effectiveTo || null,
    });
    if (problem) {
      setFormError(dimensionErrorMessage(problem));
      return;
    }
    const body = {
      kind: form.kind,
      code: form.code.trim(),
      name: form.name.trim(),
      parentId: form.parentId || null,
      locationId: form.locationId || null,
      effectiveFrom: form.effectiveFrom || null,
      effectiveTo: form.effectiveTo || null,
      ...(form.id ? { isActive: form.isActive } : {}),
    };
    // The form keeps its refusal next to the fields that caused it.
    setBusy(true);
    setFormError("");
    const error = form.id
      ? await send(`/api/ledger/dimensions/${form.id}`, { method: "PATCH", body: JSON.stringify(body) })
      : await send("/api/ledger/dimensions", { method: "POST", body: JSON.stringify(body) });
    setBusy(false);
    if (error) {
      setFormError(error);
      return;
    }
    setForm(null);
    setNotice(form.id ? "مقدار ذخیره شد." : "مقدار تازه ثبت شد.");
    await load();
  }

  async function setArchived(value: DimensionValueRecord, isActive: boolean) {
    await mutate(
      `/api/ledger/dimensions/${value.id}`,
      { method: "PATCH", body: JSON.stringify({ isActive }) },
      isActive ? "مقدار بازگردانی شد." : "مقدار بایگانی شد. سندهای قبلی همچنان به آن ارجاع دارند.",
    );
  }

  async function remove(value: DimensionValueRecord) {
    setBusy(true);
    setActionError("");
    setNotice("");
    const result = await api<{ deleted?: boolean; archived?: boolean; error?: string }>(
      `/api/ledger/dimensions/${value.id}`,
      { method: "DELETE" },
    );
    setBusy(false);
    if (!result.ok) {
      setActionError(dimensionErrorMessage(result.data.error ?? ""));
      return;
    }
    setNotice(
      result.data.deleted
        ? "مقدار حذف شد؛ هیچ سندی به آن ارجاع نداشت."
        : "چون سند یا هزینه‌ای به این مقدار ارجاع دارد، فقط بایگانی شد.",
    );
    await load();
  }

  if (!loaded) return <SectionCardSkeleton rows={4} label="در حال بارگذاری ابعاد حسابداری" />;

  return (
    <div className="space-y-6">
      <TabBar idPrefix="dimensions" label="بخش‌های ابعاد حسابداری" tabs={TABS} active={tab} onChange={setTab} />

      <TabPanel idPrefix="dimensions" active={tab}>
        {tab === "manage" ? (
          <div className="space-y-6">
            <ErrorBox>{loadError}</ErrorBox>
            <InfoBox>{notice}</InfoBox>
            <ErrorBox>{actionError}</ErrorBox>

            <SectionCard
              title="کدام بُعدها در این کسب‌وکار استفاده می‌شوند"
              description="هر بُعد تا زمانی که فعال نشود، در هیچ فرمی دیده نمی‌شود. خاموش کردن یک بُعد سندهای قبلی را تغییر نمی‌دهد؛ فقط ثبت تازه به آن را متوقف می‌کند."
            >
              <ul className="divide-y divide-border">
                {DIMENSION_KINDS.map((k) => {
                  const setting = settings.find((s) => s.kind === k);
                  const label = dimensionKindLabel(k, setting?.label ?? null);
                  return (
                    <li key={k} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <p className="font-semibold text-foreground">{label}</p>
                        <p className="text-sm text-muted-foreground">{setting?.description}</p>
                        {k === "detail" && setting?.isEnabled !== undefined && canManage ? (
                          <div className="mt-2 flex flex-wrap items-end gap-2">
                            <label className="block min-w-0 flex-1 sm:max-w-xs">
                              <span className="mb-1.5 block text-sm font-medium text-foreground">نام این بُعد در این کسب‌وکار</span>
                              <input
                                className={inputClass}
                                value={detailLabel}
                                maxLength={80}
                                onChange={(e) => setDetailLabel(e.target.value)}
                                placeholder="بعد تحلیلی"
                              />
                            </label>
                            <SecondaryButton onClick={saveDetailLabel} disabled={busy}>
                              ذخیرهٔ نام
                            </SecondaryButton>
                          </div>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <StatusBadge tone={setting?.isEnabled ? "positive" : "neutral"}>
                          {setting?.isEnabled ? "فعال" : "غیرفعال"}
                        </StatusBadge>
                        <Switch
                          checked={!!setting?.isEnabled}
                          disabled={!canManage || busy}
                          onCheckedChange={(checked) => void toggleKind(k, checked)}
                          aria-label={`فعال بودن ${label}`}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
              {!canManage ? (
                <p className="mt-3 text-sm text-muted-foreground">تغییر این تنظیمات با دسترسی «ویرایش سرفصل‌ها» ممکن است.</p>
              ) : null}
            </SectionCard>

            {enabled.length === 0 ? (
              <EmptyState title="هنوز هیچ بُعدی فعال نیست">
                برای شروع، یک نوع بُعد را از بالا فعال کنید؛ سپس مقدارهای آن را تعریف کنید.
              </EmptyState>
            ) : null}

            <SectionCard
              title={`مقدارهای ${kindLabel(kind)}`}
              description={
                kind === "cost_center"
                  ? "مرکز هزینه، بخشی از کسب‌وکار است که هزینه‌اش را می‌خواهید جدا ببینید. پروژه‌ها در «فضای کار من» می‌مانند و اینجا تکرار نمی‌شوند."
                  : kind === "profit_center"
                    ? "مرکز سود، خط کاری است که درآمد و بهای تمام‌شده‌اش را جدا می‌خواهید؛ شعبه‌ها جدا می‌مانند."
                    : undefined
              }
              actions={
                canManage ? (
                  <Button type="button" onClick={() => setForm(blankForm(kind))} disabled={busy || form !== null}>
                    <PlusIcon aria-hidden="true" />
                    افزودن مقدار
                  </Button>
                ) : null
              }
              flush
            >
              <div className="space-y-3 p-4">
                <FilterChipRow label="نوع بُعد">
                  {DIMENSION_KINDS.map((k) => (
                    <FilterChip key={k} selected={kind === k} onClick={() => setKind(k)}>
                      {kindLabel(k)}
                      {settings.find((s) => s.kind === k)?.isEnabled ? "" : " (غیرفعال)"}
                    </FilterChip>
                  ))}
                </FilterChipRow>
                <div className="flex flex-wrap items-center gap-3">
                  <SearchField
                    value={search}
                    onChange={setSearch}
                    label="جست‌وجو در کد و نام"
                    placeholder="کد یا نام…"
                    className="min-w-[14rem] flex-1"
                  />
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <Switch checked={includeArchived} onCheckedChange={setIncludeArchived} aria-label="نمایش بایگانی‌شده‌ها" />
                    نمایش بایگانی‌شده‌ها
                  </label>
                </div>
              </div>

              {form ? (
                <form
                  className="mx-4 mb-4 space-y-3 rounded-xl border border-border p-4"
                  aria-label={form.id ? "ویرایش مقدار" : "مقدار تازه"}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveValue();
                  }}
                >
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="کد">
                      <input
                        className={inputClass}
                        value={form.code}
                        maxLength={32}
                        onChange={(e) => setForm({ ...form, code: e.target.value })}
                        placeholder="CC-HQ"
                        dir="ltr"
                      />
                    </Field>
                    <Field label="نام">
                      <input
                        className={inputClass}
                        value={form.name}
                        maxLength={160}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                        placeholder="ستاد"
                      />
                    </Field>
                    <div className="block min-w-0">
                      <span className="mb-1.5 block text-sm font-medium text-foreground">والد (اختیاری)</span>
                      <SearchableSelect
                        value={form.parentId}
                        onChange={(next) => setForm({ ...form, parentId: next })}
                        options={[{ value: "", label: "بدون والد" }, ...parentOptions]}
                        ariaLabel="والد"
                      />
                    </div>
                    <div className="block min-w-0">
                      <span className="mb-1.5 block text-sm font-medium text-foreground">شعبه (اختیاری)</span>
                      <SearchableSelect
                        value={form.locationId}
                        onChange={(next) => setForm({ ...form, locationId: next })}
                        options={[
                          { value: "", label: "همهٔ شعبه‌ها" },
                          ...locations.map((l) => ({ value: l.id, label: l.name, searchString: l.name })),
                        ]}
                        ariaLabel="شعبهٔ مجاز"
                      />
                    </div>
                    <div className="block min-w-0">
                      <span className="mb-1.5 block text-sm font-medium text-foreground">معتبر از</span>
                      <JalaliDatePicker
                        value={form.effectiveFrom}
                        onChange={(next) => setForm({ ...form, effectiveFrom: next })}
                        ariaLabel="معتبر از"
                        placeholder="همیشه"
                      />
                    </div>
                    <div className="block min-w-0">
                      <span className="mb-1.5 block text-sm font-medium text-foreground">معتبر تا</span>
                      <JalaliDatePicker
                        value={form.effectiveTo}
                        onChange={(next) => setForm({ ...form, effectiveTo: next })}
                        ariaLabel="معتبر تا"
                        placeholder="بدون پایان"
                      />
                    </div>
                  </div>
                  {form.id ? (
                    <label className="flex items-center gap-2 text-sm text-foreground">
                      <Switch
                        checked={form.isActive}
                        onCheckedChange={(next) => setForm({ ...form, isActive: next })}
                        aria-label="فعال بودن مقدار"
                      />
                      مقدار فعال است
                    </label>
                  ) : null}
                  <ErrorBox>{formError}</ErrorBox>
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={busy}>
                      {form.id ? "ذخیرهٔ تغییرات" : "ثبت مقدار"}
                    </Button>
                    <SecondaryButton
                      onClick={() => {
                        setForm(null);
                        setFormError("");
                      }}
                    >
                      انصراف
                    </SecondaryButton>
                  </div>
                </form>
              ) : null}

              {visibleValues.length === 0 ? (
                <div className="p-4">
                  <EmptyState title={`هنوز مقداری برای ${kindLabel(kind)} نیست`}>
                    {canManage ? "با «افزودن مقدار» اولین مورد را بسازید." : "مقداری برای این نوع تعریف نشده است."}
                  </EmptyState>
                </div>
              ) : (
                <DataTable caption={`مقدارهای ${kindLabel(kind)}`}>
                  <DataTableHead>
                    <Th>کد</Th>
                    <Th>نام</Th>
                    <Th>والد</Th>
                    <Th>شعبه</Th>
                    <Th>اعتبار</Th>
                    <Th>وضعیت</Th>
                    {canManage ? <Th>عملیات</Th> : null}
                  </DataTableHead>
                  <DataTableBody>
                    {visibleValues.map((value) => (
                      <DataTableRow key={value.id} className={value.isActive ? undefined : "opacity-70"}>
                        <Td muted nowrap dir="ltr">{toPersianDigits(value.code)}</Td>
                        <Td className="font-medium">
                          {value.name}
                          {value.hasChildren ? <span className="ms-2 text-xs text-muted-foreground">(سرگروه)</span> : null}
                        </Td>
                        <Td muted>{value.parentName ?? "—"}</Td>
                        <Td muted>{value.locationName ?? "همهٔ شعبه‌ها"}</Td>
                        <Td muted nowrap>{rangeText(value)}</Td>
                        <Td>
                          <StatusBadge tone={value.isActive ? "positive" : "neutral"}>
                            {value.isActive ? "فعال" : "بایگانی‌شده"}
                          </StatusBadge>
                        </Td>
                        {canManage ? (
                          <Td nowrap>
                            <div className="flex flex-wrap gap-2">
                              <SecondaryButton onClick={() => setForm(formFrom(value))} disabled={busy}>
                                <PencilIcon aria-hidden="true" className="size-4" />
                                <span className="sr-only">ویرایش </span>
                                ویرایش
                              </SecondaryButton>
                              {value.isActive ? (
                                <SecondaryButton onClick={() => void setArchived(value, false)} disabled={busy}>
                                  بایگانی
                                </SecondaryButton>
                              ) : (
                                <SecondaryButton onClick={() => void setArchived(value, true)} disabled={busy}>
                                  بازگردانی
                                </SecondaryButton>
                              )}
                              <SecondaryButton onClick={() => void remove(value)} disabled={busy}>
                                حذف
                              </SecondaryButton>
                            </div>
                          </Td>
                        ) : null}
                      </DataTableRow>
                    ))}
                  </DataTableBody>
                </DataTable>
              )}
            </SectionCard>
          </div>
        ) : (
          <DimensionReportsPanel enabledKinds={enabled} kindLabel={kindLabel} values={values} />
        )}
      </TabPanel>
    </div>
  );
}
