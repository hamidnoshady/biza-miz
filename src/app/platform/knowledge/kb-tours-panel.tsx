"use client";

/**
 * «تورهای تعاملی» — the super-admin tab that authors the guided tours behind
 * each page's «آموزش» button (issue #972, migration 0288).
 *
 * The tab answers three questions at once:
 *
 *  - **which pages have what** — every page in the canonical Knowledge registry
 *    with its current coverage: a tour authored here, a tour that ships in code,
 *    or only the automatic baseline introduction;
 *  - **what a page's tour says** — a page, a title, a description, eligibility
 *    and an ordered list of steps. A step is either an explanation (no anchor)
 *    or a spotlight of an anchor that a component really renders; the anchor
 *    list is the registered `TOUR_ANCHORS`, never a selector typed by hand;
 *  - **what members actually play** — drafts are invisible to them. Publishing
 *    points the member API at the revision just saved, and the revision list
 *    makes going back to an earlier one a deliberate, one-click decision.
 *
 * Validation is the server's (`parseStudioTourInput`); this panel surfaces its
 * sentence next to the form. Editing a published tour does not unpublish it:
 * members keep playing the live revision until the editor publishes again, and
 * the panel says so.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CirclePlayIcon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { INDUSTRIES, INDUSTRY_LABELS } from "@/lib/industries";
import { PERMISSIONS, type Permission } from "@/lib/permissions";
import { KNOWLEDGE_PAGES } from "@/lib/knowledge-base";
import { tourCoverage } from "@/lib/tour-coverage";
import { TOUR_ANCHORS } from "@/lib/tours";
import { STUDIO_ERROR_TEXT, type StudioTour, type StudioTourRevision } from "@/lib/tour-studio";
import type { TourEligibility, TourInventorySystem } from "@/lib/tours";
import {
  api,
  Button,
  EmptyState,
  ErrorBox,
  Field,
  InfoBox,
  SkeletonRows,
  errorMessage,
  fmtDate,
  inputClass,
  selectClass,
  useCan,
} from "../ui";

type EditableStep = {
  id: string;
  kind: "explain" | "spotlight";
  anchor: string;
  title: string;
  body: string;
};

type Form = {
  id: string | null;
  tourKey: string;
  pageKey: string;
  title: string;
  description: string;
  steps: EditableStep[];
  eligibility: TourEligibility;
  status: StudioTour["status"];
  version: number | null;
  publishedVersion: number | null;
};

const ANCHORS = [...new Set(Object.values(TOUR_ANCHORS))].sort();
// Derived from the one permission list the server enforces, so the picker can
// never offer a permission the runtime does not know.
const PERMISSION_KEYS = [...new Set(Object.values(PERMISSIONS))].sort() as Permission[];

const COVERAGE = tourCoverage();
const PAGES = KNOWLEDGE_PAGES.map((page) => ({
  ...page,
  coverage: COVERAGE.pages.find((row) => row.pageKey === page.key),
}));

function emptyForm(pageKey: string): Form {
  return {
    id: null,
    tourKey: "",
    pageKey,
    title: "",
    description: "",
    steps: [],
    eligibility: {},
    status: "draft",
    version: null,
    publishedVersion: null,
  };
}

function nextStepId(steps: EditableStep[]): string {
  let index = steps.length + 1;
  while (steps.some((step) => step.id === `step-${index}`)) index += 1;
  return `step-${index}`;
}

function formFor(tour: StudioTour): Form {
  return {
    id: tour.id,
    tourKey: tour.tourKey,
    pageKey: tour.pageKey,
    title: tour.title,
    description: tour.description,
    eligibility: tour.eligibility,
    status: tour.status,
    version: tour.version,
    publishedVersion: tour.publishedVersion,
    steps: tour.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      anchor: step.anchor ?? "",
      title: step.title,
      body: step.body,
    })),
  };
}

function payloadFor(form: Form): Record<string, unknown> {
  return {
    tourKey: form.tourKey.trim(),
    pageKey: form.pageKey,
    title: form.title,
    description: form.description,
    eligibility: form.eligibility,
    steps: form.steps.map((step) => ({
      id: step.id.trim(),
      kind: step.kind,
      ...(step.kind === "spotlight" ? { anchor: step.anchor } : {}),
      title: step.title,
      body: step.body,
    })),
    ...(form.version !== null ? { expectedVersion: form.version } : {}),
  };
}

/**
 * A refusal is shown as this feature's Persian sentence. The API's `detail` is a
 * diagnostic (which step, which permission), so it is kept separately and shown
 * small and LTR — never in place of the operator-facing message.
 */
function refusalText(error: string | undefined): string {
  return (error && STUDIO_ERROR_TEXT[error]) || errorMessage(error);
}

function statusLabel(tour: Pick<StudioTour, "status" | "version" | "publishedVersion">): string {
  if (tour.status === "archived") return "بایگانی";
  if (tour.status !== "published") return "پیش‌نویس";
  return tour.publishedVersion === tour.version
    ? "منتشرشده"
    : `منتشرشده (نسخهٔ ${tour.publishedVersion}) + تغییر منتشرنشده`;
}

export function ToursPanel() {
  const can = useCan();
  const canManage = can("knowledge.manage");
  const [tours, setTours] = useState<StudioTour[] | null>(null);
  const [error, setError] = useState("");
  const [pageKey, setPageKey] = useState<string>(KNOWLEDGE_PAGES[0]?.key ?? "");
  const [form, setForm] = useState<Form>(() => emptyForm(KNOWLEDGE_PAGES[0]?.key ?? ""));
  const [revisions, setRevisions] = useState<StudioTourRevision[]>([]);
  const [busy, setBusy] = useState("");
  const [formError, setFormError] = useState("");
  const [formDetail, setFormDetail] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const { ok, data } = await api<{ tours: StudioTour[]; error?: string }>(
      "/api/platform/knowledge/tours",
    );
    if (ok) {
      setTours(data.tours);
      setError("");
    } else {
      setError(errorMessage(data.error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadRevisions = useCallback(async (id: string) => {
    const { ok, data } = await api<{ revisions: StudioTourRevision[] }>(
      `/api/platform/knowledge/tours/${id}`,
    );
    setRevisions(ok ? data.revisions : []);
  }, []);

  const pageTours = useMemo(
    () => (tours ?? []).filter((tour) => tour.pageKey === pageKey),
    [tours, pageKey],
  );
  const page = PAGES.find((entry) => entry.key === pageKey);

  function selectPage(key: string) {
    setPageKey(key);
    setForm(emptyForm(key));
    setRevisions([]);
    setFormError("");
    setFormDetail("");
    setNotice("");
  }

  function openTour(tour: StudioTour) {
    setPageKey(tour.pageKey);
    setForm(formFor(tour));
    setFormError("");
    setFormDetail("");
    setNotice("");
    void loadRevisions(tour.id);
  }

  function updateStep(index: number, patch: Partial<EditableStep>) {
    setForm((current) => ({
      ...current,
      steps: current.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    }));
  }

  function moveStep(index: number, delta: number) {
    setForm((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.steps.length) return current;
      const steps = [...current.steps];
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...current, steps };
    });
  }

  function addStep(kind: EditableStep["kind"]) {
    setForm((current) => ({
      ...current,
      steps: [
        ...current.steps,
        {
          id: nextStepId(current.steps),
          kind,
          anchor: kind === "spotlight" ? ANCHORS[0] ?? "" : "",
          title: "",
          body: "",
        },
      ],
    }));
  }

  async function save(): Promise<StudioTour | null> {
    if (busy) return null;
    setBusy("save");
    setFormError("");
    setFormDetail("");
    setNotice("");
    const { ok, data } = await api<{ id?: string; error?: string; detail?: string }>(
      "/api/platform/knowledge/tours",
      { method: "POST", body: JSON.stringify(payloadFor(form)) },
    );
    setBusy("");
    if (!ok) {
      setFormError(refusalText(data.error));
      setFormDetail(data.detail ?? "");
      return null;
    }
    await load();
    const fetched = await api<{ tour: StudioTour }>(`/api/platform/knowledge/tours/${data.id}`);
    if (fetched.ok) {
      setForm(formFor(fetched.data.tour));
      void loadRevisions(fetched.data.tour.id);
    }
    setNotice("پیش‌نویس ذخیره شد.");
    return fetched.ok ? fetched.data.tour : null;
  }

  async function act(id: string, body: Record<string, unknown>, message: string) {
    if (busy) return;
    setBusy(String(body.action));
    setFormError("");
    setFormDetail("");
    setNotice("");
    const { ok, data } = await api<{ tour?: StudioTour; error?: string; detail?: string }>(
      `/api/platform/knowledge/tours/${id}`,
      { method: "POST", body: JSON.stringify(body) },
    );
    setBusy("");
    if (!ok) {
      setFormError(refusalText(data.error));
      setFormDetail(data.detail ?? "");
      return;
    }
    setFormDetail("");
    await load();
    if (data.tour) setForm(formFor(data.tour));
    void loadRevisions(id);
    setNotice(message);
  }

  async function deleteDraft(id: string) {
    if (busy) return;
    setBusy("delete");
    setFormError("");
    setFormDetail("");
    const { ok, data } = await api<{ error?: string; detail?: string }>(
      `/api/platform/knowledge/tours/${id}`,
      { method: "DELETE" },
    );
    setBusy("");
    if (!ok) {
      setFormError(refusalText(data.error));
      setFormDetail(data.detail ?? "");
      return;
    }
    setForm(emptyForm(pageKey));
    setRevisions([]);
    setNotice("پیش‌نویس حذف شد.");
    await load();
  }

  if (tours === null && !error) return <SkeletonRows />;
  if (error) return <ErrorBox>{error}</ErrorBox>;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
      <aside className="rounded-xl border border-border bg-card p-3">
        <h2 className="mb-2 px-1 text-xs font-bold text-muted-foreground">صفحه‌های کارگاه</h2>
        <label className="mb-2 block px-1">
          <span className="sr-only">جست‌وجوی صفحه</span>
          <select
            className={selectClass}
            value={pageKey}
            onChange={(event) => selectPage(event.target.value)}
          >
            {Object.entries(
              PAGES.reduce<Record<string, typeof PAGES>>((groups, entry) => {
                (groups[entry.group] ??= []).push(entry);
                return groups;
              }, {}),
            ).map(([group, entries]) => (
              <optgroup key={group} label={group}>
                {entries.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <div className="space-y-1">
          {pageTours.length === 0 ? (
            <p className="px-1 py-2 text-xs leading-5 text-muted-foreground">
              برای این صفحه تور دست‌نویس ندارید؛ کاربر «معرفی خودکار» را می‌بیند.
            </p>
          ) : (
            pageTours.map((tour) => (
              <button
                key={tour.id}
                type="button"
                onClick={() => openTour(tour)}
                className={`block w-full rounded-lg px-2 py-2 text-right text-xs transition-colors hover:bg-muted ${
                  form.id === tour.id ? "bg-muted font-semibold" : ""
                }`}
              >
                <span className="block truncate">{tour.title}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {tour.tourKey}
                </span>
                <span className="block text-[11px] text-muted-foreground">{statusLabel(tour)}</span>
              </button>
            ))
          )}
        </div>
        <Button
          type="button"
          className="mt-3 w-full"
          onClick={() => {
            const key = pageKey;
            if (!key) return;
            setForm({ ...emptyForm(key), tourKey: `studio.${key.replace(/^page:\//, "").replace(/\//g, ".")}` });
            setRevisions([]);
            setFormError("");
            setFormDetail("");
            setNotice("");
          }}
          disabled={!canManage}
        >
          <PlusIcon className="size-4" aria-hidden="true" />
          تور تازه برای این صفحه
        </Button>
      </aside>

      <section className="min-w-0 space-y-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-sm font-bold">
                {page?.label} <span className="text-xs font-normal text-muted-foreground">— {page?.route}</span>
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {page?.coverage?.kind === "advanced"
                  ? "این صفحه تور کدنویسی‌شده دارد؛ هر توری که اینجا منتشر کنید با همان شناسه جای آن می‌نشیند."
                  : "این صفحه فعلاً فقط «معرفی خودکار» دارد؛ تور شما جای آن را می‌گیرد."}
              </p>
            </div>
            {form.id ? (
              <span className="rounded-full bg-muted px-2 py-1 text-[11px]">
                {statusLabel({
                  status: form.status,
                  version: form.version ?? 0,
                  publishedVersion: form.publishedVersion,
                })}
              </span>
            ) : null}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="شناسهٔ تور (کلید پیشرفت)">
              <input
                className={`${inputClass} font-mono`}
                dir="ltr"
                value={form.tourKey}
                onChange={(event) => setForm({ ...form, tourKey: event.target.value })}
                placeholder="studio.accounting.orders"
                disabled={!canManage}
              />
            </Field>
            <Field label="عنوان">
              <input
                className={inputClass}
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                disabled={!canManage}
              />
            </Field>
            <Field label="توضیح کوتاهی که در پنجرهٔ آموزش دیده می‌شود">
              <input
                className={inputClass}
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
                disabled={!canManage}
              />
            </Field>
            <Field label="سیستم انبار (اختیاری)">
              <select
                className={selectClass}
                value={form.eligibility.inventorySystem ?? ""}
                onChange={(event) => {
                  const value = event.target.value as TourInventorySystem | "";
                  const next = { ...form.eligibility };
                  if (value) next.inventorySystem = value;
                  else delete next.inventorySystem;
                  setForm({ ...form, eligibility: next });
                }}
                disabled={!canManage}
              >
                <option value="">هر دو</option>
                <option value="perpetual">دائمی</option>
                <option value="periodic">دوره‌ای</option>
              </select>
            </Field>
          </div>

          <fieldset className="mt-4">
            <legend className="text-xs font-bold text-muted-foreground">
              دسترسی‌های لازم برای دیدن این تور
            </legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {PERMISSION_KEYS.map((permission) => {
                const checked = (form.eligibility.permissions ?? []).includes(permission);
                return (
                  <label
                    key={permission}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-[11px]"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!canManage}
                      onChange={(event) => {
                        const current = new Set<Permission>(form.eligibility.permissions ?? []);
                        if (event.target.checked) current.add(permission);
                        else current.delete(permission);
                        const next = { ...form.eligibility };
                        if (current.size > 0) next.permissions = [...current];
                        else delete next.permissions;
                        setForm({ ...form, eligibility: next });
                      }}
                    />
                    <span className="font-mono" dir="ltr">
                      {permission}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="mt-4">
            <legend className="text-xs font-bold text-muted-foreground">صنف‌هایی که این تور برایشان است</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {INDUSTRIES.map((industry) => {
                const checked = (form.eligibility.industries ?? []).includes(industry);
                return (
                  <label
                    key={industry}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-[11px]"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!canManage}
                      onChange={(event) => {
                        const current = new Set(form.eligibility.industries ?? []);
                        if (event.target.checked) current.add(industry);
                        else current.delete(industry);
                        const next = { ...form.eligibility };
                        if (current.size > 0) next.industries = [...current];
                        else delete next.industries;
                        setForm({ ...form, eligibility: next });
                      }}
                    />
                    {INDUSTRY_LABELS[industry]}
                  </label>
                );
              })}
            </div>
          </fieldset>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold">مرحله‌ها</h3>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => addStep("explain")} disabled={!canManage}>
                <PlusIcon className="size-4" aria-hidden="true" />
                توضیح
              </Button>
              <Button type="button" onClick={() => addStep("spotlight")} disabled={!canManage}>
                <PlusIcon className="size-4" aria-hidden="true" />
                هایلایت
              </Button>
            </div>
          </div>

          {form.steps.length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              تور با یک «توضیح» شروع می‌شود؛ هایلایت باید به یک لنگر ثبت‌شده اشاره کند، نه به یک انتخابگر
              دلخواه.
            </p>
          ) : (
            <ol className="mt-3 space-y-3">
              {form.steps.map((step, index) => (
                <li key={`${step.id}-${index}`} className="rounded-lg border border-border/70 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground">{index + 1}.</span>
                    <select
                      className={`${selectClass} w-28`}
                      value={step.kind}
                      disabled={!canManage}
                      onChange={(event) => {
                        const kind = event.target.value as EditableStep["kind"];
                        updateStep(index, {
                          kind,
                          anchor: kind === "spotlight" ? step.anchor || ANCHORS[0] || "" : "",
                        });
                      }}
                    >
                      <option value="explain">توضیح</option>
                      <option value="spotlight">هایلایت</option>
                    </select>
                    <input
                      className={`${inputClass} w-36 font-mono`}
                      dir="ltr"
                      value={step.id}
                      disabled={!canManage}
                      onChange={(event) => updateStep(index, { id: event.target.value })}
                      aria-label={`شناسهٔ مرحلهٔ ${index + 1}`}
                    />
                    {step.kind === "spotlight" ? (
                      <select
                        className={`${selectClass} w-56 font-mono`}
                        dir="ltr"
                        value={step.anchor}
                        disabled={!canManage}
                        onChange={(event) => updateStep(index, { anchor: event.target.value })}
                        aria-label="لنگر"
                      >
                        {ANCHORS.map((anchor) => (
                          <option key={anchor} value={anchor}>
                            {anchor}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <span className="ms-auto flex gap-1">
                      <button
                        type="button"
                        className="rounded-md p-1.5 hover:bg-muted disabled:opacity-40"
                        onClick={() => moveStep(index, -1)}
                        disabled={!canManage || index === 0}
                        aria-label="بالا"
                      >
                        <ArrowUpIcon className="size-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="rounded-md p-1.5 hover:bg-muted disabled:opacity-40"
                        onClick={() => moveStep(index, 1)}
                        disabled={!canManage || index === form.steps.length - 1}
                        aria-label="پایین"
                      >
                        <ArrowDownIcon className="size-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="rounded-md p-1.5 text-destructive hover:bg-destructive/10"
                        onClick={() =>
                          setForm({
                            ...form,
                            steps: form.steps.filter((_, i) => i !== index),
                          })
                        }
                        disabled={!canManage}
                        aria-label="حذف مرحله"
                      >
                        <Trash2Icon className="size-4" aria-hidden="true" />
                      </button>
                    </span>
                  </div>
                  <input
                    className={`${inputClass} mt-2`}
                    value={step.title}
                    placeholder="عنوان مرحله"
                    disabled={!canManage}
                    onChange={(event) => updateStep(index, { title: event.target.value })}
                  />
                  <textarea
                    className={`${inputClass} mt-2 min-h-20`}
                    value={step.body}
                    placeholder="متنی که کنار هایلایت (یا در کارت توضیح) می‌آید"
                    disabled={!canManage}
                    onChange={(event) => updateStep(index, { body: event.target.value })}
                  />
                </li>
              ))}
            </ol>
          )}

          {formError ? (
            <div className="mt-3">
              <ErrorBox>{formError}</ErrorBox>
              {formDetail ? (
                <p className="mt-1 px-1 font-mono text-[11px] text-muted-foreground" dir="ltr">
                  {formDetail}
                </p>
              ) : null}
            </div>
          ) : null}
          {notice ? (
            <div className="mt-3">
              <InfoBox>{notice}</InfoBox>
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" onClick={() => void save()} disabled={!canManage || busy !== ""}>
              <SaveIcon className="size-4" aria-hidden="true" />
              {busy === "save" ? "ذخیره…" : "ذخیرهٔ پیش‌نویس"}
            </Button>
            <Button
              type="button"
              onClick={() => form.id && void act(form.id, { action: "publish", version: form.version }, "منتشر شد.")}
              disabled={!canManage || !form.id || busy !== ""}
            >
              <UploadIcon className="size-4" aria-hidden="true" />
              انتشار
            </Button>
            <Button
              type="button"
              onClick={() => form.id && void act(form.id, { action: "archive" }, "بایگانی شد؛ کاربران دیگر آن را نمی‌بینند.")}
              disabled={!canManage || !form.id || busy !== ""}
            >
              بایگانی
            </Button>
            {form.id && form.publishedVersion === null ? (
              <Button
                type="button"
                onClick={() => form.id && void deleteDraft(form.id)}
                disabled={!canManage || busy !== ""}
              >
                <Trash2Icon className="size-4" aria-hidden="true" />
                حذف پیش‌نویس
              </Button>
            ) : null}
            {form.publishedVersion !== null ? (
              <a
                href="/knowledge"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
              >
                <CirclePlayIcon className="size-4" aria-hidden="true" />
                مرکز آموزش
              </a>
            ) : null}
          </div>
          {form.status === "published" && form.version !== form.publishedVersion ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              تغییرهای ذخیره‌شده هنوز منتشر نشده‌اند؛ کاربران همان نسخهٔ {form.publishedVersion} را می‌بینند.
            </p>
          ) : null}
        </div>

        {form.id ? (
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-sm font-bold">نسخه‌ها</h3>
            {revisions.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">هنوز نسخه‌ای ثبت نشده است.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border/70">
                {revisions.map((revision) => (
                  <li key={revision.version} className="flex flex-wrap items-center gap-2 py-2 text-xs">
                    <span className="font-mono" dir="ltr">
                      v{revision.version}
                    </span>
                    {revision.live ? (
                      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">
                        در حال اجرا
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">{revision.title}</span>
                    <span className="text-muted-foreground">{fmtDate(revision.createdAt)}</span>
                    <span className="text-muted-foreground">{revision.steps.length} مرحله</span>
                    <Button
                      type="button"
                      onClick={() =>
                        form.id && void act(form.id, { action: "rollback", toVersion: revision.version }, "نسخه بازگردانی شد.")
                      }
                      disabled={!canManage || busy !== "" || revision.live}
                    >
                      <RotateCcwIcon className="size-4" aria-hidden="true" />
                      بازگردانی
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {!canManage ? (
          <InfoBox>
            تغییر در اختیار مهندس و مدیر ارشد است؛ این صفحه فقط برای مشاهده باز است.
          </InfoBox>
        ) : null}

        {tours?.length === 0 && !form.id ? (
          <EmptyState
            title="هنوز تور دست‌نویسی ندارید"
            hint="صفحه‌ها فعلاً «معرفی خودکار» دارند. یک صفحه را انتخاب کنید و اولین تور را بسازید."
          />
        ) : null}
      </section>
    </div>
  );
}
