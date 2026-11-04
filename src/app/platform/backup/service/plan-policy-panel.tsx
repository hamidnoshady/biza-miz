"use client";

/**
 * Issue #903 §3 — the per-plan policy editor.
 *
 * The managed service page already answers "where do the bytes go" and "with
 * what key"; this card answers the third question the epic asks of a Superadmin:
 * **with what policy, per plan**. A plan is the unit the product is sold in, so
 * «حرفه‌ای» can back up every six hours while the base tier stays nightly —
 * without an operator editing businesses one by one.
 *
 * Two things the screen owes the operator, and neither is decoration:
 *
 *   1. **The envelope.** Every field shows what the fleet row currently says, so
 *      "tighter" is a visible comparison rather than a rule the operator has to
 *      remember. The server clamps anyway; the copy exists so a value that gets
 *      clamped is understood, not silently ignored.
 *   2. **The truth about inheritance.** An empty field means "inherit", and the
 *      card says so in words. A blank box that meant zero would be a policy
 *      nobody set.
 *
 * Everything is `tenant_backup.policy`-gated, like enabling managed cloud: a
 * plan policy changes what the scheduler does for every business on it.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { api, Button, Card, ErrorBox, Field, InfoBox, inputClass, SkeletonRows, useCan } from "../../ui";
import { toPersianDigits } from "@/lib/digits";

interface PlanPolicy {
  intervalHours: number | null;
  retentionDays: number | null;
  keepCount: number | null;
  protectedCopies: number | null;
  maxArtifactBytes: number | null;
  alertStaleHours: number | null;
  alertFailureStreak: number | null;
  drillIntervalHours: number | null;
  drRpoHours: number | null;
}

interface FleetPolicy {
  intervalHours: number;
  retentionDays: number;
  maxRetentionDays: number;
  keepCount: number;
  protectedCopies: number;
  alertStaleHours: number;
  alertFailureStreak: number;
  drillIntervalHours: number;
  drRpoHours: number | null;
}

interface PlansResponse {
  fleet?: FleetPolicy;
  plans?: { planKey: string; name: string; policy: PlanPolicy | null }[];
  error?: string;
}

type Editable = "intervalHours" | "retentionDays" | "keepCount" | "alertStaleHours" | "alertFailureStreak" | "drillIntervalHours" | "drRpoHours";

const FIELDS: { key: Editable; label: string; hint: (fleet: FleetPolicy) => string }[] = [
  {
    key: "intervalHours",
    label: "فاصله پشتیبان‌گیری (ساعت)",
    hint: (fleet) => `پیش‌فرض ناوگان: هر ${toPersianDigits(String(fleet.intervalHours))} ساعت — فقط کوتاه‌تر یا مساوی`,
  },
  {
    key: "retentionDays",
    label: "نگهداری (روز)",
    hint: (fleet) =>
      `پیش‌فرض ناوگان: ${toPersianDigits(String(fleet.retentionDays))} روز، سقف ${toPersianDigits(String(fleet.maxRetentionDays))} روز`,
  },
  {
    key: "keepCount",
    label: "تعداد نسخهٔ ابری",
    hint: (fleet) => `پیش‌فرض ناوگان: ${toPersianDigits(String(fleet.keepCount))} نسخه — فقط کمتر یا مساوی`,
  },
  {
    key: "alertStaleHours",
    label: "آستانهٔ هشدار کهنگی (ساعت)",
    hint: (fleet) =>
      `پیش‌فرض ناوگان: ${toPersianDigits(String(fleet.alertStaleHours))} ساعت — فقط کوتاه‌تر (هشدار زودتر)`,
  },
  {
    key: "alertFailureStreak",
    label: "تعداد خطای پیاپی برای هشدار",
    hint: (fleet) =>
      `پیش‌فرض ناوگان: ${toPersianDigits(String(fleet.alertFailureStreak))} — فقط سخت‌گیرانه‌تر`,
  },
  {
    key: "drillIntervalHours",
    label: "فاصلهٔ آزمایش بازیابی (ساعت)",
    hint: (fleet) =>
      `پیش‌فرض ناوگان: هر ${toPersianDigits(String(fleet.drillIntervalHours))} ساعت — فقط بیشتر (آزمایش مکررتر)`,
  },
  {
    key: "drRpoHours",
    label: "هدف نقطهٔ بازیابی (ساعت)",
    hint: (fleet) =>
      fleet.drRpoHours === null
        ? "ناوگان هدفی تعیین نکرده است؛ خالی بماند یعنی وعده‌ای داده نمی‌شود"
        : `پیش‌فرض ناوگان: ${toPersianDigits(String(fleet.drRpoHours))} ساعت — فقط کوتاه‌تر`,
  },
];

export function PlanPolicyPanel() {
  const can = useCan();
  const canWrite = can("tenant_backup.policy");
  const [data, setData] = useState<PlansResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<Record<Editable, string>>>({});
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await api<PlansResponse>("/api/platform/backup/service/plans");
    if (!result.ok || !result.data.plans) {
      setError(result.data.error ?? "خواندن سیاست طرح‌ها ناموفق بود");
      return;
    }
    setData(result.data);
    setSelected((current) => current ?? result.data.plans?.[0]?.planKey ?? null);
    setError(null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const fleet = data?.fleet ?? null;
  const plan = data?.plans?.find((entry) => entry.planKey === selected) ?? null;

  const value = (key: Editable): string => {
    const edited = draft[key];
    if (edited !== undefined) return edited;
    const stored = plan?.policy?.[key];
    return stored === null || stored === undefined ? "" : String(stored);
  };

  const save = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const body: Record<string, unknown> = { planKey: plan.planKey };
    for (const field of FIELDS) {
      const entered = draft[field.key];
      if (entered === undefined) continue;
      // An emptied box is "inherit", which is what the server stores for null.
      body[field.key] = entered.trim() === "" ? null : Number(entered);
    }
    if (note.trim() !== "") body.note = note.trim();

    const result = await api<{ error?: string }>("/api/platform/backup/service/plans", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.data.error ?? "ذخیرهٔ سیاست طرح ناموفق بود");
      return;
    }
    setDraft({});
    setNote("");
    setNotice("سیاست این طرح ذخیره شد؛ کسب‌وکارهای این طرح از اجرای بعدی آن را رعایت می‌کنند.");
    await load();
  };

  const clear = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await api<{ error?: string }>(
      `/api/platform/backup/service/plans?planKey=${encodeURIComponent(plan.planKey)}`,
      { method: "DELETE" },
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.data.error ?? "حذف سیاست طرح ناموفق بود");
      return;
    }
    setDraft({});
    setNotice("سیاست این طرح حذف شد؛ همهٔ کسب‌وکارهای آن به پیش‌فرض ناوگان برگشتند.");
    await load();
  };

  if (!data) {
    return (
      <Card>
        <h2 className="text-sm font-semibold">سیاست هر طرح</h2>
        {error ? <ErrorBox>{error}</ErrorBox> : <SkeletonRows rows={3} />}
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">سیاست هر طرح</h2>
        <Button variant="ghost" onClick={() => void load()} disabled={busy}>
          <RefreshCw className={busy ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          بازخوانی
        </Button>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        هر طرح فاصله، نگهداری، آستانهٔ هشدار و هدف بازیابی خودش را دارد. یک طرح فقط می‌تواند
        <strong> سخت‌گیرانه‌تر </strong>
        از پیش‌فرض ناوگان باشد؛ مقدار looser هنگام خواندن به پیش‌فرض ناوگان محدود می‌شود. فیلد خالی یعنی
        «ارث‌بری از ناوگان».
      </p>

      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      {data.plans && data.plans.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {data.plans.map((entry) => (
            <Button
              key={entry.planKey}
              type="button"
              variant={entry.planKey === selected ? "primary" : "ghost"}
              onClick={() => {
                setSelected(entry.planKey);
                setDraft({});
                setNote("");
                setNotice(null);
              }}
            >
              {entry.name}
              {entry.policy ? <span className="ms-1 text-xs opacity-70">•</span> : null}
            </Button>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">هیچ طرحی در فهرست قیمت‌گذاری تعریف نشده است.</p>
      )}

      {plan && fleet ? (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {FIELDS.map((field) => (
              <Field key={field.key} label={field.label}>
                <input
                  className={inputClass}
                  inputMode="numeric"
                  placeholder="ارث‌بری از ناوگان"
                  value={value(field.key)}
                  disabled={!canWrite || busy}
                  onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
                />
                <span className="mt-1 block text-xs text-muted-foreground">{field.hint(fleet)}</span>
              </Field>
            ))}
          </div>

          <Field label="دلیل (برای ممیزی)">
            <input
              className={inputClass}
              value={note}
              disabled={!canWrite || busy}
              onChange={(event) => setNote(event.target.value)}
              placeholder="مثلاً: قرارداد با نیاز ۹۰ روزه نگهداری"
            />
          </Field>

          {canWrite ? (
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              {plan.policy ? (
                <Button type="button" variant="ghost" onClick={() => void clear()} disabled={busy}>
                  <Trash2 className="h-4 w-4" />
                  حذف سیاست و بازگشت به ناوگان
                </Button>
              ) : null}
              <Button type="button" onClick={() => void save()} disabled={busy}>
                {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : null}
                ذخیرهٔ سیاست طرح
              </Button>
            </div>
          ) : (
            <InfoBox>برای تغییر سیاست طرح‌ها دسترسی «سیاست پشتیبان کسب‌وکارها» لازم است.</InfoBox>
          )}
        </>
      ) : null}
    </Card>
  );
}
