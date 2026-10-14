"use client";

import { SetupDataSkeleton } from "../ui";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { AccountType, TemplateAccount } from "@/lib/coa-template";
import { toPersianDigits } from "@/lib/digits";
import {
  api,
  ErrorBox,
  errorMessage,
  InfoBox,
  inputClass,
  PrimaryButton,
  SecondaryButton,
  StepShell,
} from "../ui";
import { nextPath, stepsFor } from "../steps";
import { useSetupIndustry } from "../industry-context";
import { INDUSTRY_LABELS } from "@/lib/industries";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";

const TYPE_LABELS: Record<AccountType, string> = {
  asset: "دارایی",
  liability: "بدهی",
  equity: "حقوق صاحبان سرمایه",
  revenue: "درآمد",
  expense: "هزینه",
};

interface AccountsResponse {
  template: TemplateAccount[];
  existing: { code: string; name: string; type: AccountType; parent_code: string | null }[];
  error?: string;
}

export default function AccountsStep() {
  const router = useRouter();
  const industry = useSetupIndustry();
  const steps = stepsFor(industry);
  const [rows, setRows] = useState<TemplateAccount[]>([]);
  const [existingCount, setExistingCount] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api<AccountsResponse>("/api/setup/accounts").then(({ data }) => {
      if (data.existing?.length) {
        setExistingCount(data.existing.length);
        setRows(
          data.existing.map((a) => ({
            code: a.code,
            name: a.name,
            type: a.type,
            parentCode: a.parent_code ?? undefined,
          })),
        );
      } else if (data.template) {
        setRows(data.template);
      }
    }).finally(() => setLoaded(true));
  }, []);

  function update(i: number, patch: Partial<TemplateAccount>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((rs) => [...rs, { code: "", name: "", type: "expense" }]);
  }

  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, j) => j !== i));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { ok, data, status } = await api<{ error?: string; messages?: string[] }>("/api/setup/accounts", {
        method: "POST",
        body: JSON.stringify({ accounts: rows }),
      });
      if (!ok) {
        setError(errorMessage(data.error, data.messages, status));
        return;
      }
      router.push(nextPath("accounts", steps));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <SetupDataSkeleton rows={4} />;

  return (
    <StepShell
      step="accounts"
      description={`سرفصل پیشنهادی مخصوص «${INDUSTRY_LABELS[industry]}» آماده است؛ می‌توانید همین را ثبت کنید یا سطرها را ویرایش کنید.`}
    >
      {existingCount > 0 ? (
        <InfoBox>
          {toPersianDigits(existingCount)} حساب از قبل ثبت شده است. ثبت دوباره، سرفصل فعلی را
          جایگزین می‌کند (تا وقتی سندی صادر نشده باشد).
        </InfoBox>
      ) : null}
      <form onSubmit={submit}>
        <ErrorBox>{error}</ErrorBox>
        <DataTable caption="سرفصل حساب‌هایی که ثبت می‌شوند" tableClassName="min-w-[560px]">
          <DataTableHead>
            <Th>کد</Th>
            <Th>نام حساب</Th>
            <Th>نوع</Th>
            <Th>والد</Th>
            <Th className="w-10" aria-label="حذف" />
          </DataTableHead>
          <DataTableBody>
            {rows.map((r, i) => (
              <DataTableRow key={i}>
                <Td className="py-1.5">
                  <input
                    className={`${inputClass} w-20`}
                    dir="ltr"
                    value={r.code}
                    onChange={(e) => update(i, { code: e.target.value })}
                  />
                </Td>
                <Td className="py-1.5">
                  <input
                    className={inputClass}
                    value={r.name}
                    onChange={(e) => update(i, { name: e.target.value })}
                  />
                </Td>
                <Td className="py-1.5">
                  <SearchableSelect
                    className={inputClass}
                    value={r.type}
                    onChange={(value) => update(i, { type: value as AccountType })}
                    ariaLabel="نوع حساب"
                    options={Object.entries(TYPE_LABELS).map(([v, label]) => ({ value: v, label }))}
                  />
                </Td>
                <Td className="py-1.5">
                  <input
                    className={`${inputClass} w-20`}
                    dir="ltr"
                    value={r.parentCode ?? ""}
                    onChange={(e) => update(i, { parentCode: e.target.value || undefined })}
                    placeholder="—"
                  />
                </Td>
                <Td className="py-1.5 text-center">
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    className="text-muted-foreground hover:text-destructive"
                    title="حذف"
                  >
                    ✕
                  </button>
                </Td>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
        <div className="mt-4 flex items-center gap-3">
          <PrimaryButton disabled={busy || rows.length === 0}>
            ثبت {toPersianDigits(rows.length)} حساب و ادامه
          </PrimaryButton>
          <SecondaryButton onClick={addRow}>افزودن حساب</SecondaryButton>
        </div>
      </form>
    </StepShell>
  );
}
