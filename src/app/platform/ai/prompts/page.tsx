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
import { api, Button, Card, Field, InfoBox, inputClass, useCan } from "../../ui";
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

export default function PlatformAiPromptsPage() {
  const canManage = useCan()("ai.config.manage");
  const [scopes, setScopes] = useState<ScopeDef[]>([]);
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [scope, setScope] = useState("");
  const [draft, setDraft] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ scopes: ScopeDef[]; versions: PromptVersion[] }>("/api/platform/ai/prompts");
    if (!ok) return;
    setScopes(data.scopes ?? []);
    setVersions(data.versions ?? []);
    setScope((current) => current || data.scopes?.[0]?.key || "");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const forScope = versions.filter((version) => version.scopeKey === scope);
  const published = forScope.find((version) => version.state === "published") ?? null;
  const activeScope = scopes.find((entry) => entry.key === scope);

  async function run(action: string, body: Record<string, unknown>) {
    setBusy(true);
    const { ok, data } = await api<{ error?: string }>("/api/platform/ai/prompts", {
      method: "POST",
      body: JSON.stringify({ action, ...body }),
    });
    setBusy(false);
    if (!ok) {
      alert(data.error ?? "انجام نشد");
      return;
    }
    setDraft("");
    setNotes("");
    void load();
  }

  return (
    <div className="space-y-4">
      <AiConsoleNav />
      <InfoBox>
        یک حل‌کنندهٔ پرامپت، لایه‌به‌لایه. انتشار یک نسخه فقط «متن» همان لایه را عوض می‌کند، نه وجودش را؛ و حوزه‌ای
        که نسخهٔ منتشرشده ندارد به پیش‌فرض کد برمی‌گردد — هرگز به پرامپت خالی.
      </InfoBox>

      <div className="flex flex-wrap gap-2">
        {scopes.map((entry) => (
          <Button
            key={entry.key}
            variant={scope === entry.key ? "primary" : "ghost"}
            onClick={() => setScope(entry.key)}
          >
            {entry.label}
          </Button>
        ))}
      </div>

      {activeScope ? (
        <Card title={activeScope.label}>
          <p className="text-sm leading-6 text-muted-foreground">{activeScope.hint}</p>
          <div className="mt-3 space-y-2">
            <p className="text-sm">
              نسخهٔ منتشرشدهٔ کنونی:{" "}
              <b dir="ltr">{published ? `v${published.version}` : "پیش‌فرض کد"}</b>
              {published?.publishedAt ? ` — ${new Date(published.publishedAt).toLocaleString("fa-IR")}` : ""}
            </p>
            {published ? (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border p-2 text-xs leading-6">
                {published.text}
              </pre>
            ) : null}
          </div>

          <div className="mt-4 space-y-3">
            <Field label="متن پیش‌نویس">
              <textarea
                className={inputClass}
                dir="rtl"
                rows={8}
                value={draft}
                disabled={!canManage}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={published?.text ?? "متن این لایه…"}
              />
            </Field>
            <Field label="یادداشت نسخه">
              <input
                className={inputClass}
                value={notes}
                disabled={!canManage}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>
            {canManage ? (
              <Button disabled={busy || !draft.trim()} onClick={() => void run("draft", { scopeKey: scope, text: draft, notes })}>
                ذخیره به‌عنوان پیش‌نویس
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card title="تاریخچهٔ نسخه‌ها">
        <div className="space-y-2">
          {forScope.length === 0 ? (
            <p className="text-sm text-muted-foreground">هنوز نسخه‌ای برای این حوزه ساخته نشده است.</p>
          ) : (
            forScope.map((version) => (
              <div
                key={version.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/70 p-2"
              >
                <div className="text-sm">
                  <b dir="ltr">v{version.version}</b> — {STATE_LABELS[version.state]}
                  {version.notes ? <span className="text-muted-foreground"> · {version.notes}</span> : null}
                </div>
                <div className="flex gap-2">
                  {canManage && version.state === "draft" ? (
                    <Button variant="ghost" disabled={busy} onClick={() => void run("publish", { id: version.id })}>
                      انتشار
                    </Button>
                  ) : null}
                  {canManage && version.state !== "published" ? (
                    <Button variant="ghost" disabled={busy} onClick={() => void run("rollback", { scopeKey: scope, targetVersion: version.version })}>
                      بازگردانی
                    </Button>
                  ) : null}
                  {canManage && version.state === "draft" ? (
                    <Button variant="ghost" disabled={busy} onClick={() => void run("retire", { id: version.id })}>
                      بایگانی
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
