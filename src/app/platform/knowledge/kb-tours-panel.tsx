"use client";

/**
 * «تورهای تعاملی» — the super-admin tab that authors the guided tours behind
 * each page's «آموزش» button (issue #972, migration 0288).
 *
 * The tab answers three questions at once:
 *
 *  - **which pages have what** — every page in the canonical Knowledge registry
 *    with its published Tour Studio coverage;
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
  LayoutTemplateIcon,
  EyeIcon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { INDUSTRIES, INDUSTRY_LABELS } from "@/lib/industries";
import { PERMISSIONS, type Permission } from "@/lib/permissions";
import { KNOWLEDGE_PAGES } from "@/lib/knowledge-base";
import { TOUR_ANCHORS } from "@/lib/tours";
import { STUDIO_ERROR_TEXT, TOUR_STUDIO_TEMPLATES, type StudioTour, type StudioTourTemplate, type StudioTourRevision } from "@/lib/tour-studio";
import {
  TOUR_VERIFIERS,
  TOUR_VERIFIER_KEYS,
  tourVerifierDefinition,
} from "@/lib/tour-verifiers";
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
  kind: "explain" | "spotlight" | "action" | "navigate";
  anchor: string;
  /** Only an `action` step has one; the key the server verifies. */
  verifier: string;
  /** Only a `navigate` step has one; a registered destination route. */
  navigateTo: string;
  title: string;
  body: string;
  /**
   * Issue #972 — a conditional branch. When set, `tourForViewer` removes this
   * step for a member the rule does not match, so the remaining steps are the
   * path that member actually plays. Empty means every viewer sees it.
   */
  eligibility: TourEligibility;
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

const PAGES = KNOWLEDGE_PAGES;

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

/** Comma input → the known permission keys only; unknown text is dropped. */
function permissionsFrom(value: string): Permission[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is Permission => (PERMISSION_KEYS as readonly string[]).includes(entry));
}

/** Comma input → the known trade ids only; unknown text is dropped. */
function industriesFrom(value: string): (typeof INDUSTRIES)[number][] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is (typeof INDUSTRIES)[number] =>
      (INDUSTRIES as readonly string[]).includes(entry),
    );
}

function flagsFrom(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
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
      verifier: step.verifier ?? "",
      navigateTo: step.navigateTo ?? "",
      title: step.title,
      body: step.body,
      eligibility: step.eligibility ?? {},
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
      ...(step.kind === "spotlight" || (step.kind === "action" && step.anchor)
        ? { anchor: step.anchor }
        : {}),
      ...(step.kind === "action" ? { verifier: step.verifier } : {}),
      ...(step.kind === "navigate" ? { navigateTo: step.navigateTo } : {}),
      title: step.title,
      body: step.body,
      ...(Object.keys(step.eligibility).length > 0 ? { eligibility: step.eligibility } : {}),
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
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

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
          verifier: kind === "action" ? TOUR_VERIFIER_KEYS[0] ?? "" : "",
          navigateTo: kind === "navigate" ? PAGES[0]?.route ?? "" : "",
          title: "",
          body: "",
          eligibility: {},
        },
      ],
    }));
  }

  /**
   * Inserts a reviewed preset. Ids are generated from the current list, so a
   * template can be inserted twice without colliding; the editor still owns
   * the copy and the publish step.
   */
  function applyTemplate(template: StudioTourTemplate) {
    setForm((current) => {
      const steps = [...current.steps];
      for (const step of template.steps) {
        steps.push({
          id: nextStepId(steps),
          kind: step.kind,
          anchor: step.anchor ?? "",
          verifier: "",
          navigateTo: "",
          title: step.title,
          body: step.body,
          eligibility: {},
        });
      }
      return { ...current, steps };
    });
  }

  async function save(): Promise<StudioTour | null> {
    if (busy) return null;
    // An alternative with no rule at all matches every member, which would make
    // the base eligibility meaningless. The server accepts the shape, so the
    // console has to refuse the empty one before it is written.
    if (
      form.eligibility.anyOf?.some(
        (alternative) =>
          !Object.values(alternative).some((value) =>
            Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null,
          ),
      )
    ) {
      setFormError("هر گزینهٔ جایگزین باید حداقل یک شرط داشته باشد.");
      setFormDetail("");
      setNotice("");
      return null;
    }
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
              PAGES.reduce<Record<string, (typeof PAGES)[number][]>>((groups, entry) => {
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
                {tours === null
                  ? "وضعیت انتشار در حال بررسی است."
                  : pageTours.some((tour) => tour.status === "published" && tour.publishedVersion !== null)
                    ? "این صفحه در استودیو تور منتشرشده دارد."
                    : "برای این صفحه هنوز توری منتشر نشده است."}
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
            <Field label="پرچم‌های ویژگی لازم (با کاما)">
              <input
                className={inputClass}
                dir="ltr"
                value={(form.eligibility.features ?? []).join(", ")}
                placeholder="ledger, inventory"
                onChange={(event) => {
                  const values = event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean);
                  const next = { ...form.eligibility };
                  if (values.length > 0) next.features = values;
                  else delete next.features;
                  setForm({ ...form, eligibility: next });
                }}
                disabled={!canManage}
              />
            </Field>
            <Field label="پرچم‌های ویژگی که باید خاموش باشند">
              <input
                className={inputClass}
                dir="ltr"
                value={(form.eligibility.withoutFeatures ?? []).join(", ")}
                placeholder="ai_assistant"
                onChange={(event) => {
                  const values = event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean);
                  const next = { ...form.eligibility };
                  if (values.length > 0) next.withoutFeatures = values;
                  else delete next.withoutFeatures;
                  setForm({ ...form, eligibility: next });
                }}
                disabled={!canManage}
              />
            </Field>
            <Field label="دسترسی‌هایی که نباید داشته باشد (با کاما)">
              <input
                className={inputClass}
                dir="ltr"
                value={(form.eligibility.withoutPermissions ?? []).join(", ")}
                placeholder="ledger.view"
                onChange={(event) => {
                  const values = event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter((value): value is Permission =>
                      (PERMISSION_KEYS as readonly string[]).includes(value),
                    );
                  const next = { ...form.eligibility };
                  if (values.length > 0) next.withoutPermissions = values;
                  else delete next.withoutPermissions;
                  setForm({ ...form, eligibility: next });
                }}
                disabled={!canManage}
              />
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

          <fieldset className="mt-4">
            <legend className="text-xs font-bold text-muted-foreground">گزینه‌های جایگزین (anyOf)</legend>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
              اگر پر شود، عضو باید شرط‌های بالا و دست‌کم یکی از این گزینه‌ها را داشته باشد. هر گزینه حداقل یک شرط لازم دارد؛
              حداکثر هشت گزینه.
            </p>
            {(form.eligibility.anyOf ?? []).map((alternative, index) => {
              const replaceAlternative = (next: TourEligibility) => {
                const alternatives = [...(form.eligibility.anyOf ?? [])];
                alternatives[index] = next;
                setForm({ ...form, eligibility: { ...form.eligibility, anyOf: alternatives } });
              };
              const removeAlternative = () => {
                const alternatives = (form.eligibility.anyOf ?? []).filter((_, position) => position !== index);
                const eligibility = { ...form.eligibility };
                if (alternatives.length > 0) eligibility.anyOf = alternatives;
                else delete eligibility.anyOf;
                setForm({ ...form, eligibility });
              };
              return (
                <div
                  key={index}
                  className="mt-2 grid gap-2 rounded-lg border border-border p-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
                >
                  <Field label={`گزینهٔ ${index + 1} — دسترسی‌ها (با کاما)`}>
                    <input
                      className={inputClass}
                      dir="ltr"
                      placeholder="crm.export, crm.configure"
                      value={(alternative.permissions ?? []).join(", ")}
                      disabled={!canManage}
                      onChange={(event) => {
                        const permissions = event.target.value
                          .split(",")
                          .map((value) => value.trim())
                          .filter((value): value is Permission =>
                            (PERMISSION_KEYS as readonly string[]).includes(value),
                          );
                        const next: TourEligibility = { ...alternative };
                        if (permissions.length > 0) next.permissions = permissions;
                        else delete next.permissions;
                        replaceAlternative(next);
                      }}
                    />
                  </Field>
                  <Field label={`گزینهٔ ${index + 1} — صنف‌ها (با کاما)`}>
                    <input
                      className={inputClass}
                      dir="ltr"
                      placeholder="automotive, barcode"
                      value={(alternative.industries ?? []).join(", ")}
                      disabled={!canManage}
                      onChange={(event) => {
                        const industries = event.target.value
                          .split(",")
                          .map((value) => value.trim())
                          .filter((value): value is (typeof INDUSTRIES)[number] =>
                            (INDUSTRIES as readonly string[]).includes(value),
                          );
                        const next: TourEligibility = { ...alternative };
                        if (industries.length > 0) next.industries = industries;
                        else delete next.industries;
                        replaceAlternative(next);
                      }}
                    />
                  </Field>
                  <Button type="button" variant="ghost" onClick={removeAlternative} disabled={!canManage}>
                    حذف گزینه
                  </Button>
                </div>
              );
            })}
            <Button
              type="button"
              variant="ghost"
              className="mt-2"
              disabled={!canManage || (form.eligibility.anyOf?.length ?? 0) >= 8}
              onClick={() => {
                const alternatives = [...(form.eligibility.anyOf ?? []), { permissions: [] }];
                setForm({ ...form, eligibility: { ...form.eligibility, anyOf: alternatives } });
              }}
            >
              افزودن گزینه
            </Button>
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
              <Button type="button" onClick={() => addStep("action")} disabled={!canManage}>
                <PlusIcon className="size-4" aria-hidden="true" />
                کار واقعی
              </Button>
              <Button type="button" onClick={() => addStep("navigate")} disabled={!canManage}>
                <PlusIcon className="size-4" aria-hidden="true" />
                رفتن به صفحه
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setPreviewIndex(form.steps.length > 0 ? 0 : null)}
                disabled={form.steps.length === 0}
              >
                <EyeIcon className="size-4" aria-hidden="true" />
                پیش‌نمایش مراحل
              </Button>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">قالب آماده:</span>
            {TOUR_STUDIO_TEMPLATES.map((template) => (
              <Button
                key={template.id}
                type="button"
                variant="ghost"
                title={template.description}
                onClick={() => applyTemplate(template)}
                disabled={!canManage}
                className="h-8 gap-1.5 px-2.5 text-xs"
              >
                <LayoutTemplateIcon className="size-3.5" aria-hidden="true" />
                {template.label}
              </Button>
            ))}
          </div>

          {previewIndex !== null && form.steps[previewIndex] ? (
            <div className="mt-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="text-[11px] font-medium text-muted-foreground">
                  پیش‌نمایش مرحلهٔ {previewIndex + 1} از {form.steps.length} ·{" "}
                  {form.steps[previewIndex].kind === "spotlight"
                    ? "هایلایت"
                    : form.steps[previewIndex].kind === "action"
                      ? "کار واقعی"
                      : form.steps[previewIndex].kind === "navigate"
                        ? "رفتن به صفحه"
                        : "توضیح"}
                </p>
                <button
                  type="button"
                  onClick={() => setPreviewIndex(null)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  بستن
                </button>
              </div>
              <p className="mt-2 text-sm font-bold text-foreground">
                {form.steps[previewIndex].title || "بدون عنوان"}
              </p>
              <p className="mt-1 text-sm leading-6 text-foreground/80">
                {form.steps[previewIndex].body || "متنی نوشته نشده است."}
              </p>
              {form.steps[previewIndex].anchor ? (
                <p className="mt-2 font-mono text-[11px] text-muted-foreground" dir="ltr">
                  {form.steps[previewIndex].anchor}
                </p>
              ) : null}
              <a
                className="mt-2 inline-flex text-xs font-medium text-primary hover:underline"
                href={PAGES.find((page) => page.key === form.pageKey)?.route ?? form.pageKey.replace(/^page:/, "")}
                target="_blank"
                rel="noreferrer"
              >
                باز کردن صفحهٔ هدف برای بررسی زنده
              </a>
              <div className="mt-3 flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setPreviewIndex((index) => Math.max(0, (index ?? 0) - 1))}
                  disabled={previewIndex === 0}
                >
                  قبلی
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    setPreviewIndex((index) =>
                      Math.min(form.steps.length - 1, (index ?? 0) + 1),
                    )
                  }
                  disabled={previewIndex >= form.steps.length - 1}
                >
                  بعدی
                </Button>
              </div>
              <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                این پیش‌نمایش متن و ترتیب مراحل را نشان می‌دهد. صفحهٔ هدف در تب تازه باز می‌شود، چون
                کنسول صفحات برنامه را در همین پنجره قاب نمی‌کند؛ لنگرها را همان‌جا بررسی کنید.
              </p>
            </div>
          ) : null}

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
                          // An action step may point at the button to press,
                          // but a spotlight must; an explanation never does.
                          anchor:
                            kind === "spotlight"
                              ? step.anchor || ANCHORS[0] || ""
                              : kind === "action"
                                ? step.anchor
                                : "",
                          verifier:
                            kind === "action"
                              ? step.verifier || TOUR_VERIFIER_KEYS[0] || ""
                              : "",
                          navigateTo:
                            kind === "navigate"
                              ? step.navigateTo || PAGES[0]?.route || ""
                              : "",
                        });
                      }}
                    >
                      <option value="explain">توضیح</option>
                      <option value="spotlight">هایلایت</option>
                      <option value="action">کار واقعی</option>
                      <option value="navigate">رفتن به صفحه</option>
                    </select>
                    <input
                      className={`${inputClass} w-36 font-mono`}
                      dir="ltr"
                      value={step.id}
                      disabled={!canManage}
                      onChange={(event) => updateStep(index, { id: event.target.value })}
                      aria-label={`شناسهٔ مرحلهٔ ${index + 1}`}
                    />
                    {Object.keys(step.eligibility).length > 0 ? (
                      <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        شرطی
                      </span>
                    ) : null}
                    {step.kind === "spotlight" || step.kind === "action" ? (
                      <select
                        className={`${selectClass} w-56 font-mono`}
                        dir="ltr"
                        value={step.anchor}
                        disabled={!canManage}
                        onChange={(event) => updateStep(index, { anchor: event.target.value })}
                        aria-label="لنگر"
                      >
                        {step.kind === "action" ? <option value="">بدون لنگر</option> : null}
                        {ANCHORS.map((anchor) => (
                          <option key={anchor} value={anchor}>
                            {anchor}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    {step.kind === "action" ? (
                      <select
                        className={`${selectClass} w-60`}
                        value={step.verifier}
                        disabled={!canManage}
                        onChange={(event) => updateStep(index, { verifier: event.target.value })}
                        aria-label="تأییدکنندهٔ کار"
                      >
                        {TOUR_VERIFIER_KEYS.map((key) => (
                          <option key={key} value={key}>
                            {TOUR_VERIFIERS[key].label}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    {step.kind === "navigate" ? (
                      <select
                        className={`${selectClass} w-64`}
                        value={step.navigateTo}
                        disabled={!canManage}
                        onChange={(event) => updateStep(index, { navigateTo: event.target.value })}
                        aria-label="صفحهٔ مقصد"
                      >
                        {PAGES.map((page) => (
                          <option key={page.route} value={page.route}>
                            {page.label} — {page.route}
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
                  <details className="mt-2 rounded-lg border border-border/70 bg-muted/30 p-2">
                    <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
                      شرط نمایش این مرحله (اختیاری)
                    </summary>
                    <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                      اگر پر شود، این مرحله فقط برای عضوی نمایش داده می‌شود که شرط را دارد؛ بقیه آن را
                      نمی‌بینند و مسیرشان از مرحلهٔ بعد ادامه می‌یابد.
                    </p>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <Field label="دسترسی‌های لازم (با کاما)">
                        <input
                          className={inputClass}
                          dir="ltr"
                          placeholder="ledger.view"
                          value={(step.eligibility.permissions ?? []).join(", ")}
                          disabled={!canManage}
                          onChange={(event) => {
                            const next = { ...step.eligibility };
                            const permissions = permissionsFrom(event.target.value);
                            if (permissions.length > 0) next.permissions = permissions;
                            else delete next.permissions;
                            updateStep(index, { eligibility: next });
                          }}
                        />
                      </Field>
                      <Field label="دسترسی‌های ممنوع (با کاما)">
                        <input
                          className={inputClass}
                          dir="ltr"
                          placeholder="payroll.view"
                          value={(step.eligibility.withoutPermissions ?? []).join(", ")}
                          disabled={!canManage}
                          onChange={(event) => {
                            const next = { ...step.eligibility };
                            const permissions = permissionsFrom(event.target.value);
                            if (permissions.length > 0) next.withoutPermissions = permissions;
                            else delete next.withoutPermissions;
                            updateStep(index, { eligibility: next });
                          }}
                        />
                      </Field>
                      <Field label="صنف‌های این مرحله (با کاما)">
                        <input
                          className={inputClass}
                          dir="ltr"
                          placeholder="food_service, retail"
                          value={(step.eligibility.industries ?? []).join(", ")}
                          disabled={!canManage}
                          onChange={(event) => {
                            const next = { ...step.eligibility };
                            const industries = industriesFrom(event.target.value);
                            if (industries.length > 0) next.industries = industries;
                            else delete next.industries;
                            updateStep(index, { eligibility: next });
                          }}
                        />
                      </Field>
                      <Field label="پرچم‌های لازم (با کاما)">
                        <input
                          className={inputClass}
                          dir="ltr"
                          placeholder="ledger"
                          value={(step.eligibility.features ?? []).join(", ")}
                          disabled={!canManage}
                          onChange={(event) => {
                            const next = { ...step.eligibility };
                            const flags = flagsFrom(event.target.value);
                            if (flags.length > 0) next.features = flags;
                            else delete next.features;
                            updateStep(index, { eligibility: next });
                          }}
                        />
                      </Field>
                      <Field label="پرچم‌های خاموش (با کاما)">
                        <input
                          className={inputClass}
                          dir="ltr"
                          placeholder="ai_assistant"
                          value={(step.eligibility.withoutFeatures ?? []).join(", ")}
                          disabled={!canManage}
                          onChange={(event) => {
                            const next = { ...step.eligibility };
                            const flags = flagsFrom(event.target.value);
                            if (flags.length > 0) next.withoutFeatures = flags;
                            else delete next.withoutFeatures;
                            updateStep(index, { eligibility: next });
                          }}
                        />
                      </Field>
                    </div>
                  </details>
                  {step.kind === "action" ? (
                    <p className="mt-1.5 px-1 text-[11px] leading-5 text-muted-foreground">
                      {tourVerifierDefinition(step.verifier)?.promise ??
                        "این مرحله فقط با تأیید سرور کامل می‌شود؛ تأییدکننده را انتخاب کنید."}{" "}
                      <span className="font-mono" dir="ltr">
                        {tourVerifierDefinition(step.verifier)?.recordedBy}
                      </span>
                    </p>
                  ) : null}
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
