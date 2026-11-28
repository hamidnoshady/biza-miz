"use client";

/**
 * GH #1567 F2 — «موجودی افتتاحیه»: review and post opening-stock drafts.
 *
 * The product form, the Holoo opening sheet and external catalogue imports no
 * longer put stock on the shelf; they propose a draft. Here a manager reviews
 * every line (SKU, quantity, unit cost, value and anything blocking it), fixes
 * a missing cost, and posts — stock and Dr inventory / Cr opening equity in one
 * transaction, bound to the exact draft on screen (the review fingerprint).
 * A posted document is final; it is corrected forward with a stock count.
 */
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "../page-chrome";
import { api, ErrorBox, InfoBox, inputClass } from "../ui";

interface DocumentSummary {
  id: string;
  status: "draft" | "posted" | "cancelled";
  cutoverDate: string;
  source: "manual" | "product_form" | "import";
  note: string | null;
  createdAt: string;
  totalValue: string | null;
  lineCount: number;
}

interface PreviewLine {
  itemId: string;
  itemName: string | null;
  sku: string | null;
  quantity: string;
  unitCost: string;
  lineValue: string;
  issues: string[];
}

interface Preview {
  document: DocumentSummary;
  lines: PreviewLine[];
  totalQuantity: string;
  totalValue: string;
  inventoryAccountCode: string;
  equityAccountCode: string;
  fingerprint: string;
  postable: boolean;
}

const STATUS_LABELS: Record<DocumentSummary["status"], string> = {
  draft: "پیش‌نویس",
  posted: "ثبت‌شده",
  cancelled: "لغوشده",
};

const SOURCE_LABELS: Record<DocumentSummary["source"], string> = {
  manual: "دستی",
  product_form: "فرم محصول",
  import: "ورود اطلاعات",
};

/** Every refusal code the service returns, in the operator's words. */
export const OPENING_STOCK_MESSAGES: Record<string, string> = {
  item_not_found: "کالا یافت نشد.",
  wrong_branch: "کالا متعلق به این شعبه نیست.",
  not_sellable: "خانوادهٔ کالا موجودی ندارد؛ موجودی هر تنوع جداگانه ثبت می‌شود.",
  tracking_unsupported: "کالای سریالی، وزنی یا بچ‌دار از مسیر ورود اختصاصی خودش افتتاح می‌شود.",
  item_has_stock: "این کالا از قبل موجودی دارد؛ اصلاح آن با انبارگردانی انجام می‌شود.",
  already_opened: "موجودی افتتاحیهٔ این کالا قبلاً ثبت شده است.",
  unit_cost_required: "بهای واحد را وارد کنید.",
  review_stale: "سند پس از بازبینی تغییر کرده است؛ دوباره بازبینی کنید.",
  lines_not_postable: "برخی ردیف‌ها قابل ثبت نیستند.",
  document_not_draft: "فقط پیش‌نویس قابل تغییر یا ثبت است.",
  cutover_in_future: "تاریخ افتتاحیه نمی‌تواند در آینده باشد.",
  account_missing: "حساب موجودی کالا یا تراز افتتاحیه در سرفصل حساب‌ها نیست.",
  forbidden: "برای ثبت، دسترسی تأیید اسناد حسابداری لازم است.",
};

function message(code: string | undefined): string {
  return (code && OPENING_STOCK_MESSAGES[code]) || "عملیات انجام نشد؛ دوباره تلاش کنید.";
}

export function OpeningStockSection() {
  const money = useMoney();
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [costs, setCosts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);

  const loadDocuments = useCallback(() => {
    api<{ documents: DocumentSummary[]; error?: string }>("/api/inventory/opening-stock").then(({ ok, data }) => {
      if (ok) setDocuments(data.documents);
      else {
        setDocuments([]);
        setError(message(data.error));
      }
    });
  }, []);
  useEffect(loadDocuments, [loadDocuments]);

  const loadPreview = useCallback((id: string) => {
    setPreview(null);
    setCosts({});
    api<Preview & { error?: string }>(`/api/inventory/opening-stock/${id}`).then(({ ok, data }) => {
      if (ok) setPreview(data);
      else setError(message(data.error));
    });
  }, []);
  useEffect(() => {
    if (selected) loadPreview(selected);
  }, [selected, loadPreview]);

  async function saveCosts() {
    if (!preview) return;
    const lines = preview.lines
      .filter((line) => costs[line.itemId] !== undefined && costs[line.itemId] !== "")
      .map((line) => ({ itemId: line.itemId, quantity: line.quantity, unitCost: String(money.parse(costs[line.itemId])) }));
    if (lines.length === 0) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>(`/api/inventory/opening-stock/${preview.document.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines }),
    });
    setBusy(false);
    if (!ok) return setError(message(data.error));
    loadPreview(preview.document.id);
  }

  async function removeLine(itemId: string) {
    if (!preview) return;
    setBusy(true);
    const { ok, data } = await api<{ error?: string }>(`/api/inventory/opening-stock/${preview.document.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ removeItemIds: [itemId] }),
    });
    setBusy(false);
    if (!ok) return setError(message(data.error));
    loadPreview(preview.document.id);
  }

  async function post() {
    if (!preview) return;
    const total = money.formatText(preview.totalValue, { withUnit: true });
    if (!window.confirm(`موجودی افتتاحیه به ارزش ${total} ثبت شود؟ این سند پس از ثبت قابل ویرایش نیست.`)) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string; totalValue?: string }>(
      `/api/inventory/opening-stock/${preview.document.id}/post`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, fingerprint: preview.fingerprint }),
      },
    );
    setBusy(false);
    if (!ok) {
      setError(message(data.error));
      loadPreview(preview.document.id);
      return;
    }
    setDone(`موجودی افتتاحیه ثبت شد: ${total}.`);
    loadDocuments();
    loadPreview(preview.document.id);
  }

  async function cancel() {
    if (!preview || !window.confirm("این پیش‌نویس لغو شود؟")) return;
    setBusy(true);
    const { ok, data } = await api<{ error?: string }>(`/api/inventory/opening-stock/${preview.document.id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) return setError(message(data.error));
    loadDocuments();
    loadPreview(preview.document.id);
  }

  return (
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {done ? <InfoBox>{done}</InfoBox> : null}
      <SectionCard
        title="موجودی افتتاحیه"
        description="موجودی اولیهٔ کالاها پیش از ورود به انبار و دفاتر اینجا بازبینی و ثبت می‌شود."
        actions={
          <Button type="button" variant="outline" size="sm" onClick={loadDocuments}>
            <RefreshCwIcon aria-hidden="true" className="size-4" />
            به‌روزرسانی
          </Button>
        }
      >
        {documents === null ? (
          <LoadingSkeleton />
        ) : documents.length === 0 ? (
          <EmptyState title="سندی نیست">موجودی اولیهٔ فرم محصول یا فایل‌های ورودی اینجا به‌صورت پیش‌نویس می‌آید.</EmptyState>
        ) : (
          <DataTable caption="اسناد موجودی افتتاحیه">
            <DataTableHead>
              <tr>
                <Th>تاریخ افتتاحیه</Th>
                <Th>منبع</Th>
                <Th>ردیف</Th>
                <Th>ارزش</Th>
                <Th>وضعیت</Th>
              </tr>
            </DataTableHead>
            <DataTableBody>
              {documents.map((doc) => (
                <DataTableRow key={doc.id} onClick={() => setSelected(doc.id)} aria-selected={doc.id === selected}>
                  <Td nowrap className="tabular-nums">{formatJalali(doc.cutoverDate)}</Td>
                  <Td>{SOURCE_LABELS[doc.source]}</Td>
                  <Td numeric>{toPersianDigits(String(doc.lineCount))}</Td>
                  <Td numeric nowrap>{doc.totalValue ? money.formatText(doc.totalValue) : "—"}</Td>
                  <Td>
                    <StatusBadge tone={doc.status === "posted" ? "positive" : doc.status === "draft" ? "active" : "neutral"}>
                      {STATUS_LABELS[doc.status]}
                    </StatusBadge>
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>

      {selected && preview ? (
        <SectionCard
          title={`بازبینی سند — ${STATUS_LABELS[preview.document.status]}`}
          description={`بدهکار حساب ${toPersianDigits(preview.inventoryAccountCode)} (موجودی کالا) / بستانکار ${toPersianDigits(preview.equityAccountCode)} (تراز افتتاحیه) — تاریخ ${formatJalali(preview.document.cutoverDate)}`}
        >
          <DataTable caption="ردیف‌های سند موجودی افتتاحیه">
            <DataTableHead>
              <tr>
                <Th>کالا</Th>
                <Th>مقدار</Th>
                <Th>بهای واحد</Th>
                <Th>ارزش</Th>
                <Th>وضعیت</Th>
                {preview.document.status === "draft" ? <Th>عملیات</Th> : null}
              </tr>
            </DataTableHead>
            <DataTableBody>
              {preview.lines.map((line) => (
                <DataTableRow key={line.itemId}>
                  <Td>
                    {line.itemName ?? "—"}
                    {line.sku ? <span className="block text-xs text-muted-foreground">{line.sku}</span> : null}
                  </Td>
                  <Td numeric>{formatQuantity(line.quantity)}</Td>
                  <Td numeric>
                    {preview.document.status === "draft" ? (
                      <PersianNumberInput
                        className={inputClass}
                        aria-label={`بهای واحد ${line.itemName ?? ""}`}
                        value={costs[line.itemId] ?? ""}
                        placeholder={money.formatText(line.unitCost)}
                        onChange={(event) => setCosts((prev) => ({ ...prev, [line.itemId]: event.target.value }))}
                        allowNegative={false}
                      />
                    ) : (
                      money.formatText(line.unitCost)
                    )}
                  </Td>
                  <Td numeric nowrap>{money.formatText(line.lineValue)}</Td>
                  <Td>
                    {line.issues.length === 0 ? (
                      <StatusBadge tone="positive">آماده</StatusBadge>
                    ) : (
                      <ul className="space-y-1 text-xs text-destructive">
                        {line.issues.map((issue) => (
                          <li key={issue}>{message(issue)}</li>
                        ))}
                      </ul>
                    )}
                  </Td>
                  {preview.document.status === "draft" ? (
                    <Td>
                      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => removeLine(line.itemId)}>
                        حذف ردیف
                      </Button>
                    </Td>
                  ) : null}
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
          <p className="mt-3 text-sm">
            جمع: {formatQuantity(preview.totalQuantity)} واحد — {money.formatText(preview.totalValue, { withUnit: true })}
          </p>
          {preview.document.status === "draft" ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={busy || Object.keys(costs).length === 0} onClick={saveCosts}>
                ذخیرهٔ بهای واحد
              </Button>
              <Button type="button" disabled={busy || !preview.postable} onClick={post}>
                ثبت موجودی افتتاحیه
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={cancel}>
                لغو پیش‌نویس
              </Button>
            </div>
          ) : null}
        </SectionCard>
      ) : null}
    </div>
  );
}
