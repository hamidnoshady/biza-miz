"use client";
import { useEffect, useRef, useState } from "react";
import { api, ErrorBox, Field, SecondaryButton } from "@/app/dashboard/ui";
import { SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { formatJalali } from "@/lib/jalali";
import { campaignStatusLabel } from "@/lib/agency-campaign";
import { readCampaignCalendarWindow } from "@/lib/agency-campaign-calendar";
import type { CampaignCalendarEvent } from "@/lib/agency-campaign-calendar-service";
import { CustomerSearchField } from "./customer-search";

/** Agenda over stored campaign windows, not over the capped metrics list. */
export function CampaignCalendar() {
  const [start, setStart] = useState(""),
    [end, setEnd] = useState("");
  const [party, setParty] = useState<{ id: string; name: string } | null>(null);
  const [events, setEvents] = useState<CampaignCalendarEvent[] | null>(null),
    [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  function clear() {
    controller.current?.abort();
    setBusy(false);
    setEvents(null);
    setNext(null);
    setError("");
  }
  async function load(offset = 0) {
    const params = new URLSearchParams({
      start,
      end,
      offset: String(offset),
      ...(party ? { partyId: party.id } : {}),
    });
    try {
      readCampaignCalendarWindow(params);
    } catch {
      setError("بازهٔ معتبر حداکثر ۹۳ روزه انتخاب کنید.");
      return;
    }
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    setError("");
    try {
      const result = await api<{
        events: CampaignCalendarEvent[];
        nextOffset: number | null;
      }>(`/api/crm/client-campaigns/calendar?${params}`, { signal: c.signal });
      if (c.signal.aborted) return;
      if (!result.ok) {
        setError("خواندن تقویم ممکن نشد؛ دسترسی خود را بررسی کنید.");
        return;
      }
      setEvents((previous) =>
        offset === 0
          ? result.data.events
          : Array.from(
              new Map(
                [...(previous ?? []), ...result.data.events].map((e) => [
                  e.id,
                  e,
                ]),
              ).values(),
            ),
      );
      setNext(result.data.nextOffset);
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  return (
    <SectionCard title="تقویم بازه‌ای کمپین‌ها">
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          نمای برنامهٔ زمانی بر پایهٔ تاریخ ثبت‌شدهٔ کمپین؛ شامل وضعیت‌های
          برنامه‌ریزی‌شده و بسته‌شده. کمپین بدون تاریخ آغاز در تقویم نیست.
          پروژه‌های متصل فقط با مجوز میز کار و دسترسی همان پروژه نمایش داده
          می‌شوند. این نما جمع هزینه یا گزارش عملکرد نیست.
        </p>
        <Field label="آغاز بازهٔ تقویم" as="div">
          <JalaliDatePicker
            ariaLabel="آغاز بازهٔ تقویم"
            value={start}
            disabled={busy}
            onChange={(v) => {
              clear();
              setStart(v);
            }}
          />
        </Field>
        <Field label="پایان بازهٔ تقویم" as="div">
          <JalaliDatePicker
            ariaLabel="پایان بازهٔ تقویم"
            value={end}
            disabled={busy}
            onChange={(v) => {
              clear();
              setEnd(v);
            }}
          />
        </Field>
        <CustomerSearchField
          selectedId={party?.id ?? null}
          selectedName={party?.name ?? ""}
          ariaLabel="کارفرمای تقویم"
          emptyText="کارفرمایی یافت نشد."
          onPick={(p) => {
            clear();
            setParty({ id: p.id, name: p.name });
          }}
          onClear={() => {
            clear();
            setParty(null);
          }}
        />
        <SecondaryButton disabled={busy} onClick={() => void load()}>
          نمایش تقویم
        </SecondaryButton>
        {error ? <ErrorBox>{error}</ErrorBox> : null}
        {busy && events === null ? <SectionCardSkeleton /> : null}
        {events?.length === 0 ? (
          <p>کمپین زمان‌بندی‌شدهٔ قابل‌دسترسی در این بازه نیست.</p>
        ) : null}
        {events?.map((e) => (
          <article key={e.id} className="rounded-xl border border-border p-3">
            <p className="font-medium">
              {e.number} — {e.title}
            </p>
            <p>
              {e.partyName} — {campaignStatusLabel(e.status)}
            </p>
            <p>
              {formatJalali(e.start)} تا{" "}
              {e.end ? formatJalali(e.end) : "پایان تعیین نشده"}
            </p>
          </article>
        ))}
        {next !== null ? (
          <SecondaryButton disabled={busy} onClick={() => void load(next)}>
            صفحهٔ بعدی تقویم
          </SecondaryButton>
        ) : null}
        {events ? (
          <p className="text-xs text-muted-foreground">
            هر صفحه حداکثر ۱۰۰ کمپین؛ بدون جمع کل. تغییر هم‌زمان برنامه ممکن است
            ترتیب صفحه‌ها را عوض کند؛ برای بازخوانی از «نمایش تقویم» استفاده
            کنید.
          </p>
        ) : null}
      </div>
    </SectionCard>
  );
}
