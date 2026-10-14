"use client";

/**
 * The record-specific halves of the Workspace entity drawer (#761 §11, §12):
 * a contract's lifecycle, approval history and files; a document's version
 * chain and preview. The drawer frame, facts and comments stay shared.
 */

import { useState } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { api, ErrorBox, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  APPROVAL_STATUS_LABELS,
  CONTRACT_LIFECYCLE_LABELS,
  type ContractLifecycleAction,
  type WorkspaceApprovalStatus,
} from "@/lib/workspace-shared";
import { DateField, workspaceError } from "./workspace-ui";

type Body = Record<string, unknown>;

interface ApprovalLine {
  id: string;
  status: WorkspaceApprovalStatus;
  requestedByName: string | null;
  approverName: string | null;
  note: string;
  createdAt: string;
}

interface DocLine {
  id: string;
  title: string;
  version: number;
  isCurrent?: boolean;
  createdAt: string;
}

/**
 * Contract: real lifecycle transitions (complete / terminate / extend / renew)
 * — offered only as the server's `capabilities.allowedActions` says — plus its
 * approval history and linked documents.
 */
export function ContractExtras({ body, onChanged }: { body: Body; onChanged: () => void }) {
  const record = body.contract as Body;
  const capabilities = (body.capabilities as { allowedActions?: ContractLifecycleAction[] }) ?? {};
  const actions = capabilities.allowedActions ?? [];
  const approvals = (body.approvals as ApprovalLine[] | undefined) ?? [];
  const documents = (body.documents as DocLine[] | undefined) ?? [];
  const [pending, setPending] = useState<ContractLifecycleAction | null>(null);
  const [endDate, setEndDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function run(action: ContractLifecycleAction) {
    setSaving(true);
    const { ok, data } = await api<{ error?: string }>(
      `/api/workspace/contracts/${String(record.id)}/lifecycle`,
      { method: "POST", body: JSON.stringify({ action, endDate: endDate || null }) },
    );
    setSaving(false);
    if (!ok) {
      setError(workspaceError(data.error));
      return;
    }
    setPending(null);
    setEndDate("");
    setError("");
    onChanged();
  }

  const needsDate = pending === "extend" || pending === "renew";

  return (
    <>
      {actions.length ? (
        <section aria-label="چرخهٔ قرارداد" className="flex flex-col gap-2 border-t border-border/80 pt-4">
          <h3 className="text-sm font-semibold">چرخهٔ قرارداد</h3>
          {error ? <ErrorBox>{error}</ErrorBox> : null}
          {pending ? (
            <div className="flex flex-col gap-2">
              {needsDate ? (
                <DateField
                  label={pending === "extend" ? "پایان جدید" : "پایان دورهٔ جدید"}
                  value={endDate}
                  onChange={setEndDate}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {pending === "terminate"
                    ? "قرارداد از امروز فسخ‌شده ثبت می‌شود."
                    : "قرارداد «انجام‌شده» ثبت می‌شود."}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <PrimaryButton
                  type="button"
                  onClick={() => void run(pending)}
                  disabled={saving || (needsDate && !endDate)}
                >
                  {saving ? "در حال ثبت…" : `ثبت ${CONTRACT_LIFECYCLE_LABELS[pending]}`}
                </PrimaryButton>
                <SecondaryButton onClick={() => setPending(null)}>انصراف</SecondaryButton>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {actions.map((action) => (
                <SecondaryButton key={action} onClick={() => setPending(action)}>
                  {CONTRACT_LIFECYCLE_LABELS[action]}
                </SecondaryButton>
              ))}
            </div>
          )}
        </section>
      ) : null}

      <section aria-label="تاریخچهٔ تأیید" className="flex flex-col gap-2 border-t border-border/80 pt-4">
        <h3 className="text-sm font-semibold">تاریخچهٔ تأیید</h3>
        {approvals.length === 0 ? (
          <p className="text-sm text-muted-foreground">درخواست تأییدی ثبت نشده است.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {approvals.map((approval) => (
              <li key={approval.id} className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{APPROVAL_STATUS_LABELS[approval.status]}</span>
                <span className="text-xs text-muted-foreground">
                  {[approval.requestedByName, approval.approverName && `تأییدکننده: ${approval.approverName}`]
                    .filter(Boolean)
                    .join(" · ")}{" "}
                  · {formatJalali(approval.createdAt)}
                </span>
                {approval.note ? <span className="w-full text-xs">{approval.note}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <DocList title="اسناد قرارداد" documents={documents} empty="سندی به این قرارداد وصل نیست." />
    </>
  );
}

/**
 * Document: the whole version chain (newest first, the current one marked)
 * and — for a member the Media Library itself lets open documents — the file.
 */
export function DocumentExtras({ body }: { body: Body }) {
  const record = body.document as Body;
  const versions = (body.versions as DocLine[] | undefined) ?? [];
  const canPreview = (body.capabilities as { canPreview?: boolean } | undefined)?.canPreview === true;
  return (
    <>
      {canPreview ? (
        <a
          href={`/api/media/${String(record.mediaAssetId)}/file`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 self-start text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          <ExternalLinkIcon className="size-4" aria-hidden />
          پیش‌نمایش / دریافت فایل
        </a>
      ) : null}
      <DocList title="نسخه‌ها" documents={versions} empty="این سند نسخهٔ دیگری ندارد." currentId={String(record.id)} />
    </>
  );
}

function DocList({
  title,
  documents,
  empty,
  currentId,
}: {
  title: string;
  documents: DocLine[];
  empty: string;
  currentId?: string;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2 border-t border-border/80 pt-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {documents.map((doc) => (
            <li key={doc.id} className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium">نسخهٔ {toPersianDigits(String(doc.version))}</span>
              <span className="min-w-0 flex-1 truncate">{doc.title}</span>
              {doc.isCurrent ? <span className="text-xs text-muted-foreground">نسخهٔ جاری</span> : null}
              {currentId && doc.id === currentId ? (
                <span className="text-xs text-muted-foreground">(همین)</span>
              ) : null}
              <span className="text-xs text-muted-foreground">{formatJalali(doc.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
