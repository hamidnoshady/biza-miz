"use client";

/**
 * Issue #1041 §E.4 — one business's services, inside its commercial page.
 *
 * The console's per-business view of the activation layer: what is enabled,
 * whether setup was already paid (and when), what the runtime clock last
 * settled, when the retention countdown ends, whether a destruction is queued,
 * running, blocked by a hold or partial — plus the audited controls an operator
 * legitimately needs:
 *
 *   - **hold / release** — legal or operational hold. A hold blocks a purge and
 *     never looks like a customer disable;
 *   - **retry / cancel purge** — the destruction queue's manual lanes;
 *   - **retention override** — pin a window for this business only, without
 *     touching the platform policy every other tenant inherits.
 *
 * It is deliberately *not* a way to enable a service on a customer's behalf:
 * enabling spends the customer's wallet and is the customer's own consent flow.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toPersianDigits } from "@/lib/digits";
import { tomanLabel } from "@/lib/platform-money";
import {
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  InfoBox,
  api,
  fmtDate,
  inputClass,
  selectClass,
  useCan,
} from "../../../ui";

interface Activation {
  id: string;
  businessId: string;
  kind: string;
  key: string;
  label: string;
  state: string;
  setupPaid: boolean;
  setupPaidAt: string | null;
  setupAmountRial: number | null;
  activatedAt: string | null;
  disabledAt: string | null;
  retentionDeadline: string | null;
  purgeState: string;
  suspensionReason: string | null;
  lastSettledAt: string | null;
}

interface OverrideRow {
  kind: string;
  key: string;
  autoPurgeEnabled: boolean;
  retentionDays: number | null;
  policyVersion: number;
}

interface QueueRow {
  id: string;
  activationId: string;
  kind: string;
  key: string;
  scheduledAt: string;
  state: string;
  attempts: number;
  lastError: string | null;
}

interface Payload {
  activations: Activation[];
  overrides: OverrideRow[];
  queue: QueueRow[];
  journal: Array<{ id: string; dryRun: boolean; status: string; startedAt: string; detail: string | null }>;
  error?: string;
}

const STATE_LABELS: Record<string, string> = {
  draft: "پیش‌نویس",
  setup_in_progress: "راه‌اندازی در جریان",
  payment_reserved: "اعتبار رزرو شد",
  provisioned: "آماده‌سازی‌شده",
  active: "فعال",
  disabled_retained: "غیرفعال — داده نگهداری می‌شود",
  eligible_for_purge: "آمادهٔ نابودی",
  purging: "در حال نابودی",
  data_purged: "داده نابود شد",
  suspended_insufficient_credit: "متوقف — کمبود اعتبار",
  platform_unavailable: "پلتفرم در دسترس نیست",
  legal_hold: "نگهداری قانونی",
  purge_failed: "نابودی ناموفق",
};

const QUEUE_LABELS: Record<string, string> = {
  scheduled: "زمان‌بندی‌شده",
  running: "در حال اجرا",
  cancelled: "لغو‌شده",
  completed: "کامل",
  partial: "ناقص (بخشی محافظت‌شده)",
  failed: "ناموفق",
  blocked: "متوقف (نگهداری)",
};

function identityOf(row: { kind: string; key: string }): string {
  return `${row.kind}:${row.key}`;
}

export function BusinessServicesPanel({ businessId }: { businessId: string }) {
  const canSettle = useCan()("billing.manage");
  const canRetention = useCan()("retention.manage");
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [autoPurge, setAutoPurge] = useState(false);
  const [days, setDays] = useState("30");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const res = await api<Payload>(`/api/platform/businesses/${encodeURIComponent(businessId)}/services`);
    if (res.ok) setData(res.data);
    else setError(res.data.error ?? "بارگذاری سرویس‌های کسب‌وکار ممکن نشد.");
  }, [businessId]);

  useEffect(() => {
    void load();
  }, [load]);

  const activations = data?.activations ?? [];
  const queue = data?.queue ?? [];

  async function patch(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setError("");
    setInfo("");
    const res = await api<{ error?: string }>(
      `/api/platform/businesses/${encodeURIComponent(businessId)}/services`,
      { method: "PATCH", body: JSON.stringify(body) },
    );
    setBusy(null);
    if (!res.ok) {
      setError(
        res.data.error === "forbidden"
          ? "این عملیات به دسترسی مالک پلتفرم («نگهداری داده») نیاز دارد."
          : res.data.error ?? "انجام عملیات ممکن نشد.",
      );
      return;
    }
    setInfo("عملیات انجام و در تاریخچهٔ حسابرسی ثبت شد.");
    await load();
  }

  async function saveOverride(ev: FormEvent) {
    ev.preventDefault();
    if (!selected) return;
    const [kind, ...rest] = selected.split(":");
    const key = rest.join(":");
    await patch(
      {
        action: "retention-override",
        kind,
        key,
        autoPurgeEnabled: autoPurge,
        retentionDays: autoPurge ? Number(days) : null,
        note: note.trim() || null,
      },
      "override",
    );
  }

  return (
    <Card title="سرویس‌های فعال‌شده و نگهداری داده (بخش #1041)">
      <ErrorBox>{error}</ErrorBox>
      {info && <InfoBox>{info}</InfoBox>}

      {!data ? (
        <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
      ) : activations.length === 0 ? (
        <EmptyState title="این کسب‌وکار هنوز سرویسی فعال نکرده است" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="text-muted-foreground">
                <th className="py-2 text-right font-medium">سرویس</th>
                <th className="py-2 text-right font-medium">وضعیت</th>
                <th className="py-2 text-right font-medium">راه‌اندازی</th>
                <th className="py-2 text-right font-medium">آخرین تسویه</th>
                <th className="py-2 text-right font-medium">مهلت نگهداری</th>
                <th className="py-2 text-right font-medium">صف نابودی</th>
                <th className="py-2 text-left font-medium">عملیات</th>
              </tr>
            </thead>
            <tbody>
              {activations.map((activation) => {
                const queued = queue.find((row) => row.activationId === activation.id);
                return (
                  <tr key={activation.id} className="border-t border-border align-top">
                    <td className="py-2">
                      <p className="text-foreground">{activation.label || activation.key}</p>
                      <p className="font-mono text-xs text-muted-foreground" dir="ltr">
                        {identityOf(activation)}
                      </p>
                    </td>
                    <td className="py-2 text-foreground">
                      {STATE_LABELS[activation.state] ?? activation.state}
                      {activation.suspensionReason === "insufficient_credit" && (
                        <p className="text-xs text-muted-foreground">بدون مهلت حذف (توقف سیستمی)</p>
                      )}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {activation.setupPaid
                        ? `${tomanLabel(activation.setupAmountRial ?? 0)} · ${fmtDate(activation.setupPaidAt)}`
                        : "پرداخت نشده"}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">{fmtDate(activation.lastSettledAt)}</td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {fmtDate(activation.retentionDeadline)}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {queued
                        ? `${QUEUE_LABELS[queued.state] ?? queued.state} · ${fmtDate(queued.scheduledAt)}${
                            queued.attempts > 0 ? ` · تلاش ${toPersianDigits(queued.attempts)}` : ""
                          }`
                        : activation.purgeState !== "none"
                          ? activation.purgeState
                          : "—"}
                    </td>
                    <td className="py-2 text-left">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {canSettle && activation.state === "active" && (
                          <Button
                            variant="ghost"
                            disabled={busy !== null}
                            onClick={() =>
                              void patch(
                                { action: "settle", kind: activation.kind, key: activation.key },
                                `settle-${activation.id}`,
                              )
                            }
                          >
                            تسویهٔ مصرف
                          </Button>
                        )}
                        {canRetention && (
                          <>
                            {activation.state === "legal_hold" ? (
                              <Button
                                variant="ghost"
                                disabled={busy !== null}
                                onClick={() =>
                                  void patch(
                                    { action: "release", kind: activation.kind, key: activation.key },
                                    `release-${activation.id}`,
                                  )
                                }
                              >
                                رفع نگهداری
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                disabled={busy !== null}
                                onClick={() =>
                                  void patch(
                                    { action: "hold", kind: activation.kind, key: activation.key },
                                    `hold-${activation.id}`,
                                  )
                                }
                              >
                                نگهداری قانونی
                              </Button>
                            )}
                            {queued && ["blocked", "failed", "partial", "cancelled"].includes(queued.state) && (
                              <Button
                                variant="ghost"
                                disabled={busy !== null}
                                onClick={() =>
                                  void patch(
                                    { action: "retry-purge", activationId: activation.id },
                                    `retry-${activation.id}`,
                                  )
                                }
                              >
                                تلاش دوبارهٔ نابودی
                              </Button>
                            )}
                            {queued && ["scheduled", "failed", "blocked", "partial"].includes(queued.state) && (
                              <Button
                                variant="ghost"
                                disabled={busy !== null}
                                onClick={() =>
                                  void patch(
                                    { action: "cancel-purge", activationId: activation.id },
                                    `cancel-${activation.id}`,
                                  )
                                }
                              >
                                لغو نابودی
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canRetention && activations.length > 0 && (
        <form onSubmit={saveOverride} className="mt-4 space-y-3 border-t border-border pt-4">
          <p className="text-xs leading-6 text-muted-foreground">
            سیاست اختصاصی این کسب‌وکار، فقط برای سرویس انتخابی. بازهٔ اعلان و فرصت خروجی از سیاست پلتفرم می‌آید و قابل کوتاه‌کردن
            نیست. خالی‌کردن تیک، داده را برای همیشه نگه می‌دارد.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="سرویس">
              <select className={selectClass} value={selected} onChange={(ev) => setSelected(ev.target.value)}>
                <option value="">— انتخاب —</option>
                {activations.map((activation) => (
                  <option key={activation.id} value={identityOf(activation)}>
                    {activation.label || activation.key} ({identityOf(activation)})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="بازهٔ نگهداری">
              <select
                className={selectClass}
                value={days}
                onChange={(ev) => setDays(ev.target.value)}
                disabled={!autoPurge}
              >
                {[7, 30, 90, 365].map((preset) => (
                  <option key={preset} value={String(preset)}>
                    {toPersianDigits(preset)} روز
                  </option>
                ))}
              </select>
            </Field>
            <Field label="یادداشت">
              <input
                className={inputClass}
                value={note}
                onChange={(ev) => setNote(ev.target.value)}
                maxLength={200}
                placeholder="دلیل بازهٔ اختصاصی"
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={autoPurge}
              onChange={(ev) => setAutoPurge(ev.target.checked)}
              className="size-4"
            />
            حذف خودکار داده پس از غیرفعال‌سازی، برای این کسب‌وکار
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy !== null || !selected}>
              ذخیرهٔ سیاست اختصاصی
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy !== null || !selected}
              onClick={() =>
                void patch(
                  {
                    action: "clear-retention-override",
                    kind: selected.split(":")[0],
                    key: selected.split(":").slice(1).join(":"),
                  },
                  "clear-override",
                )
              }
            >
              بازگشت به سیاست پلتفرم
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void patch({ action: "dry-run" }, "dry-run")}
            >
              پیش‌نمایش نابودی (بدون حذف)
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
