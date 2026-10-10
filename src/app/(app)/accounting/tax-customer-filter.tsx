"use client";

import { useEffect, useState } from "react";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, inputClass } from "@/app/dashboard/ui";

/** Uses the tax-view door, including historically submitted buyers, not a wider party permission. */
export function TaxCustomerFilter({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api<{ customers?: { id: string; name: string }[] }>("/api/ledger/tax-invoices?limit=1").then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.ok) setCustomers(res.data.customers ?? []);
      else setFailed(true);
    });
    return () => { cancelled = true; };
  }, []);
  if (loading) return <LoadingSkeleton rows={1} label="بارگذاری مشتریان" />;
  return (
    <div>
      <label className="block">
        <span className="mb-1 block text-xs text-muted-foreground">مشتری</span>
        <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">همهٔ مشتریان</option>
          {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
        </select>
      </label>
      {failed ? <ErrorBox>فهرست مشتریان بارگذاری نشد.</ErrorBox> : null}
    </div>
  );
}
