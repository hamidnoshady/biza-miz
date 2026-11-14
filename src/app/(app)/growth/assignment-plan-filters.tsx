"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { ErrorBox, Field, inputClass } from "@/app/dashboard/ui";
import { ASSIGNMENT_STATUSES, ASSIGNMENT_STATUS_LABELS, parseAssignmentPlanFilter, type AssignmentPlanFilter, type AssignmentStatus } from "@/lib/marketing-operations";

/** Filter deadlines, not visit dates; filters are applied together on request. */
export function AssignmentPlanFilters({ disabled, onApply }: { disabled: boolean; onApply: (filter: AssignmentPlanFilter) => void }) {
  const [status, setStatus] = useState<AssignmentStatus | "">("");
  const [dueFrom, setDueFrom] = useState(""); const [dueTo, setDueTo] = useState("");
  const [sort, setSort] = useState<"newest" | "due_asc">("newest"); const [error, setError] = useState("");
  function apply(e: React.FormEvent) {
    e.preventDefault();
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (dueFrom) p.set("dueFrom", dueFrom);
    if (dueTo) p.set("dueTo", dueTo);
    p.set("sort", sort);
    const filter = parseAssignmentPlanFilter(p);
    if (!filter) { setError("بازهٔ مهلت معتبر نیست؛ تاریخ آغاز نباید پس از پایان باشد."); return; }
    setError(""); onApply(filter);
  }
  function clear() {
    setStatus(""); setDueFrom(""); setDueTo(""); setSort("newest"); setError("");
    onApply({ status: null, dueFrom: null, dueTo: null, sort: "newest" });
  }
  return <form onSubmit={apply} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
    {error ? <ErrorBox>{error}</ErrorBox> : null}
    <Field label="وضعیت ماموریت"><select className={inputClass} disabled={disabled} value={status} onChange={(e) => setStatus(e.target.value as AssignmentStatus | "")}><option value="">همه وضعیت‌ها</option>{ASSIGNMENT_STATUSES.map((value) => <option key={value} value={value}>{ASSIGNMENT_STATUS_LABELS[value]}</option>)}</select></Field>
    <Field label="مهلت از" as="div"><JalaliDatePicker ariaLabel="مهلت از" value={dueFrom} onChange={setDueFrom} disabled={disabled} /></Field>
    <Field label="مهلت تا" as="div"><JalaliDatePicker ariaLabel="مهلت تا" value={dueTo} onChange={setDueTo} disabled={disabled} /></Field>
    <Field label="ترتیب ماموریت‌ها"><select className={inputClass} disabled={disabled} value={sort} onChange={(e) => setSort(e.target.value as "newest" | "due_asc")}><option value="newest">جدیدترین ثبت</option><option value="due_asc">نزدیک‌ترین مهلت</option></select></Field>
    <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-4">
      <Button type="submit" variant="outline" disabled={disabled}>اعمال فیلتر ماموریت‌ها</Button>
      <Button type="button" variant="outline" disabled={disabled} onClick={clear}>پاک کردن فیلتر ماموریت‌ها</Button>
    </div>
  </form>;
}
