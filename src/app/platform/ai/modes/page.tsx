"use client";

/**
 * Issue #812 §3/§7 — the runtime-mode console.
 *
 * Three rows, one per user-facing mode, each naming the LiteLLM alias that mode
 * asks for. That is the entire surface: the app picks an alias and nothing else.
 * Provider deployments, routing, fallbacks, retries, budgets and rate limits are
 * LiteLLM's, and there is deliberately no control here that would suggest
 * otherwise — a second place to configure routing is how two sources of truth
 * are born.
 *
 * A blank alias is a supported state, not an error: it means "the gateway's
 * default chat model", which is what a deployment that has not set aliases up
 * yet keeps doing. Turning this console on is therefore additive.
 */
import { useCallback, useEffect, useState } from "react";
import { api, Button, Card, Field, InfoBox, inputClass, useCan } from "../../ui";
import { AiConsoleNav } from "../ai-console-nav";
import { AI_MODE_LABELS, AI_RUNTIME_MODES, type AiRuntimeMode } from "@/lib/ai-runtime-modes-shared";

interface ModeRow {
  mode: AiRuntimeMode;
  modelAlias: string;
  isActive: boolean;
  temperature: number | null;
  maxOutputTokens: number | null;
  promptScopeKey: string;
  updatedBy: string;
}

export default function PlatformAiModesPage() {
  const canManage = useCan()("ai.config.manage");
  const [modes, setModes] = useState<ModeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<AiRuntimeMode | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ modes: ModeRow[] }>("/api/platform/ai/modes");
    if (ok) setModes(data.modes ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(mode: ModeRow) {
    setSaving(mode.mode);
    const { ok, data } = await api<{ error?: string }>("/api/platform/ai/modes", {
      method: "PUT",
      body: JSON.stringify({
        mode: mode.mode,
        modelAlias: mode.modelAlias,
        isActive: mode.isActive,
        temperature: mode.temperature,
        maxOutputTokens: mode.maxOutputTokens,
      }),
    });
    setSaving(null);
    if (!ok) {
      alert(data.error ?? "ذخیره نشد");
      return;
    }
    void load();
  }

  if (loading) return <p className="text-sm text-muted-foreground">در حال خواندن…</p>;

  return (
    <div className="space-y-4">
      <AiConsoleNav />
      <InfoBox>
        سه حالت کاربرپسند و نامشاپ لایت‌ال‌ال‌ام هرکدام. مسیریابی، جایگزینی، تلاش مجدد و سقف هزینه کار لایت‌ال‌ال‌ام
        است؛ اینجا فقط انتخاب می‌شود که هر حالت کدام نامشاپ را می‌خواهد. خالی گذاشتن یک نامشاپ یعنی «مدل پیش‌فرض
        دروازه»، که رفتار فعلیِ نصب‌هایی است که هنوز نامشاپی تنظیم نکرده‌اند.
      </InfoBox>

      {AI_RUNTIME_MODES.map((key) => {
        const row = modes.find((mode) => mode.mode === key);
        if (!row) return null;
        return (
          <Card key={key} title={AI_MODE_LABELS[key]}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="نامشاپ لایت‌ال‌ال‌ام">
                <input
                  className={inputClass}
                  dir="ltr"
                  value={row.modelAlias}
                  disabled={!canManage}
                  onChange={(event) =>
                    setModes((current) =>
                      current.map((mode) =>
                        mode.mode === key ? { ...mode, modelAlias: event.target.value } : mode,
                      ),
                    )
                  }
                  placeholder="pos-auto"
                />
              </Field>
              <Field label="دامنهٔ پرامپت">
                <input className={inputClass} dir="ltr" value={row.promptScopeKey} disabled />
              </Field>
              <Field label="دما (خالی = پیش‌فرض دروازه)">
                <input
                  className={inputClass}
                  dir="ltr"
                  inputMode="decimal"
                  value={row.temperature ?? ""}
                  disabled={!canManage}
                  onChange={(event) =>
                    setModes((current) =>
                      current.map((mode) =>
                        mode.mode === key
                          ? { ...mode, temperature: event.target.value === "" ? null : Number(event.target.value) }
                          : mode,
                      ),
                    )
                  }
                />
              </Field>
              <Field label="حداکثر توکن خروجی (خالی = پیش‌فرض)">
                <input
                  className={inputClass}
                  dir="ltr"
                  inputMode="numeric"
                  value={row.maxOutputTokens ?? ""}
                  disabled={!canManage}
                  onChange={(event) =>
                    setModes((current) =>
                      current.map((mode) =>
                        mode.mode === key
                          ? {
                              ...mode,
                              maxOutputTokens: event.target.value === "" ? null : Number(event.target.value),
                            }
                          : mode,
                      ),
                    )
                  }
                />
              </Field>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={row.isActive}
                  disabled={!canManage}
                  onChange={(event) =>
                    setModes((current) =>
                      current.map((mode) => (mode.mode === key ? { ...mode, isActive: event.target.checked } : mode)),
                    )
                  }
                />
                فعال
              </label>
              {canManage ? (
                <Button disabled={saving === key} onClick={() => void save(row)}>
                  {saving === key ? "در حال ذخیره…" : "ذخیره"}
                </Button>
              ) : null}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
