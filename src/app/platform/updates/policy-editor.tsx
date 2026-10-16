"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, Button, ErrorBox, Field, InfoBox, inputClass, selectClass } from "../ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** What the editor needs to know about the device whose policy is opened. */
export interface PolicyDevice {
  siteDeviceId: string;
  businessId: string;
  locationId: string;
  businessName: string;
  locationName: string;
  deviceName: string;
}
export interface PolicyRelease { id: string; version: string; channel: string; status: string; rolloutState: string }

type Scope = "platform" | "business" | "location" | "device";
type Tri = "inherit" | "true" | "false";
interface Layer { scope: Scope; patch: Record<string, unknown>; version: number; reason: string | null; updatedAt: string | null; locationId?: string | null; siteDeviceId?: string | null }
interface Overview { platform: Layer; layers: Layer[] }
interface Effective {
  policy: Record<string, unknown>;
  sources: Record<string, "default" | Scope>;
  policyVersion: number;
  channel: string;
  targetVersion: string | null;
  withheldReason: string | null;
}

const SCOPE_LABEL: Record<Scope | "default", string> = {
  default: "پیش‌فرض سکو", platform: "پیش‌فرض سکو (قابل‌تنظیم)", business: "کسب‌وکار", location: "شعبه", device: "دستگاه",
};
const KEY_LABEL: Record<string, string> = {
  automaticChecks: "بررسی خودکار", backgroundDownload: "دانلود پس‌زمینه", automaticInstall: "نصب خودکار",
  channel: "کانال", targetReleaseId: "انتشار هدف (کاناری)", hold: "توقف اضطراری", maintenance: "پنجرهٔ نگه‌داری",
  deferUntil: "به‌تعویق تا", deadlineAt: "مهلت نهایی", allowCriticalOverride: "رد کردن پنجره پس از مهلت",
  meteredNetworkDownload: "دانلود روی شبکهٔ محدود", minimumBatteryPercent: "حداقل شارژ باتری",
};
const WITHHELD: Record<string, string> = {
  hold: "توقف اضطراری فعال است؛ هدفی ارسال نمی‌شود.",
  pinned_release_unavailable: "انتشار انتخاب‌شده منتشر نشده یا در این کانال نیست؛ جایگزینی انجام نمی‌شود.",
  no_eligible_release: "انتشار مجازی برای این دستگاه وجود ندارد.",
};
const DAYS = ["یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه"];

function triFrom(value: unknown): Tri { return value === true ? "true" : value === false ? "false" : "inherit"; }
function fmt(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (value === true) return "بله";
  if (value === false) return "خیر";
  if (value === "safe_window") return "در پنجرهٔ ایمن";
  if (value === "off") return "خاموش";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return toPersianDigits(new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium" }).format(new Date(value)));
  }
  if (typeof value === "object") {
    const window = value as { daysOfWeek: number[]; start: string; end: string; timezone: string };
    return `${toPersianDigits(`${window.start}–${window.end}`)} (${window.timezone}) · ${window.daysOfWeek.length === 7 ? "همهٔ روزها" : window.daysOfWeek.map((day) => DAYS[day]).join("، ")}`;
  }
  return toPersianDigits(String(value));
}
/** A Jalali-picked date is an ISO calendar date; policy instants are read at Tehran midnight. */
function isoToDay(value: unknown): string { return typeof value === "string" ? new Date(Date.parse(value) + 3.5 * 3_600_000).toISOString().slice(0, 10) : ""; }
function dayToIso(day: string): string { return new Date(Date.parse(`${day}T00:00:00Z`) - 3.5 * 3_600_000).toISOString(); }

export function PolicyEditor({ device, releases, canManage, open, onOpenChange, onSaved }: {
  device: PolicyDevice | null;
  releases: PolicyRelease[];
  canManage: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [effective, setEffective] = useState<Effective | null>(null);
  const [scope, setScope] = useState<Scope>("business");
  const [form, setForm] = useState<Record<string, string>>({});
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!device) return;
    const [layers, preview] = await Promise.all([
      api<Overview>(`/api/platform/updates/policy?businessId=${device.businessId}`),
      api<Effective>(`/api/platform/updates/policy/effective?siteDeviceId=${device.siteDeviceId}`),
    ]);
    if (layers.ok) setOverview(layers.data); else setError("دریافت سیاست‌ها ممکن نشد.");
    if (preview.ok) setEffective(preview.data);
  }, [device]);
  useEffect(() => { if (open) { setError(""); void load(); } }, [open, load]);

  const layer = useMemo<Layer | null>(() => {
    if (!overview || !device) return null;
    if (scope === "platform") return overview.platform;
    return overview.layers.find((item) => item.scope === scope
      && (scope === "business" || (scope === "location" ? item.locationId === device.locationId : item.siteDeviceId === device.siteDeviceId))) ?? null;
  }, [overview, device, scope]);

  // Re-seed the form whenever the edited layer changes.
  useEffect(() => {
    const patch = layer?.patch ?? {};
    const window = patch.maintenance as { daysOfWeek: number[]; start: string; end: string } | undefined;
    setDays(window?.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6]);
    setForm({
      automaticChecks: triFrom(patch.automaticChecks), backgroundDownload: triFrom(patch.backgroundDownload),
      hold: triFrom(patch.hold), allowCriticalOverride: triFrom(patch.allowCriticalOverride),
      automaticInstall: typeof patch.automaticInstall === "string" ? patch.automaticInstall : "inherit",
      channel: "channel" in patch ? String(patch.channel ?? "device") : "inherit",
      targetReleaseId: "targetReleaseId" in patch ? String(patch.targetReleaseId ?? "none") : "inherit",
      deferUntil: "deferUntil" in patch ? isoToDay(patch.deferUntil) : "", deadlineAt: "deadlineAt" in patch ? isoToDay(patch.deadlineAt) : "",
      maintenance: window ? "set" : "inherit", start: window?.start ?? "02:00", end: window?.end ?? "05:00",
    });
    setReason("");
  }, [layer]);

  const set = (key: string, value: string) => setForm((current) => ({ ...current, [key]: value }));

  async function save() {
    if (!device) return;
    const setPatch: Record<string, unknown> = {};
    const clear: string[] = [];
    const apply = (key: string, value: unknown, inherit: boolean) => { if (inherit) clear.push(key); else setPatch[key] = value; };
    for (const key of ["automaticChecks", "backgroundDownload", "hold", "allowCriticalOverride"]) apply(key, form[key] === "true", form[key] === "inherit");
    apply("automaticInstall", form.automaticInstall, form.automaticInstall === "inherit");
    apply("channel", form.channel === "device" ? null : form.channel, form.channel === "inherit");
    apply("targetReleaseId", form.targetReleaseId === "none" ? null : form.targetReleaseId, form.targetReleaseId === "inherit");
    apply("deferUntil", form.deferUntil ? dayToIso(form.deferUntil) : null, !form.deferUntil);
    apply("deadlineAt", form.deadlineAt ? dayToIso(form.deadlineAt) : null, !form.deadlineAt);
    apply("maintenance", { timezone: "Asia/Tehran", daysOfWeek: days, start: form.start, end: form.end }, form.maintenance === "inherit");

    const risky = setPatch.automaticInstall === "safe_window" || setPatch.hold === true;
    const where = scope === "platform" ? "همهٔ کسب‌وکارها" : scope === "business" ? device.businessName : scope === "location" ? `${device.businessName} / ${device.locationName}` : `${device.deviceName}`;
    if (risky && !window.confirm(`این تغییر برای «${where}» اعمال می‌شود${setPatch.automaticInstall === "safe_window" ? " و نصب بدون دخالت کاربر را در پنجرهٔ ایمن مجاز می‌کند" : " و ارسال هر انتشار جدید را متوقف می‌کند"}. ادامه می‌دهید؟`)) return;
    setBusy(true); setError("");
    const target = { scope, businessId: device.businessId, locationId: device.locationId, siteDeviceId: device.siteDeviceId };
    const response = await api<{ error?: string }>("/api/platform/updates/policy", {
      method: "PUT",
      body: JSON.stringify({ target, set: setPatch, clear, reason, expectedVersion: layer?.version ?? 0 }),
    });
    setBusy(false);
    if (!response.ok) {
      setError(response.status === 409 ? "سیاست در این فاصله تغییر کرده است؛ دوباره بارگذاری شد." : "ذخیرهٔ سیاست انجام نشد؛ دلیل و مقادیر را بررسی کنید.");
      await load(); return;
    }
    await load(); onSaved();
  }

  if (!device) return null;
  const inheritOption = <option value="inherit">ارث‌بری از سطح بالاتر</option>;
  const tri = (key: string) => (
    <select className={selectClass} disabled={!canManage} value={form[key] ?? "inherit"} onChange={(event) => set(key, event.target.value)}>
      {inheritOption}<option value="true">بله</option><option value="false">خیر</option>
    </select>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>سیاست به‌روزرسانی {device.deviceName}</DialogTitle>
          <DialogDescription>{device.businessName} · {device.locationName}. ترتیب اولویت: سکو، کسب‌وکار، شعبه، دستگاه؛ مقدار صریح‌تر برنده است.</DialogDescription>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>

        <section aria-label="سیاست مؤثر">
          <h3 className="mb-2 text-sm font-semibold">سیاست مؤثر برای این دستگاه {effective ? <span className="font-normal text-muted-foreground">(نسخهٔ {toPersianDigits(String(effective.policyVersion))})</span> : null}</h3>
          {effective ? <>
            <dl className="grid gap-x-6 sm:grid-cols-2">
              {Object.keys(KEY_LABEL).map((key) => (
                <div key={key} className="flex items-center justify-between gap-3 border-b border-border py-1.5 text-xs">
                  <dt className="text-muted-foreground">{KEY_LABEL[key]}</dt>
                  <dd className="text-end font-medium">{key === "targetReleaseId" && effective.policy[key] ? (releases.find((release) => release.id === effective.policy[key])?.version ?? "ناشناخته") : fmt(effective.policy[key])}
                    <span className="ms-2 rounded border border-border px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">{effective.sources[key] === "default" ? "پیش‌فرض" : SCOPE_LABEL[effective.sources[key]]}</span></dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">
              هدف ارسالی: <b dir="ltr">{effective.targetVersion ?? "—"}</b>{effective.withheldReason ? ` — ${WITHHELD[effective.withheldReason] ?? effective.withheldReason}` : ""}
            </p>
          </> : <p className="text-xs text-muted-foreground">در حال بارگذاری…</p>}
        </section>

        {canManage ? (
          <section aria-label="ویرایش سیاست" className="mt-4 border-t border-border pt-4">
            <div className="mb-3 flex flex-wrap gap-2" role="tablist" aria-label="سطح سیاست">
              {(["platform", "business", "location", "device"] as Scope[]).map((item) => (
                <button key={item} type="button" role="tab" aria-selected={scope === item} onClick={() => setScope(item)}
                  className={`h-8 rounded-lg border px-3 text-xs font-medium ${scope === item ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-muted"}`}>
                  {SCOPE_LABEL[item === "platform" ? "platform" : item]}
                </button>
              ))}
            </div>
            {scope === "platform" ? <InfoBox>این سطح برای همهٔ کسب‌وکارها اعمال می‌شود.</InfoBox> : null}
            <div className="grid gap-x-4 sm:grid-cols-2">
              <Field label="بررسی خودکار">{tri("automaticChecks")}</Field>
              <Field label="دانلود پس‌زمینه">{tri("backgroundDownload")}</Field>
              <Field label="نصب خودکار" hint="پیش‌فرض خاموش است. نصب فقط در پنجرهٔ ایمن و پس از همهٔ بررسی‌های داده انجام می‌شود.">
                <select className={selectClass} value={form.automaticInstall ?? "inherit"} onChange={(event) => set("automaticInstall", event.target.value)}>
                  {inheritOption}<option value="off">خاموش</option><option value="safe_window">در پنجرهٔ ایمن</option>
                </select>
              </Field>
              <Field label="کانال">
                <select className={selectClass} value={form.channel ?? "inherit"} onChange={(event) => set("channel", event.target.value)}>
                  {inheritOption}<option value="device">طبق گزارش خود دستگاه</option><option value="stable">پایدار</option><option value="beta">آزمایشی</option><option value="internal">داخلی</option>
                </select>
              </Field>
              <Field label="انتشار هدف (کاناری)" hint="فقط انتشارهای منتشرشده؛ جایگزینی خودکار انجام نمی‌شود.">
                <select className={selectClass} value={form.targetReleaseId ?? "inherit"} onChange={(event) => set("targetReleaseId", event.target.value)}>
                  {inheritOption}<option value="none">بدون انتخاب (طبق انتشار تدریجی)</option>
                  {releases.filter((release) => release.status === "published").map((release) => (
                    <option key={release.id} value={release.id}>{release.version} · {release.channel} · {release.rolloutState}</option>
                  ))}
                </select>
              </Field>
              <Field label="توقف اضطراری" hint="هیچ هدف و نصبی برای این سطح ارسال نمی‌شود.">{tri("hold")}</Field>
              <Field label="به‌تعویق تا"><JalaliDatePicker value={form.deferUntil ?? ""} onChange={(iso) => set("deferUntil", iso)} ariaLabel="به‌تعویق تا" /></Field>
              <Field label="مهلت نهایی"><JalaliDatePicker value={form.deadlineAt ?? ""} onChange={(iso) => set("deadlineAt", iso)} ariaLabel="مهلت نهایی" /></Field>
              <Field label="رد کردن پنجره پس از مهلت" hint="هرگز بررسی‌های ایمنی (شیفت، سفارش باز، پشتیبان) را دور نمی‌زند.">{tri("allowCriticalOverride")}</Field>
              <Field label="پنجرهٔ نگه‌داری (Asia/Tehran)">
                <select className={selectClass} value={form.maintenance ?? "inherit"} onChange={(event) => set("maintenance", event.target.value)}>
                  {inheritOption}<option value="set">تعریف پنجرهٔ مخصوص این سطح</option>
                </select>
              </Field>
            </div>
            {form.maintenance === "set" ? (
              <div className="mb-4 grid gap-x-4 sm:grid-cols-2">
                <Field label="از ساعت"><input className={inputClass} dir="ltr" type="time" value={form.start ?? "02:00"} onChange={(event) => set("start", event.target.value)} /></Field>
                <Field label="تا ساعت"><input className={inputClass} dir="ltr" type="time" value={form.end ?? "05:00"} onChange={(event) => set("end", event.target.value)} /></Field>
                <fieldset className="sm:col-span-2"><legend className="mb-1 text-sm font-medium">روزها</legend>
                  <div className="flex flex-wrap gap-2">{DAYS.map((name, day) => (
                    <label key={name} className="inline-flex items-center gap-1 text-xs">
                      <input type="checkbox" checked={days.includes(day)} onChange={(event) => setDays((current) => event.target.checked ? [...current, day] : current.filter((item) => item !== day))} />{name}
                    </label>
                  ))}</div>
                </fieldset>
              </div>
            ) : null}
            <Field label="دلیل تغییر (ثبت در سابقهٔ حسابرسی)"><input className={inputClass} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} /></Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={busy || reason.trim().length < 3 || (form.maintenance === "set" && days.length === 0)} onClick={() => void save()}>{busy ? "در حال ذخیره…" : "ذخیرهٔ سیاست این سطح"}</Button>
              {layer?.updatedAt ? <span className="text-xs text-muted-foreground">آخرین تغییر: {fmt(layer.updatedAt)}{layer.reason ? ` — ${layer.reason}` : ""}</span> : <span className="text-xs text-muted-foreground">این سطح هنوز مقدار صریحی ندارد.</span>}
            </div>
          </section>
        ) : <InfoBox>فقط مدیر ارشد سکو می‌تواند سیاست به‌روزرسانی را تغییر دهد.</InfoBox>}
      </DialogContent>
    </Dialog>
  );
}
