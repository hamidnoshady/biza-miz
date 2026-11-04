"use client";

/**
 * Issue #908 — the contract detail screen: the document builder and the
 * signing round, in one place, because they are two halves of the same act.
 *
 * The shell owns three things and nothing else:
 *
 *  - the two reads (`/document` and `/signing`), fetched in parallel so the
 *    page paints once rather than twice;
 *  - the tab state, kept in the URL (`?tab=signing`) so a reload, a shared link
 *    and the browser's back button all land on the same panel — the same URL
 *    discipline issue #907 asks of every workspace surface;
 *  - refreshing both reads after a write, so the document's validation banner
 *    and the signer list can never disagree about whether the contract is
 *    sendable.
 */
import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  LoadingSkeleton,
  SectionCard,
  StatusBadge,
  TabBar,
  TabPanel,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox } from "@/app/dashboard/ui";
import {
  CONTRACT_EDIT_ERROR_MESSAGES,
  ENVELOPE_STATUS_LABELS,
  UNKNOWN_CONTRACT_ERROR,
} from "@/lib/contracts/labels";
import type { ContractDocumentVersionSummary, ContractDocumentView, ContractSigningOverview } from "@/lib/contracts/view";
import type { ContractSignatureSlot } from "@/lib/contracts/blocks";
import { toPersianDigits } from "@/lib/digits";
import { ContractDocumentEditor } from "./document-editor";
import { SigningPanel } from "./signing-panel";

export interface SigningResponse {
  contract: { id: string; title: string; status: string };
  overview: ContractSigningOverview;
  slots: ContractSignatureSlot[];
  versions: ContractDocumentVersionSummary[];
  expiresInDaysMax: number;
  capabilities: { canManage: boolean };
}

export function contractError(code: string | undefined): string {
  if (!code) return UNKNOWN_CONTRACT_ERROR;
  return CONTRACT_EDIT_ERROR_MESSAGES[code] ?? UNKNOWN_CONTRACT_ERROR;
}

const TABS = [
  { key: "document" as const, label: "سند" },
  { key: "signing" as const, label: "امضا و ارسال" },
];

type TabKey = (typeof TABS)[number]["key"];

export function ContractWorkspace({ contractId }: { contractId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const initialTab: TabKey = params.get("tab") === "signing" ? "signing" : "document";
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [view, setView] = useState<ContractDocumentView | null>(null);
  const [signing, setSigning] = useState<SigningResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [documentResult, signingResult] = await Promise.all([
      api<ContractDocumentView & { error?: string }>(`/api/workspace/contracts/${contractId}/document`),
      api<SigningResponse & { error?: string }>(`/api/workspace/contracts/${contractId}/signing`),
    ]);
    if (!documentResult.ok) {
      setError(contractError(documentResult.data?.error));
      setLoading(false);
      return;
    }
    if (!signingResult.ok) {
      setError(contractError(signingResult.data?.error));
      setLoading(false);
      return;
    }
    setError("");
    setView(documentResult.data);
    setSigning(signingResult.data);
    setLoading(false);
  }, [contractId]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeTab = (next: TabKey) => {
    setTab(next);
    const search = new URLSearchParams(params.toString());
    if (next === "document") search.delete("tab");
    else search.set("tab", next);
    const query = search.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  if (loading) return <LoadingSkeleton rows={6} />;

  if (error || !view || !signing) {
    return (
      <SectionCard title="قرارداد">
        <ErrorBox>{error || UNKNOWN_CONTRACT_ERROR}</ErrorBox>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            void load();
          }}
          className="text-sm font-medium text-primary hover:underline"
        >
          تلاش دوباره
        </button>
      </SectionCard>
    );
  }

  const contract = view.contract;
  const envelope = signing.overview.envelope;
  const progress = signing.overview.progress;
  const issues = view.issues.length;

  return (
    <div className="space-y-5">
      <KpiRow>
        <KpiCard
          label="قرارداد"
          value={contract.title}
          hint={contract.projectName ? `پروژه: ${contract.projectName}` : "قرارداد چارچوبی (بدون پروژه)"}
        />
        <KpiCard
          label="نسخهٔ سند"
          value={
            view.versions[0]
              ? `v${toPersianDigits(view.versions[0].version)}`
              : "بدون نسخهٔ ثابت"
          }
          hint={view.versions[0] ? "آخرین نسخهٔ ثابت‌شده" : "پیش از ارسال، نسخه‌ای ثابت می‌شود"}
        />
        <KpiCard
          label="وضعیت امضا"
          value={
            envelope
              ? ENVELOPE_STATUS_LABELS[envelope.status]
              : signing.slots.length > 0
                ? "آمادهٔ تنظیم امضاکننده"
                : "بدون جای امضا"
          }
          hint={
            signing.overview.signers.length > 0
              ? `${toPersianDigits(progress.signed)} از ${toPersianDigits(progress.required)} امضای لازم`
              : "امضاکننده‌ای ثبت نشده است"
          }
        />
        <KpiCard
          label="ایرادهای سند"
          value={issues === 0 ? "بدون ایراد" : `${toPersianDigits(issues)} مورد`}
          hint={issues === 0 ? "سند آمادهٔ ثابت‌شدن است" : "تا رفع این موارد ارسال ممکن نیست"}
        />
      </KpiRow>

      <TabBar idPrefix="contract-tabs" label="بخش‌های قرارداد" tabs={TABS} active={tab} onChange={changeTab} />

      <TabPanel idPrefix="contract-tabs" active={tab}>
        {tab === "document" ? (
          <ContractDocumentEditor
            view={view}
            canEdit={signing.capabilities.canManage && view.capabilities?.canEdit !== false}
            onSaved={load}
            onGoToSigning={() => changeTab("signing")}
          />
        ) : signing.overview.envelope === null && signing.slots.length === 0 ? (
          <SectionCard title="امضا و ارسال">
            <EmptyState title="در سند جای امضا ندارد">
              برای ارسال، دست‌کم یک بلوک «جای امضا» به سند اضافه کنید.
            </EmptyState>
          </SectionCard>
        ) : (
          <SigningPanel data={signing} onChanged={load} />
        )}
      </TabPanel>
    </div>
  );
}

/** Shared with the signing panel: one badge per envelope state. */
export function EnvelopeBadge({ status }: { status: keyof typeof ENVELOPE_STATUS_LABELS }) {
  const tone: "positive" | "danger" | "active" | "neutral" =
    status === "completed"
      ? "positive"
      : status === "declined" || status === "cancelled" || status === "expired"
        ? "danger"
        : status === "sent" || status === "partially_signed"
          ? "active"
          : "neutral";
  return <StatusBadge tone={tone}>{ENVELOPE_STATUS_LABELS[status]}</StatusBadge>;
}
