"use client";

/**
 * Issue #812 §8 — the prompt console.
 *
 * One scope per layer of the resolver, versions per scope, and a publish step
 * between an edit and production. The three-state machine is the safety
 * property, so it is the whole UI:
 *
 *   draft  — invisible to the runtime. Edit as often as you like.
 *   published — the live layer. Exactly one per scope, enforced by the table's
 *           partial unique index rather than by this page remembering.
 *   retired — history. Rollback republishes an older version rather than
 *           deleting anything, so what was live stays readable.
 *
 * A scope with nothing published resolves to the code default, which is stated
 * on the page: a platform admin should never wonder whether an empty console
 * means an empty prompt.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, Button, Card, ErrorBox, errorMessage, Field, InfoBox, inputClass, useCan } from "../../ui";
import { AiConsoleNav } from "../ai-console-nav";

interface PromptVersion {
  id: string;
  scopeKey: string;
  version: number;
  text: string;
  state: "draft" | "published" | "retired";
  notes: string;
  createdBy: string;
  publishedBy: string | null;
  publishedAt: string | null;
  createdAt: string;
}

interface ScopeDef {
  key: string;
  label: string;
  hint: string;
}

const STATE_LABELS: Record<PromptVersion["state"], string> = {
  draft: "پیش‌نویس",
  published: "منتشرشده",
  retired: "بایگانی",
};


const ENDPOINT = "/api/platform/ai/prompts";
const dateFormat = new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tehran" });

type ChangeAction = "publish" | "rollback";
type Layer = { scopeKey: string; version: number | null };
type Preview = { systemPrompt: string; layers: Record<"base" | "mode" | "agent" | "businessType" | "app", Layer | null> };
type PromptData = { scopes: ScopeDef[]; versions: PromptVersion[] };

const ERROR_LABELS: Record<string, string> = {
  prompt_text_required: "متن پیش‌نویس را وارد کنید.",
  prompt_text_too_long: "متن پرامپت بیش از حد طولانی است.",
  prompt_publish_conflict: "نسخهٔ فعال تغییر کرده است. نسخهٔ تازه را بررسی و دوباره تأیید کنید.",
  prompt_not_a_draft: "این نسخه دیگر پیش‌نویس نیست.",
  prompt_already_published: "این نسخه در حال حاضر منتشر شده است.",
};

function PromptDiff({ before, after }: { before: string; after: string }) {
  if (before === after) return <p className="text-sm text-muted-foreground">متن این دو نسخه یکسان است.</p>;
  const previous = before.split("\n");
  const next = after.split("\n");
  let head = 0;
  while (head < previous.length && head < next.length && previous[head] === next[head]) head++;
  let tail = 0;
  while (head + tail < previous.length && head + tail < next.length &&
    previous[previous.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  return <div className="grid min-w-0 gap-2 md:grid-cols-2">
    <div className="min-w-0">
      <p className="text-xs">متن جایگزین‌شونده</p>
      <pre dir="auto" className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border p-2 text-xs">
        {previous.slice(head, previous.length - tail).join("\n") || "—"}
      </pre>
    </div>
    <div className="min-w-0">
      <p className="text-xs">متن نسخهٔ انتخابی</p>
      <pre dir="auto" className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border p-2 text-xs">
        {next.slice(head, next.length - tail).join("\n") || "—"}
      </pre>
    </div>
  </div>;
}

export default function PlatformAiPromptsPage() {
  const canManage = useCan()("ai.config.manage");
  const [scopes, setScopes] = useState<ScopeDef[]>([]);
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [scope, setScope] = useState("");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [notes, setNotes] = useState("");
  const [editing, setEditing] = useState<PromptVersion | null>(null);
  const [selected, setSelected] = useState<PromptVersion | null>(null);
  const [confirmation, setConfirmation] = useState<{ action: ChangeAction; target: PromptVersion; expected: string | null } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>("load");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dirty = draft !== (editing?.text ?? "") || notes !== (editing?.notes ?? "");

  const load = useCallback(async (signal?: AbortSignal) => {
    const { ok, data, aborted } = await api<PromptData & { error?: string }>(ENDPOINT, { signal });
    if (aborted || signal?.aborted) return;
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    const registered = new Map(data.scopes.map((entry) => [entry.key, entry]));
    for (const version of data.versions) {
      if (!registered.has(version.scopeKey)) {
        registered.set(version.scopeKey, { key: version.scopeKey, label: version.scopeKey, hint: "" });
      }
    }
    setScopes([...registered.values()]);
    setVersions(data.versions);
    setScope((current) => current || data.scopes[0]?.key || "");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).finally(() => {
      if (!controller.signal.aborted) setBusy(null);
    });
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const forScope = versions.filter((version) => version.scopeKey === scope);
  const published = forScope.find((version) => version.state === "published") ?? null;
  const activeScope = scopes.find((entry) => entry.key === scope);
  const visibleScopes = scopes.filter((entry) => `${entry.label} ${entry.key}`.toLowerCase().includes(search.trim().toLowerCase()));
  const isResearch = scope === "mode:deep_research";
  const draftMode = scope === "base" ? "auto" : /^mode:(auto|instant|thinking)$/.exec(scope)?.[1];

  function edit(version: PromptVersion | null) {
    setEditing(version);
    setDraft(version?.text ?? "");
    setNotes(version?.notes ?? "");
  }

  async function run(action: string, body: Record<string, unknown>) {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const { ok, data } = await api<{ error?: string; version?: PromptVersion }>(ENDPOINT, {
        method: "POST",
        body: JSON.stringify({ action, ...body }),
      });
      if (!ok) {
        const code = data.error ?? "";
        setError(Object.hasOwn(ERROR_LABELS, code) ? ERROR_LABELS[code] : errorMessage(code));
        if (code === "prompt_publish_conflict") {
          setConfirmation(null);
          await load();
        }
        return;
      }
      setNotice(action === "draft" ? "نسخهٔ پیش‌نویس ذخیره شد." : "تغییر نسخه ثبت شد.");
      setConfirmation(null);
      setPreview(null);
      setSelected(data.version ?? null);
      if (action === "draft" && data.version) edit(data.version);
      if (action !== "draft" && editing?.id === (body.id ?? confirmation?.target.id)) edit(null);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function showPreview() {
    setBusy("preview");
    setError("");
    try {
      const { ok, data } = await api<Preview & { error?: string }>(`${ENDPOINT}?previewScope=${encodeURIComponent(scope)}`);
      if (ok) setPreview(data);
      else setError(errorMessage(data.error));
    } finally {
      setBusy(null);
    }
  }

  return <div className="space-y-4" dir="rtl">
    <AiConsoleNav />
    <h1 className="text-xl font-bold">لایه‌های پرامپت</h1>
    {error && <ErrorBox>{error} <Button variant="ghost" disabled={!!busy} onClick={() => {
      setBusy("load"); setError(""); void load().finally(() => setBusy(null));
    }}>بارگیری دوباره</Button></ErrorBox>}
    {notice && <div role="status"><InfoBox>{notice}</InfoBox></div>}
    <Field label="جست‌وجوی حوزه">
      <input className={inputClass} type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
    </Field>
    <Field label="حوزهٔ پرامپت" hint={dirty ? "برای تغییر حوزه، پیش‌نویس را ذخیره یا تغییرات را لغو کنید." : undefined}>
      <select className={inputClass} value={visibleScopes.some((entry) => entry.key === scope) ? scope : ""}
        disabled={!!busy || dirty} onChange={(event) => {
          setScope(event.target.value); edit(null); setSelected(null); setConfirmation(null); setPreview(null); setNotice("");
        }}>
        <option value="" disabled>{busy === "load" ? "در حال بارگیری…" : "یک حوزه را انتخاب کنید"}</option>
        {["base", "mode", "agent", "business_type", "app"].map((kind, index) => {
          const group = visibleScopes.filter((entry) => entry.key.split(":")[0] === kind);
          return group.length > 0 ? <optgroup key={kind} label={["پایه", "حالت پاسخ‌گویی", "ایجنت سیستمی", "نوع کسب‌وکار", "بخش"][index]}>
            {group.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
          </optgroup> : null;
        })}
      </select>
    </Field>

    {activeScope && <Card title={activeScope.label}>
      {activeScope.hint && <p className="text-sm text-muted-foreground">{activeScope.hint}</p>}
      <p className="my-2 text-sm">نسخهٔ فعال {published ? <bdi>v{published.version}</bdi> : "پیش‌فرض کد"}
        {published?.publishedAt && ` · ${dateFormat.format(new Date(published.publishedAt))}`}
        {published?.publishedBy && <> · <bdi>{published.publishedBy}</bdi></>}
      </p>
      {!isResearch && <Button variant="ghost" disabled={!!busy} onClick={() => void showPreview()}>نمایش پرامپت ترکیب‌شده</Button>}
      {preview && <section aria-label="پرامپت ترکیب‌شده" className="my-3 space-y-2">
        <p className="text-xs text-muted-foreground">پیش‌نمایش لایه‌های منتشرشده برای زمینهٔ انتخابی</p>
        <ul className="flex flex-wrap gap-2 text-xs">
          {Object.values(preview.layers).filter((entry): entry is Layer => !!entry && typeof entry === "object" && "scopeKey" in entry)
            .map((entry) => <li key={entry.scopeKey}><bdi>{entry.scopeKey}</bdi> · {entry.version ?? "پیش‌فرض"}</li>)}
        </ul>
        <pre dir="auto" className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border p-2 text-xs">{preview.systemPrompt}</pre>
      </section>}
      {canManage && <div className="mt-4">
        <Field label={editing ? `ویرایش پیش‌نویس نسخهٔ ${editing.version}` : "متن پیش‌نویس"}
          hint={`${draft.length.toLocaleString("fa-IR")} از ۴۰٬۰۰۰ نویسه`}>
          <textarea className={`${inputClass} h-auto min-h-32 py-2`} dir="auto" rows={8} maxLength={40000}
            value={draft} disabled={!!busy} onChange={(event) => setDraft(event.target.value)} />
        </Field>
        <Field label="یادداشت نسخه">
          <input className={inputClass} maxLength={2000} value={notes} disabled={!!busy} onChange={(event) => setNotes(event.target.value)} />
        </Field>
        {dirty && <p className="mb-2 text-sm text-muted-foreground">تغییرات ذخیره نشده‌اند.</p>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={!!busy || !dirty || !draft.trim()} onClick={() => void run("draft", { scopeKey: scope, text: draft, notes, editDraftId: editing?.id })}>
            ذخیرهٔ نسخهٔ پیش‌نویس
          </Button>
          {(dirty || editing) && <Button variant="ghost" disabled={!!busy} onClick={() => edit(null)}>پاک‌کردن فرم و شروع پیش‌نویس تازه</Button>}
        </div>
      </div>}
    </Card>}

    <Card title="تاریخچهٔ نسخه‌ها">
      {forScope.length === 0 && <p className="text-sm text-muted-foreground">هنوز نسخه‌ای برای این حوزه ساخته نشده است.</p>}
      <ul className="space-y-2">
        {forScope.map((version) => <li key={version.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-2">
          <div className="min-w-0 break-words text-sm">
            <bdi>v{version.version}</bdi> · {STATE_LABELS[version.state]} · <bdi>{version.createdBy}</bdi>
            {version.createdAt && ` · ${dateFormat.format(new Date(version.createdAt))}`}
            {version.notes && <p className="text-muted-foreground">{version.notes}</p>}
          </div>
          <div className="flex flex-wrap gap-1">
            <Button variant="ghost" disabled={!!busy} onClick={() => setSelected(version)}>متن و اختلاف نسخه</Button>
            {canManage && version.state === "draft" && <>
              <Button variant="ghost" disabled={!!busy || dirty} onClick={() => edit(version)}>ویرایش</Button>
              {draftMode && <Link className="self-center text-sm text-primary underline" href={`/platform/ai/playground?draft=${encodeURIComponent(version.id)}&mode=${draftMode}`}>
                آزمایش نسخهٔ ذخیره‌شده
              </Link>}
              <Button variant="ghost" disabled={!!busy || dirty} onClick={() => void run("retire", { id: version.id })}>بایگانی</Button>
            </>}
            {canManage && version.state !== "published" && <Button variant="ghost" disabled={!!busy} onClick={() =>
              setConfirmation({ action: version.state === "draft" ? "publish" : "rollback", target: version, expected: published?.id ?? null })}>
              {version.state === "draft" ? "انتشار" : "بازگردانی"}
            </Button>}
          </div>
        </li>)}
      </ul>
    </Card>

    {selected && <Card title={`نسخهٔ ${selected.version}`}>
      <pre dir="auto" className="mb-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border p-2 text-xs">{selected.text}</pre>
      <PromptDiff before={published?.text ?? ""} after={selected.text} />
      <Button variant="ghost" onClick={() => setSelected(null)}>بستن جزئیات</Button>
    </Card>}

    {confirmation && <Card title={confirmation.action === "publish" ? "تأیید انتشار" : "تأیید بازگردانی"}>
      <p className="mb-2 text-sm">نسخهٔ فعال {published ? <bdi>v{published.version}</bdi> : "پیش‌فرض کد"} · نسخهٔ مقصد <bdi>v{confirmation.target.version}</bdi> · <bdi>{confirmation.target.createdBy}</bdi></p>
      <InfoBox>پس از تأیید، درخواست‌های تازه‌ای که از این حوزه استفاده می‌کنند با نسخهٔ مقصد اجرا خواهند شد.</InfoBox>
      <PromptDiff before={published?.text ?? ""} after={confirmation.target.text} />
      <div className="mt-3 flex gap-2">
        <Button disabled={!!busy} onClick={() => void run(confirmation.action, {
          id: confirmation.target.id, scopeKey: scope, targetVersion: confirmation.target.version, expectedPublishedId: confirmation.expected,
        })}>تأیید تغییر نسخه</Button>
        <Button variant="ghost" disabled={!!busy} onClick={() => setConfirmation(null)}>لغو</Button>
      </div>
    </Card>}
  </div>;
}
