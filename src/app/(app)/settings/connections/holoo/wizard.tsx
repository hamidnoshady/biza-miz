"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { LoadingSkeleton, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, InfoBox, inputClass, errorMessageOrRaw } from "@/app/dashboard/ui";

interface Connection {
  id: string;
  name: string;
  provider: string;
  status: string;
}

interface RunRow {
  id: string;
  status: string;
  summary: unknown;
  created_at?: string;
  createdAt?: string;
}

const EMPTY_MANIFEST = JSON.stringify(
  {
    base: { goods: [], persons: [], accounts: [], openingInventory: [] },
    transactions: [],
    openingBalance: [],
    journals: [],
  },
  null,
  2,
);

export function HolooMigrationWizard({ initialConnectionId }: { initialConnectionId: string | null }) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [connectionId, setConnectionId] = useState(initialConnectionId ?? "");
  const [manifestText, setManifestText] = useState(EMPTY_MANIFEST);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const selectedConnection = useMemo(
    () => connections?.find((c) => c.id === connectionId) ?? null,
    [connections, connectionId],
  );

  const load = useCallback(async () => {
    try {
      const res = await api<{ connections: Connection[] }>("/api/integrations/connections");
      if (!res.ok) {
        setError(errorMessageOrRaw((res.data as { error?: string }).error));
        setConnections([]);
        return;
      }
      const holoo = res.data.connections.filter((connection) => connection.provider === "holoo");
      setConnections(holoo);
      const nextConnectionId = initialConnectionId && holoo.some((c) => c.id === initialConnectionId)
        ? initialConnectionId
        : connectionId || holoo[0]?.id || "";
      if (nextConnectionId !== connectionId) setConnectionId(nextConnectionId);
    } catch {
      setError("بارگذاری اتصال‌های هلو ممکن نشد.");
      setConnections([]);
    }
  }, [connectionId, initialConnectionId]);

  const loadRuns = useCallback(async (id: string) => {
    if (!id) {
      setRuns([]);
      setSelectedRunId("");
      return;
    }
    setRuns(null);
    try {
      const res = await api<{ runs: RunRow[] }>(`/api/integrations/connections/${id}/migration`);
      const nextRuns = res.ok ? res.data.runs : [];
      setRuns(nextRuns);
      setSelectedRunId((current) =>
        nextRuns.some((run) => run.id === current) ? current : nextRuns[0]?.id || "",
      );
    } catch {
      setRuns([]);
      setSelectedRunId("");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadRuns(connectionId);
  }, [connectionId, loadRuns]);

  function parseManifest(): unknown | null {
    try {
      return JSON.parse(manifestText);
    } catch {
      setError("مانیفست JSON معتبر نیست.");
      return null;
    }
  }

  async function runAction(action: "preview" | "apply") {
    if (!connectionId) return;
    if (action === "apply") { window.location.assign("/settings/transfer"); return; }
    const manifest = parseManifest();
    if (!manifest) return;
    setBusy(action);
    setError(null);
    const res = await api(`/api/integrations/connections/${connectionId}/migration`, {
      method: "POST",
      body: JSON.stringify({ action, manifest }),
    });
    setBusy(null);
    if (!res.ok) {
      setError(errorMessageOrRaw((res.data as { error?: string }).error));
      return;
    }
    setResult(res.data);
    await loadRuns(connectionId);
  }

  async function discrepancy() {
    if (!connectionId) return;
    const manifest = parseManifest();
    if (!manifest) return;
    setBusy("discrepancy");
    setError(null);
    const res = await api(`/api/integrations/connections/${connectionId}/migration/discrepancies`, {
      method: "POST",
      body: JSON.stringify({ manifest }),
    });
    setBusy(null);
    if (!res.ok) {
      setError(errorMessageOrRaw((res.data as { error?: string }).error));
      return;
    }
    setResult(res.data);
  }

  async function rollback() {
    // Execution and preview approval belong to the single #845 transfer flow.
    window.location.assign("/settings/transfer");
  }

  if (connections === null) return <SectionCardSkeleton rows={5} />;

  return (
    <div className="space-y-5">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <SectionCard title="۱) اتصال و دامنهٔ داده" description="مانیفست را از ابزار probe/خروجی هلو بگیرید؛ هیچ چیزی تا مرحلهٔ apply نوشته نمی‌شود.">
        <label className="block text-sm text-muted-foreground">
          اتصال هلو
          <select className={inputClass} value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            <option value="">انتخاب کنید…</option>
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>{connection.name}</option>
            ))}
          </select>
        </label>
        {selectedConnection ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge tone={selectedConnection.status === "active" ? "positive" : selectedConnection.status === "error" ? "danger" : "neutral"}>
              {selectedConnection.status}
            </StatusBadge>
            <span>{selectedConnection.name}</span>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="۲) مانیفست مهاجرت" description="بخش‌های base، transactions، openingBalance و journals اختیاری‌اند؛ پیش‌نمایش همان چیزی را نشان می‌دهد که apply انجام می‌دهد.">
        <textarea
          className={`${inputClass} h-80 font-mono text-xs leading-5`}
          value={manifestText}
          onChange={(e) => setManifestText(e.target.value)}
          dir="ltr"
          spellCheck={false}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={!connectionId || busy === "preview"} onClick={() => runAction("preview")}>پیش‌نمایش</Button>
          <Button type="button" disabled={!connectionId || busy === "apply"} onClick={() => runAction("apply")}>ادامه در انتقال داده</Button>
          <Button type="button" variant="outline" disabled={!connectionId || busy === "discrepancy"} onClick={discrepancy}>گزارش اختلاف</Button>
        </div>
      </SectionCard>

      <SectionCard title="۳) Rollback run" description="اعمال و برگشت داده‌ها فقط در بخش انتقال داده، پس از پیش‌نمایش و بررسی مجوزهای مالی انجام می‌شود. دورهٔ بسته و داده‌های مصرف‌شده قابل برگشت نیستند.">
        {runs === null ? (
          <LoadingSkeleton rows={1} compact label="در حال بارگذاری اجرای مهاجرت" />
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <select className={inputClass} value={selectedRunId} onChange={(e) => setSelectedRunId(e.target.value)}>
              <option value="">run را انتخاب کنید…</option>
              {runs.map((run) => (
                <option key={run.id} value={run.id}>{run.id} — {run.status}</option>
              ))}
            </select>
            <Button type="button" variant="outline" disabled={!selectedRunId || busy === "rollback"} onClick={rollback}>بررسی برگشت در انتقال داده</Button>
          </div>
        )}
      </SectionCard>

      <SectionCard title="خروجی">
        {result ? (
          <pre className="max-h-96 overflow-auto rounded-xl bg-primary p-4 text-xs leading-5 text-primary-foreground" dir="ltr">
            {JSON.stringify(result, null, 2)}
          </pre>
        ) : (
          <InfoBox>ابتدا «پیش‌نمایش» را بزنید تا برنامهٔ import، اختلاف‌ها و موارد قابل rollback دیده شود.</InfoBox>
        )}
      </SectionCard>
    </div>
  );
}
