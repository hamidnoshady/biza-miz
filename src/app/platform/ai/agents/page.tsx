"use client";

/**
 * Issue #812 §9 — the system-agent console.
 *
 * The only place an agent may exist. There is no tenant agent builder, so a
 * business never picks an agent: a platform admin decides which businesses see
 * which suggestion card, and the card carries the starter prompt, the app focus
 * it opens in and the permissions/apps/features it requires.
 *
 * The capability rule is stated on the page because it is the reason this
 * console is safe to hand out: every allowlist here can only NARROW. The runtime
 * intersects the platform tool catalogue with the agent's allowlist, the
 * tenant's app availability, the member's effective permissions and the
 * location/project scope — and the member's own permissions are the last term,
 * so the worst a badly configured agent can do is be useless.
 */
import { useCallback, useEffect, useState } from "react";
import { api, Button, Card, Field, InfoBox, inputClass, useCan } from "../../ui";
import { AiConsoleNav } from "../ai-console-nav";

interface SystemAgent {
  id: string;
  agentKey: string;
  name: string;
  description: string;
  instructions: string;
  state: "draft" | "published" | "retired";
  version: number;
  allowedTools: string[];
  allowedActions: string[];
  requiredPermissions: string[];
  memoryScopes: string[];
}

interface Assignment {
  id: string;
  agentId: string;
  businessId: string | null;
  businessType: string | null;
  prompt: string;
  appFocus: string;
  requiredPermissions: string[];
  requiredApps: string[];
  requiredFeatures: string[];
  preferredMode: string | null;
  enabled: boolean;
}

const STATE_LABELS: Record<SystemAgent["state"], string> = {
  draft: "پیش‌نویس",
  published: "منتشرشده",
  retired: "بایگانی",
};

export default function PlatformAiAgentsPage() {
  const canManage = useCan()("ai.config.manage");
  const [agents, setAgents] = useState<SystemAgent[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    agentKey: "",
    name: "",
    description: "",
    instructions: "",
    allowedTools: "",
    allowedActions: "",
    requiredPermissions: "",
  });
  const [assignmentForm, setAssignmentForm] = useState({
    agentId: "",
    businessType: "",
    prompt: "",
    appFocus: "all",
    requiredPermissions: "",
    requiredApps: "",
    requiredFeatures: "",
    preferredMode: "auto",
  });

  const load = useCallback(async () => {
    const { ok, data } = await api<{ agents: SystemAgent[]; assignments: Assignment[] }>("/api/platform/ai/agents");
    if (!ok) return;
    setAgents(data.agents ?? []);
    setAssignments(data.assignments ?? []);
    setAssignmentForm((current) => ({ ...current, agentId: current.agentId || data.agents?.[0]?.id || "" }));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: string, body: Record<string, unknown>) {
    setBusy(true);
    const { ok, data } = await api<{ error?: string; message?: string }>("/api/platform/ai/agents", {
      method: "POST",
      body: JSON.stringify({ action, ...body }),
    });
    setBusy(false);
    if (!ok) {
      alert(data.message ?? data.error ?? "انجام نشد");
      return;
    }
    void load();
  }

  const list = (value: string): string[] =>
    value
      .split(/[،,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);

  return (
    <div className="space-y-4">
      <AiConsoleNav />
      <InfoBox>
        ایجنت‌های سیستمی فقط اینجا ساخته و نسخه‌گذاری می‌شوند؛ کسب‌وکار ایجنت نمی‌سازد و نمی‌گزیند. هر فهرست مجاز
        اینجا فقط می‌تواند «تنگ» کند: تقاطع ابزارهای پلتفرم با فهرست ایجنت، دسترسی بخش‌های کسب‌وکار، مجوزهای مؤثر
        عضو و دامنهٔ شعبه/پروژه تعیین می‌کند چه می‌شود — و مجوزهای خودِ عضو آخرین جمله است. شناسهٔ ناشناس بی‌صدا
        رد می‌شود.
      </InfoBox>

      {canManage ? (
        <Card title="ایجنت جدید">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="کلید (انگلیسی، یکتا)">
              <input
                className={inputClass}
                dir="ltr"
                value={form.agentKey}
                onChange={(event) => setForm({ ...form, agentKey: event.target.value })}
                placeholder="monthly-close-review"
              />
            </Field>
            <Field label="نام">
              <input
                className={inputClass}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="بازبینی بستن ماه"
              />
            </Field>
            <Field label="توضیح">
              <input
                className={inputClass}
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </Field>
            <Field label="ابزارهای مجاز (با فاصله)">
              <input
                className={inputClass}
                dir="ltr"
                value={form.allowedTools}
                onChange={(event) => setForm({ ...form, allowedTools: event.target.value })}
                placeholder="run_report get_ar_aging"
              />
            </Field>
            <Field label="عملیات مجاز (با فاصله)">
              <input
                className={inputClass}
                dir="ltr"
                value={form.allowedActions}
                onChange={(event) => setForm({ ...form, allowedActions: event.target.value })}
              />
            </Field>
            <Field label="مجوزهای لازم از عضو (با فاصله)">
              <input
                className={inputClass}
                dir="ltr"
                value={form.requiredPermissions}
                onChange={(event) => setForm({ ...form, requiredPermissions: event.target.value })}
                placeholder="accounting.read ai.use"
              />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="دستورالعمل ایجنت">
              <textarea
                className={inputClass}
                rows={5}
                value={form.instructions}
                onChange={(event) => setForm({ ...form, instructions: event.target.value })}
              />
            </Field>
          </div>
          <div className="mt-3">
            <Button
              disabled={busy}
              onClick={() =>
                void run("create", {
                  agentKey: form.agentKey,
                  name: form.name,
                  description: form.description,
                  instructions: form.instructions,
                  allowedTools: list(form.allowedTools),
                  allowedActions: list(form.allowedActions),
                  requiredPermissions: list(form.requiredPermissions),
                })
              }
            >
              ساختن به‌عنوان پیش‌نویس
            </Button>
          </div>
        </Card>
      ) : null}

      <Card title="ایجنت‌ها">
        <div className="space-y-2">
          {agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">هنوز ایجنتی ساخته نشده است.</p>
          ) : (
            agents.map((agent) => (
              <div key={agent.id} className="rounded-md border border-border/70 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm">
                    <b>{agent.name}</b> <span className="text-muted-foreground" dir="ltr">({agent.agentKey})</span> —{" "}
                    {STATE_LABELS[agent.state]} <span dir="ltr">v{agent.version}</span>
                  </div>
                  {canManage ? (
                    <div className="flex gap-2">
                      {agent.state !== "published" ? (
                        <Button variant="ghost" disabled={busy} onClick={() => void run("publish", { id: agent.id })}>
                          انتشار
                        </Button>
                      ) : null}
                      {agent.state === "published" ? (
                        <Button variant="ghost" disabled={busy} onClick={() => void run("retire", { id: agent.id })}>
                          بایگانی
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {agent.description ? <p className="mt-1 text-sm text-muted-foreground">{agent.description}</p> : null}
                {agent.instructions ? (
                  <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-border p-2 text-xs leading-6">
                    {agent.instructions}
                  </pre>
                ) : null}
                <p className="mt-2 text-xs text-muted-foreground" dir="ltr">
                  tools: {agent.allowedTools.join(", ") || "—"} · actions: {agent.allowedActions.join(", ") || "—"} ·
                  requires: {agent.requiredPermissions.join(", ") || "—"}
                </p>
              </div>
            ))
          )}
        </div>
      </Card>

      {canManage ? (
        <Card title="تخصیص به کسب‌وکار / نوع کسب‌وکار">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="ایجنت">
              <select
                className={inputClass}
                value={assignmentForm.agentId}
                onChange={(event) => setAssignmentForm({ ...assignmentForm, agentId: event.target.value })}
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="نوع کسب‌وکار (خالی = یک کسب‌وکار مشخص)">
              <input
                className={inputClass}
                dir="ltr"
                value={assignmentForm.businessType}
                onChange={(event) => setAssignmentForm({ ...assignmentForm, businessType: event.target.value })}
                placeholder="food_service"
              />
            </Field>
            <Field label="تمرکز بخش">
              <input
                className={inputClass}
                dir="ltr"
                value={assignmentForm.appFocus}
                onChange={(event) => setAssignmentForm({ ...assignmentForm, appFocus: event.target.value })}
              />
            </Field>
            <Field label="حالت ترجیحی">
              <input
                className={inputClass}
                dir="ltr"
                value={assignmentForm.preferredMode}
                onChange={(event) => setAssignmentForm({ ...assignmentForm, preferredMode: event.target.value })}
              />
            </Field>
            <Field label="مجوزهای لازم (با فاصله)">
              <input
                className={inputClass}
                dir="ltr"
                value={assignmentForm.requiredPermissions}
                onChange={(event) => setAssignmentForm({ ...assignmentForm, requiredPermissions: event.target.value })}
              />
            </Field>
            <Field label="بخش‌های لازم (با فاصله)">
              <input
                className={inputClass}
                dir="ltr"
                value={assignmentForm.requiredApps}
                onChange={(event) => setAssignmentForm({ ...assignmentForm, requiredApps: event.target.value })}
              />
            </Field>
            <Field label="ویژگی‌های لازم (با فاصله)">
              <input
                className={inputClass}
                dir="ltr"
                value={assignmentForm.requiredFeatures}
                onChange={(event) => setAssignmentForm({ ...assignmentForm, requiredFeatures: event.target.value })}
              />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="پرسش پیشنهادی که کاربر می‌بیند">
              <textarea
                className={inputClass}
                rows={3}
                value={assignmentForm.prompt}
                onChange={(event) => setAssignmentForm({ ...assignmentForm, prompt: event.target.value })}
              />
            </Field>
          </div>
          <div className="mt-3">
            <Button
              disabled={busy || !assignmentForm.agentId || !assignmentForm.prompt.trim()}
              onClick={() =>
                void run("assign", {
                  agentId: assignmentForm.agentId,
                  businessType: assignmentForm.businessType || null,
                  prompt: assignmentForm.prompt,
                  appFocus: assignmentForm.appFocus,
                  preferredMode: assignmentForm.preferredMode || null,
                  requiredPermissions: list(assignmentForm.requiredPermissions),
                  requiredApps: list(assignmentForm.requiredApps),
                  requiredFeatures: list(assignmentForm.requiredFeatures),
                })
              }
            >
              تخصیص
            </Button>
          </div>
        </Card>
      ) : null}

      <Card title="تخصیص‌ها">
        <div className="space-y-2">
          {assignments.length === 0 ? (
            <p className="text-sm text-muted-foreground">تخصیصی ثبت نشده است.</p>
          ) : (
            assignments.map((assignment) => {
              const agent = agents.find((entry) => entry.id === assignment.agentId);
              return (
                <div
                  key={assignment.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/70 p-2"
                >
                  <div className="text-sm">
                    <b>{agent?.name ?? "ایجنت حذف‌شده"}</b> —{" "}
                    {assignment.businessId ? `کسب‌وکار ${assignment.businessId}` : `نوع ${assignment.businessType}`} ·
                    تمرکز {assignment.appFocus}
                    {assignment.enabled ? "" : " · غیرفعال"}
                  </div>
                  {canManage ? (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void run("assignment-enabled", { id: assignment.id, enabled: !assignment.enabled })}
                    >
                      {assignment.enabled ? "غیرفعال کن" : "فعال کن"}
                    </Button>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </Card>
    </div>
  );
}
