"use client";
/**
 * Guided Tours Studio — global catalogue and step editor. Authors do not
 * operate tenants; their published explanations appear through «آموزش».
 */
import { useEffect, useMemo, useState } from "react";
import { KNOWLEDGE_PAGES } from "@/lib/knowledge-base";
import { TOUR_ANCHORS, type TourDefinition, type TourEligibility, type TourStep } from "@/lib/tours";
import { api, Button, ErrorBox, useCan } from "../ui";

type Status = "draft" | "published";
type EditorTour = {
  id: string; pageKey: string; title: string; description: string;
  eligibility: TourEligibility; steps: TourStep[];
  status: Status; expectedVersion?: number;
};
type Stored = TourDefinition & {
  status: Status; createdAt: string; updatedAt: string; publishedAt: string | null;
};
interface Result { tours: Stored[]; codeTours: TourDefinition[]; error?: string }
const emptyTour = (): EditorTour => ({
  id: "", pageKey: "page:/accounting/products", title: "",
  description: "", status: "draft", eligibility: {},
  steps: [{ id: "welcome", kind: "explain", title: "به این بخش خوش آمدید", body: "در این قسمت با امکانات اصلی صفحه آشنا می‌شوید." }],
});
const initialStep = (): TourStep => ({ id: `step-${Math.random().toString(36).slice(2, 8)}`, kind: "explain", title: "", body: "" });
const anchors = Object.values(TOUR_ANCHORS);
const asEditor = (tour: TourDefinition & { status?: Status }): EditorTour => ({
  id: tour.id, pageKey: tour.pageKey, title: tour.title,
  description: tour.description, eligibility: tour.eligibility, steps: [...tour.steps],
  status: tour.status ?? "draft",
  ...("status" in tour ? { expectedVersion: tour.version } : {}),
});
const errMsg = (raw: string | undefined) => {
  const messages: Record<string, string> = {
    version_conflict: "این تور در جای دیگری تغییر کرده است؛ فهرست را تازه کنید.",
    unknown_anchor: "هدف برجسته‌سازی ناشناخته است.",
    unknown_page: "صفحهٔ انتخاب‌شده معتبر نیست.",
    invalid_eligibility: "شرط‌های نمایش نامعتبر است.",
    invalid_steps: "تور حداقل یک و حداکثر ۶۰ مرحله می‌خواهد.",
  };
  return messages[raw ?? ""] ?? raw ?? "ذخیره انجام نشد.";
};
export function TourStudioPanel() {
  const can = useCan();
  const canManage = can("knowledge.manage");
  const [catalogue, setCatalogue] = useState<Result | null>(null);
  const [editing, setEditing] = useState<EditorTour | null>(null);
  const [filter, setFilter] = useState("");
  const [eligibilityJson, setEligibilityJson] = useState("{}");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<{ version: number; createdAt: string }[]>([]);

  const refresh = async () => {
    const { ok, data } = await api<Result>("/api/platform/knowledge/tours");
    if (ok) setCatalogue(data);
    else setError(errMsg(data.error));
  };
  useEffect(() => { void refresh(); }, []);

  const startEdit = (value: EditorTour) => {
    setEditing({ ...value, steps: value.steps.map((step) => ({ ...step })) });
    setEligibilityJson(JSON.stringify(value.eligibility, null, 2));
    setError(""); setMessage(""); setHistory([]);
    if (value.expectedVersion !== undefined) {
      void api<{ revisions: { version: number; createdAt: string }[] }>(
        `/api/platform/knowledge/tours/${encodeURIComponent(value.id)}`,
      ).then((r) => { if (r.ok) setHistory(r.data.revisions); });
    }
  };
  const authored = catalogue?.tours ?? [];
  const codeOnly = (catalogue?.codeTours ?? []).filter((x) => !authored.some((a) => a.id === x.id));
  const allTours = [...authored, ...codeOnly];
  const rows = allTours.filter((x) =>
    !filter || x.title.includes(filter) || x.id.includes(filter) || x.pageKey.includes(filter));
  const coveredPages = new Set(allTours.filter((tour) =>
    !("status" in tour) || tour.status === "published").map((tour) => tour.pageKey));
  const uncovered = KNOWLEDGE_PAGES.filter((page) => !coveredPages.has(page.key));
  const groupOf = (key: string) => KNOWLEDGE_PAGES.find((p) => p.key === key)?.label ?? key;
  const pageAnchors = useMemo(() => {
    const codeSteps = catalogue?.codeTours.filter((t) => t.pageKey === editing?.pageKey).flatMap((t) => t.steps) ?? [];
    const registered = new Set(codeSteps.flatMap((step) => step.anchor ? [step.anchor] : []));
    return anchors.filter((x) => registered.has(x));
  }, [catalogue, editing?.pageKey]);
  const patch = (values: Partial<EditorTour>) => setEditing((prev) => prev ? { ...prev, ...values } : prev);
  const modifyStep = (index: number, update: Partial<TourStep>) =>
    patch({ steps: (editing?.steps ?? []).map((step, i) => i === index ? { ...step, ...update } : step) });
  const moveStep = (index: number, next: number) => {
    const steps = [...(editing?.steps ?? [])];
    if (next < 0 || next >= steps.length) return;
    [steps[index], steps[next]] = [steps[next], steps[index]];
    patch({ steps });
  };
  const save = async (status: Status) => {
    if (!editing || !canManage) return;
    let eligibility: TourEligibility;
    try { eligibility = JSON.parse(eligibilityJson) as TourEligibility; }
    catch { setError("فرمت JSON شرایط دسترسی معتبر نیست."); return; }
    setBusy(true); setError(""); setMessage("");
    const input = { ...editing, eligibility, status };
    const { ok, data } = await api<{ ok?: boolean; error?: string; id?: string; version?: number }>(
      "/api/platform/knowledge/tours",
      { method: "POST", body: JSON.stringify(input) },
    );
    setBusy(false);
    if (!ok) { setError(errMsg(data.error)); return; }
    setMessage(status === "published" ? "تور منتشر شد." : "پیش‌نویس ذخیره شد.");
    patch({ status, expectedVersion: data.version });
    await refresh();
  };
  const restore = async (version: number) => {
    if (!editing?.expectedVersion || !canManage) return;
    setBusy(true); setError("");
    const { ok, data } = await api<{ error?: string; version?: number }>(
      `/api/platform/knowledge/tours/${encodeURIComponent(editing.id)}`,
      { method: "POST", body: JSON.stringify({ version, expectedVersion: editing.expectedVersion }) },
    );
    setBusy(false);
    if (!ok) { setError(errMsg(data.error)); return; }
    setMessage(`نسخهٔ ${version} بازیابی شد؛ این تغییر یک نسخهٔ جدید ساخته است.`);
    const { ok: readOk, data: updated } = await api<{ tour: Stored }>(
      `/api/platform/knowledge/tours/${encodeURIComponent(editing.id)}`,
    );
    if (readOk) startEdit(asEditor(updated.tour));
    await refresh();
  };
  const remove = async () => {
    if (!editing?.expectedVersion || editing.status !== "draft" || !canManage) return;
    if (!window.confirm("این پیش‌نویس و تاریخچهٔ آن حذف شوند؟")) return;
    const { ok, data } = await api<{ error?: string }>(
      `/api/platform/knowledge/tours/${encodeURIComponent(editing.id)}`, { method: "DELETE" },
    );
    if (!ok) { setError(errMsg(data.error)); return; }
    setEditing(null); await refresh();
  };

  return <div className="space-y-4" dir="rtl">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 className="text-lg font-semibold">استودیوی تورهای تعاملی</h2>
        <p className="text-sm text-muted-foreground">انتخاب صفحه، ساخت مراحل، پیش‌نویس، انتشار و بازگردانی نسخه‌های قبلی؛ بدون تغییر کد.</p>
      </div>
      <div className="flex gap-2">
        <Button onClick={() => void refresh()} variant="outline">بازخوانی</Button>
        {canManage ? <Button onClick={() => startEdit(emptyTour())}>تور جدید</Button> : null}
      </div>
    </div>
    <details className="rounded-xl border border-border p-3">
      <summary className="cursor-pointer font-semibold">
        پوشش صفحات: {coveredPages.size} صفحه با تور فعال از {KNOWLEDGE_PAGES.length} صفحهٔ ثبت‌شده
      </summary>
      <p className="mt-2 text-sm text-muted-foreground">
        برای صفحه‌های فاقد تور، یک راهنمای توضیحی بسازید. برای راهنمای برجسته‌سازی، ابتدا باید هدف پایدار در رابط صفحه ثبت شود.
      </p>
      <div className="mt-3 grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
        {uncovered.map((page) => <div key={page.key} className="flex items-center justify-between gap-2 rounded-lg border border-border p-2 text-xs">
          <span>{page.group} / {page.label}</span>
          {canManage ? <Button variant="outline" size="sm" onClick={() => startEdit({
            ...emptyTour(), pageKey: page.key,
          })}>ایجاد تور</Button> : null}
        </div>)}
      </div>
    </details>
    {error ? <ErrorBox>{error}</ErrorBox> : null}
    {message ? <p role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">{message}</p> : null}
    <label className="block space-y-1 text-sm">جست‌وجوی تور
      <input className="mt-1 w-full rounded-lg border bg-card p-3" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="نام، شناسه یا صفحه" />
    </label>
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[560px] text-right text-sm">
        <thead className="bg-muted/50"><tr><th className="p-3">تور</th><th className="p-3">صفحه</th><th className="p-3">وضعیت</th><th className="p-3">مراحل</th><th className="p-3">عملیات</th></tr></thead>
        <tbody>{rows.map((tour) => {
          const existing = authored.some((a) => a.id === tour.id);
          return <tr key={tour.id} className="border-t border-border">
            <td className="p-3"><strong>{tour.title}</strong><div className="font-mono text-xs text-muted-foreground" dir="ltr">{tour.id}</div></td>
            <td className="p-3">{groupOf(tour.pageKey)}</td>
            <td className="p-3">{existing ? (tour as Stored).status === "published" ? "منتشرشده" : "پیش‌نویس" : "داخلی (کد)"}</td>
            <td className="p-3">{tour.steps.length}</td>
            <td className="p-3"><Button variant="outline" size="sm" onClick={() => {
              const value = asEditor(tour);
              startEdit(value);
            }}>{existing ? "ویرایش" : "ورود به استودیو"}</Button></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    {editing ? <section className="space-y-4 rounded-xl border border-border p-4" aria-label="ویرایش تور">
      <div className="flex items-center justify-between gap-3"><h3 className="font-bold">ویرایش تور: {editing.title || "تور جدید"}</h3><Button variant="outline" onClick={() => setEditing(null)}>بستن</Button></div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm">شناسهٔ یکتای تور
          <input dir="ltr" className="mt-1 w-full rounded-lg border bg-card p-2 font-mono" value={editing.id} disabled={editing.expectedVersion !== undefined || !canManage} onChange={(e) => patch({ id: e.target.value })} placeholder="accounting.cosmetics.start" />
        </label>
        <label className="block text-sm">صفحه
          <select className="mt-1 w-full rounded-lg border bg-card p-2" value={editing.pageKey} disabled={!canManage} onChange={(e) => patch({ pageKey: e.target.value })}>
            {KNOWLEDGE_PAGES.map((p) => <option key={p.key} value={p.key}>{p.group} / {p.label}</option>)}
          </select>
        </label>
        <label className="block text-sm">عنوان
          <input className="mt-1 w-full rounded-lg border bg-card p-2" value={editing.title} disabled={!canManage} onChange={(e) => patch({ title: e.target.value })} />
        </label>
        <label className="block text-sm">توضیح کوتاه
          <input className="mt-1 w-full rounded-lg border bg-card p-2" value={editing.description} disabled={!canManage} onChange={(e) => patch({ description: e.target.value })} />
        </label>
      </div>
      <label className="block text-sm">شرایط نمایش تور (JSON)
        <textarea dir="ltr" rows={3} className="mt-1 w-full rounded-lg border bg-card p-2 font-mono text-xs" value={eligibilityJson} disabled={!canManage} onChange={(e) => setEligibilityJson(e.target.value)} />
        <span className="block text-xs text-muted-foreground">مثال: {JSON.stringify({ permissions: ["inventory.view"], industries: ["cosmetics"] })} — محدودیت‌ها در سرور اعتبارسنجی می‌شوند.</span>
      </label>
      <div className="flex items-center justify-between"><h4 className="font-semibold">مراحل تور</h4>{canManage && editing.steps.length < 60 ? <Button variant="outline" onClick={() => patch({ steps: [...editing.steps, initialStep()] })}>افزودن مرحله</Button> : null}</div>
      {pageAnchors.length === 0 ? <p className="rounded-lg bg-muted p-3 text-sm">برای این صفحه هدف برجسته‌سازی ثبت نشده است. می‌توانید با مراحل «توضیحی» تور بسازید. برای برجسته‌سازی کنترل جدید، ابتدا باید هدف امن در کد صفحه ثبت شود.</p> : null}
      <ol className="space-y-3">{editing.steps.map((step, index) =>
        <li key={index} className="space-y-2 rounded-xl border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><strong>مرحلهٔ {index + 1}</strong>
            {canManage ? <div className="flex gap-1">
              <Button size="sm" variant="outline" disabled={index === 0} onClick={() => moveStep(index, index - 1)}>بالا</Button>
              <Button size="sm" variant="outline" disabled={index === editing.steps.length - 1} onClick={() => moveStep(index, index + 1)}>پایین</Button>
              <Button size="sm" variant="outline" disabled={editing.steps.length <= 1} onClick={() => patch({ steps: editing.steps.filter((_, i) => i !== index) })}>حذف</Button>
            </div> : null}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs">شناسه مرحله <input dir="ltr" className="mt-1 w-full rounded-lg border bg-card p-2" disabled={!canManage} value={step.id} onChange={(e) => modifyStep(index, { id: e.target.value })} /></label>
            <label className="text-xs">نوع
              <select className="mt-1 w-full rounded-lg border bg-card p-2" disabled={!canManage} value={step.kind}
                onChange={(e) => {
                  const kind = e.target.value as "explain" | "spotlight";
                  modifyStep(index, kind === "explain" ? { kind, anchor: undefined } : { kind, anchor: pageAnchors[0] as TourStep["anchor"] });
                }}>
                <option value="explain">توضیحی</option>
                <option value="spotlight" disabled={!pageAnchors.length}>برجسته‌سازی</option>
              </select>
            </label>
          </div>
          {step.kind === "spotlight" ? <label className="block text-xs">هدف برجسته‌سازی
            <select dir="ltr" className="mt-1 w-full rounded-lg border bg-card p-2" disabled={!canManage} value={step.anchor ?? ""} onChange={(e) => modifyStep(index, { anchor: e.target.value as TourStep["anchor"] })}>
              {!pageAnchors.includes(step.anchor ?? "") ? <option value={step.anchor ?? ""}>{step.anchor ?? "انتخاب هدف"}</option> : null}
              {pageAnchors.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label> : null}
          <label className="block text-xs">عنوان <input className="mt-1 w-full rounded-lg border bg-card p-2" disabled={!canManage} value={step.title} onChange={(e) => modifyStep(index, { title: e.target.value })} /></label>
          <label className="block text-xs">متن راهنما <textarea rows={3} className="mt-1 w-full rounded-lg border bg-card p-2" disabled={!canManage} value={step.body} onChange={(e) => modifyStep(index, { body: e.target.value })} /></label>
          <div className="rounded-lg bg-muted/50 p-3 text-sm" aria-label="پیش‌نمایش مرحله"><strong>{step.title || "بدون عنوان"}</strong><p className="mt-1 whitespace-pre-line">{step.body}</p></div>
        </li>,
      )}</ol>
      {canManage ? <div className="flex flex-wrap gap-2">
        <Button disabled={busy} variant="outline" onClick={() => void save("draft")}>ذخیره پیش‌نویس</Button>
        <Button disabled={busy} onClick={() => void save("published")}>انتشار تور</Button>
        {editing.status === "draft" && editing.expectedVersion !== undefined ? <Button variant="outline" disabled={busy} onClick={() => void remove()}>حذف پیش‌نویس</Button> : null}
      </div> : null}
      {history.length > 0 ? <div className="space-y-2"><h4 className="font-semibold">تاریخچهٔ نسخه‌ها</h4>
        {history.map((item) => <div key={item.version} className="flex items-center justify-between border-b py-2 text-sm"><span>نسخه {item.version}</span>
          {canManage ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void restore(item.version)}>بازگردانی</Button> : null}
        </div>)}
      </div> : null}
    </section> : null}
  </div>;
}
