"use client";

import { useEffect, useState } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { api, ErrorBox } from "@/app/dashboard/ui";

type Supplier = { id: string; displayName: string };

/** Uses the canonical parties directory with its own parties.view authority. */
export function SupplierPartyPicker({ value, name, onPick }: {
  value: string; name: string; onPick: (id: string, name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true); setFailed(false);
      try {
        const result = await api<{ parties?: Supplier[] }>(`/api/parties?role=Supplier&q=${encodeURIComponent(query)}&limit=20`, { signal: controller.signal });
        if (controller.signal.aborted || result.aborted) return;
        if (!result.ok || !Array.isArray(result.data.parties)) { setFailed(true); setSuppliers([]); return; }
        setSuppliers(result.data.parties);
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);
  const options = [{ value: "", label: "بدون پیوند به شخص" },
    ...(value && !suppliers.some(p => p.id === value) ? [{ value, label: name }] : []),
    ...suppliers.map(p => ({ value: p.id, label: p.displayName }))];
  return <div className="space-y-2">
    <SearchableSelect value={value} options={options} loading={loading} onQueryChange={setQuery}
      ariaLabel="انتخاب تأمین‌کننده از اشخاص" placeholder="تأمین‌کنندهٔ ثبت‌شده (اختیاری)"
      onChange={id => onPick(id, suppliers.find(p => p.id === id)?.displayName ?? (id === value ? name : ""))} />
    <div className="min-h-8">
      {loading ? <LoadingSkeleton rows={1} compact label="جست‌وجوی تأمین‌کنندگان" /> : null}
    </div>
    {failed ? <ErrorBox>جست‌وجوی تأمین‌کنندگان ممکن نشد؛ مجوز مشاهدهٔ اشخاص و اتصال را بررسی کنید. پیوندی خودکار ساخته نمی‌شود.</ErrorBox> : null}
  </div>;
}
