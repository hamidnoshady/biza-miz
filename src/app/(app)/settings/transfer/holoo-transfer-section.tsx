"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  LoadingSkeleton,
  SectionCard,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import {
  ErrorBox,
  InfoBox,
  api,
  inputClass,
} from "@/app/dashboard/ui";
import { HOLOO_DATA_TRANSFER_PROFILE } from "@/lib/data-transfer/providers/holoo/profile";
import { toPersianDigits } from "@/lib/digits";
import { Count, JalaliCell } from "./data-transfer-ui";

interface HolooConnectionOption {
  id: string;
  name: string;
  status: string;
  profileKey: string | null;
  version: string | null;
  currencyUnit: "rial" | "toman" | null;
  hasSqlCredentials: boolean;
  hasWebServiceCredentials: boolean;
  companionActive: boolean;
  writeMode: string;
}

interface HolooRun {
  id: string;
  status: "running" | "completed" | "rolled_back";
  createdAt: string;
  profileKey: string | null;
  profileVersion: number | null;
  selectedScopes: string[];
  outcome: "completed" | "partial_failure";
  counts: {
    created?: { goods?: number; persons?: number; accounts?: number; openingInventory?: number };
  } | null;
  journalSummary?: { imported?: number; alreadyMapped?: number; unbalanced?: { remoteId: string; difference: string }[] } | null;
  discrepancies: {
    entities: { entityType: string; countDiff: number; balanceDiffRial: string }[];
    trialBalance: { code: string; debitDiffRial: string; creditDiffRial: string }[];
  } | null;
  rollbackState: string | null;
}

interface ProviderCatalogue {
  error?: string;
  provider: "holoo";
  profile: {
    key: string;
    version: number;
    label: string;
    scopes: { key: string; label: string; dependencies: string[]; importSupported: boolean; exportSupported: boolean }[];
  };
  availableScopes: string[];
  availableExportScopes: string[];
  canImport: boolean;
  canExport: boolean;
  canSendConnected: boolean;
  canConfigureConnections: boolean;
  connections: HolooConnectionOption[];
  runs: HolooRun[];
}

interface HolooPreview {
  profile?: { key: string; version: number };
  scopes: string[];
  counts: {
    goods: { toCreate: number; skipped: number };
    persons: { toCreate: number; skipped: number };
    accounts: { mappedToSeed: number; toCreate: number; orphaned: number; skipped: number };
    openingInventory: { toImport: number; skipped: number };
  };
  unresolvedGoodsReferences: { stockRemoteId: string; goodsRemoteId: string }[];
  journal?: {
    importable: number;
    alreadyMapped: number;
    unbalanced: { remoteId: string; difference: string }[];
    unmappedAccounts: { remoteId: string; accountCode: string }[];
    skippedEmpty: string[];
  };
  workbook?: {
    profileKey: string;
    profileVersion: number;
    recognizedSheets: { scope: string; name: string; rowCount: number; importSupported: boolean }[];
    warnings: { code: string; sheetName: string }[];
  };
}

const SCOPE_LABELS: Record<string, string> = {
  goods: "کالاها",
  persons: "اشخاص، مشتریان و تأمین‌کنندگان",
  accounts: "کدینگ حسابداری",
  openingInventory: "موجودی افتتاحیه",
  sales: "فروش‌ها",
  saleLines: "ردیف‌های فروش",
  purchases: "خریدها",
  receiptPayment: "دریافت‌ها و پرداخت‌ها",
  journal: "اسناد حسابداری",
  journalLines: "ردیف‌های سند",
};

const DISCREPANCY_LABELS: Record<string, string> = {
  goods: "کالا",
  persons: "اشخاص",
  accounts: "حساب‌ها",
  openingInventory: "موجودی افتتاحیه",
  journals: "اسناد حسابداری",
  sales: "فروش",
  purchases: "خرید",
  receipts_payments: "دریافت/پرداخت",
};

const ERROR_LABELS: Record<string, string> = {
  holoo_schema_unsupported: "ساختار این نصب هلو برای مهاجرت پشتیبانی نمی‌شود. گزارش تشخیصی فقط‌خواندنی در دسترس است.",
  holoo_profile_not_verified: "پروفایل اتصال ثبت یا تأیید نشده است. ابتدا اتصال را از بخش اتصال‌های فنی آزمایش کنید.",
  holoo_source_too_large: "حجم دادهٔ انتخاب‌شده از سقف پیش‌نمایش این مرحله بیشتر است.",
  holoo_scope_not_supported_by_profile: "پروفایل فعلی این دامنهٔ مهاجرت را پشتیبانی نمی‌کند.",
  holoo_workbook_profile_unknown: "ساختار فایل با پروفایل نسخه‌دار هلو تطبیق ندارد؛ چیزی وارد نشد.",
  xlsx_unsafe_numeric_value: "یک عدد بزرگ در سلول عددی XLSX از دقت ایمن اکسل فراتر است؛ مبلغ را به‌صورت متن دقیق ذخیره کنید.",
  holoo_workbook_has_errors: "فایل در ردیف‌های انتخاب‌شده شناسه یا مقدار الزامی ندارد.",
  scope_dependency_missing: "وابستگی دامنه انتخاب نشده است؛ برای موجودی افتتاحیه کالاها و برای سندها هر دو برگهٔ سند را انتخاب کنید.",
  holoo_journal_sheets_required: "برای ورود سند، برگه‌های Sanad و SanadRow باید هر دو انتخاب و در فایل حاضر باشند.",
  holoo_journal_line_reference_missing: "یک ردیف سند به کد سندی اشاره می‌کند که در برگهٔ Sanad وجود ندارد.",
  invalid_holoo_date: "تاریخ سند معتبر نیست؛ تاریخ میلادی را با قالب YYYY-MM-DD وارد کنید.",
  invalid_holoo_amount: "مبلغ سند معتبر نیست؛ از عدد نامنفی بدون جداکنندهٔ هزارگان استفاده کنید.",
  unsupported_scope: "یکی از دامنه‌های انتخاب‌شده در این نسخه یا منبع انتخابی پشتیبانی نمی‌شود.",
  duplicate_holoo_remote_id: "در فایل کد بیرونی تکراری پیدا شد؛ هر سند و ترکیب سند/حساب باید یکتا باشد.",
  holoo_scope_not_supported: "این دامنه برای ورود از فایل پشتیبانی نمی‌شود.",

  unresolved_references: "ارجاع‌های کالا حل‌نشده‌اند. پیش از اعمال، کدهای هلو را با فایل کالاها هماهنگ کنید.",
  preview_expired_or_changed: "پیش‌نمایش منقضی شده یا دادهٔ مبدأ تغییر کرده است؛ دوباره پیش‌نمایش بگیرید.",
  holoo_transfer_failed: "انتقال هلو انجام نشد. اتصال و پروفایل را بررسی و دوباره تلاش کنید.",
  unsupported_format: "برای پروفایل فایل هلو، فقط کتاب‌کار XLSX پشتیبانی می‌شود.",
  file_too_large: "حجم فایل بیشتر از حد مجاز است.",
  provider_export_too_large: "حجم دادهٔ خروجی از سقف نمایه بیشتر است. خروجی را در چند بخش بگیرید.",
  provider_send_partial: "همهٔ پیام‌های صف در این نوبت ارسال نشدند؛ وضعیت صف و اقدام لازم در تاریخچه ثبت شد.",
  provider_send_failed: "ارسال به هلو انجام نشد؛ تنظیمات وب‌سرویس و اتصال را بررسی کنید.",
  holoo_connection_not_configured: "تنظیمات امن اتصال هلو پیدا نشد.",
  holoo_web_service_required: "ارسال متصل این پروفایل فقط از مسیر وب‌سرویس مجاز است؛ Direct SQL غیرفعال است.",
  holoo_web_service_credentials_missing: "اطلاعات وب‌سرویس در اتصال‌های فنی کامل نیست.",
  holoo_companion_not_active: "حالت همراه هلو را ابتدا از اتصال‌های فنی فعال کنید.",
  holoo_connection_inactive: "اتصال هلو فعال نیست.",
  location_required: "برای خروجی کالاها یک شعبهٔ فعال انتخاب کنید.",
  location_scope_mismatch: "این اتصال به شعبهٔ دیگری وابسته است و در محدودهٔ شعبهٔ فعلی در دسترس نیست.",
  missing_file: "فایل کتاب‌کار هلو را انتخاب کنید.",
  forbidden: "برای یکی از دامنه‌های انتخاب‌شده دسترسی لازم را ندارید.",
  no_scopes_selected: "دست‌کم یک دامنه را انتخاب کنید.",
};

function errorLabel(code: string | undefined): string {
  if (!code) return ERROR_LABELS.holoo_transfer_failed;
  return ERROR_LABELS[code] ?? ERROR_LABELS.holoo_transfer_failed;
}

function createdCounts(run: HolooRun) {
  return run.counts?.created ?? {};
}

export function HolooTransferSection() {
  const [catalogue, setCatalogue] = useState<ProviderCatalogue | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [direction, setDirection] = useState<"import" | "export">("import");
  const [source, setSource] = useState<"connected_sql" | "xlsx">("connected_sql");
  const [file, setFile] = useState<File | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  const [preview, setPreview] = useState<HolooPreview | null>(null);
  const [previewToken, setPreviewToken] = useState("");
  const [approvedInputKey, setApprovedInputKey] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"load" | "preview" | "apply" | "rollback" | null>("load");

  const load = useCallback(async (selectedConnectionId = connectionId) => {
    setBusy((current) => current === "preview" || current === "apply" || current === "rollback" ? current : "load");
    const url = selectedConnectionId
      ? `/api/data/providers/holoo?connectionId=${encodeURIComponent(selectedConnectionId)}`
      : "/api/data/providers/holoo";
    const result = await api<ProviderCatalogue>(url);
    if (result.ok) {
      let nextCatalogue = result.data;
      const nextId = selectedConnectionId || result.data.connections[0]?.id || "";
      if (!selectedConnectionId && nextId) {
        setConnectionId(nextId);
        const detailed = await api<ProviderCatalogue>(`/api/data/providers/holoo?connectionId=${encodeURIComponent(nextId)}`);
        if (detailed.ok) nextCatalogue = detailed.data;
      }
      setCatalogue(nextCatalogue);
      setDirection((current) => !nextCatalogue.canImport && current === "import" ? "export" : current);
      if (nextId !== connectionId) setConnectionId(nextId);
      setScopes((current) => {
        const allowed = nextCatalogue.availableScopes;
        const valid = current.filter((scope) => allowed.includes(scope));
        if (valid.length) return valid;
        return allowed.includes("goods") ? ["goods"] : allowed.slice(0, 1);
      });
      setError("");
    } else {
      setError(errorLabel(result.data.error));
      setCatalogue(null);
    }
    setBusy((current) => current === "load" ? null : current);
  }, [connectionId]);

  useEffect(() => {
    void load("");
    // The initial catalogue is fetched once; selection/history refreshes are
    // explicit so changing tabs cannot discard an in-progress preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedConnection = useMemo(
    () => catalogue?.connections.find((connection) => connection.id === connectionId) ?? null,
    [catalogue, connectionId],
  );
  const availableScopeDefinitions = useMemo(
    () => (catalogue?.profile.scopes ?? []).filter((scope) =>
      catalogue?.availableScopes.includes(scope.key) &&
      (source === "xlsx" || (scope.key !== "journal" && scope.key !== "journalLines")),
    ),
    [catalogue, source],
  );
  const unsupportedScopes = useMemo(
    () => (catalogue?.profile.scopes ?? []).filter((scope) => !scope.importSupported),
    [catalogue],
  );
  const currentInputKey = JSON.stringify([
    connectionId,
    source,
    [...scopes].sort(),
    file?.name ?? "",
    file?.size ?? 0,
    file?.lastModified ?? 0,
  ]);
  const previewIsCurrent = Boolean(previewToken && approvedInputKey === currentInputKey);

  function resetPreview() {
    setPreview(null);
    setPreviewToken("");
    setApprovedInputKey("");
    setNotice("");
  }

  function toggleScope(scope: string) {
    setScopes((current) => {
      const selected = new Set(current);
      if (selected.has(scope)) {
        selected.delete(scope);
        if (scope === "goods") selected.delete("openingInventory");
        if (scope === "journal" || scope === "journalLines") {
          selected.delete("journal");
          selected.delete("journalLines");
        }
      } else {
        selected.add(scope);
        if (scope === "openingInventory") selected.add("goods");
        if (scope === "journal" || scope === "journalLines") {
          selected.add("journal");
          selected.add("journalLines");
        }
      }
      return [...selected].filter((entry) => catalogue?.availableScopes.includes(entry));
    });
    resetPreview();
  }

  function setSourceType(next: "connected_sql" | "xlsx") {
    setSource(next);
    if (next === "connected_sql") {
      setScopes((current) => current.filter((scope) => scope !== "journal" && scope !== "journalLines"));
    }
    resetPreview();
  }

  function setConnection(value: string) {
    setConnectionId(value);
    resetPreview();
    void load(value);
  }

  function setSelectedFile(next: File | null) {
    setFile(next);
    resetPreview();
  }

  async function transfer(action: "preview" | "apply") {
    if (!connectionId) {
      setError("ابتدا یک اتصال هلو را از تنظیمات اتصال‌های فنی ایجاد و آزمایش کنید.");
      return;
    }
    if (source === "xlsx" && !file) {
      setError(errorLabel("missing_file"));
      return;
    }
    if (action === "apply" && !previewIsCurrent) {
      setError(errorLabel("preview_expired_or_changed"));
      return;
    }

    setBusy(action);
    setError("");
    setNotice("");
    let result: Awaited<ReturnType<typeof api<Record<string, unknown>>>>;
    if (source === "connected_sql") {
      result = await api<Record<string, unknown>>("/api/data/providers/holoo", {
        method: "POST",
        body: JSON.stringify({
          action,
          connectionId,
          scopes,
          ...(action === "apply" ? { previewToken } : {}),
        }),
      });
    } else {
      const form = new FormData();
      form.set("file", file!);
      form.set("action", action);
      form.set("connectionId", connectionId);
      form.set("scopes", JSON.stringify(scopes));
      if (action === "apply") form.set("previewToken", previewToken);
      result = await api<Record<string, unknown>>("/api/data/providers/holoo/workbook", { method: "POST", body: form });
    }
    setBusy(null);
    if (!result.ok) {
      setError(errorLabel(typeof result.data.error === "string" ? result.data.error : undefined));
      if (result.data.error === "preview_expired_or_changed") resetPreview();
      return;
    }

    if (action === "preview") {
      const nextPreview = result.data.preview as HolooPreview;
      setPreview(nextPreview);
      setPreviewToken(typeof result.data.previewToken === "string" ? result.data.previewToken : "");
      setApprovedInputKey(currentInputKey);
      setNotice("پیش‌نمایش انجام شد؛ هیچ داده‌ای هنوز تغییر نکرده است.");
      return;
    }

    const outcome = result.data.outcome;
    const runMessage = outcome === "partial_failure"
      ? `اجرای مهاجرت ${String(result.data.runId ?? "")} بخشی از داده‌ها را ثبت کرد و متوقف شد. اجرای ثبت‌شده را از تاریخچه بررسی یا rollback کنید.`
      : `مهاجرت انجام شد. شناسهٔ اجرا: ${String(result.data.runId ?? "—")}`;
    resetPreview();
    await load(connectionId);
    if (outcome === "partial_failure") setError(runMessage);
    else setNotice(runMessage);
  }

  async function rollback(runId: string) {
    if (!connectionId || !window.confirm("فقط داده‌هایی که همین اجرای هلو ساخته است حذف شوند؟ اگر داده‌ها بعداً استفاده شده باشند، سیستم rollback را متوقف می‌کند.")) return;
    setBusy("rollback");
    setError("");
    setNotice("");
    const result = await api<Record<string, unknown>>("/api/data/providers/holoo", {
      method: "POST",
      body: JSON.stringify({ action: "rollback", connectionId, runId }),
    });
    setBusy(null);
    if (!result.ok) {
      setError(errorLabel(typeof result.data.error === "string" ? result.data.error : undefined));
      return;
    }
    await load(connectionId);
    setNotice(`اجرای ${runId} rollback شد.`);
  }

  if (busy === "load" && !catalogue) return <LoadingSkeleton rows={5} />;
  if (!catalogue) {
    return (
      <SectionCard title="انتقال داده با هلو">
        <ErrorBox>{error || "بارگذاری نمایهٔ هلو ممکن نشد."}</ErrorBox>
      </SectionCard>
    );
  }

  const runs = catalogue.runs ?? [];
  const profileReady = selectedConnection?.profileKey === HOLOO_DATA_TRANSFER_PROFILE.profileKey;
  const connectionReady = source === "connected_sql"
    ? Boolean(profileReady && selectedConnection?.status === "active" && selectedConnection.hasSqlCredentials)
    : Boolean(profileReady);
  const sourceReady = source === "connected_sql" ? connectionReady : connectionReady && Boolean(file);

  return (
    <div className="space-y-5">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <SectionCard
        title="انتقال با پروفایل هلو"
        description="رمزهای اتصال در اتصال‌های فنی می‌مانند. این بخش فقط منبع و دامنهٔ مهاجرت را انتخاب می‌کند و نوشتن را به سرویس‌های موجود هلو می‌سپارد."
      >
        <div className="flex flex-wrap gap-2">
          {catalogue.canImport ? (
            <Button type="button" variant={direction === "import" ? "default" : "outline"} onClick={() => setDirection("import")}>
              ورود به سامانه
            </Button>
          ) : null}
          {catalogue.canExport || catalogue.canSendConnected ? (
            <Button type="button" variant={direction === "export" ? "default" : "outline"} onClick={() => setDirection("export")}>
              خروجی از سامانه
            </Button>
          ) : null}
        </div>
        {direction === "import" ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant={source === "connected_sql" ? "default" : "outline"} onClick={() => setSourceType("connected_sql")}>
              اتصال SQL هلو
            </Button>
            <Button type="button" variant={source === "xlsx" ? "default" : "outline"} onClick={() => setSourceType("xlsx")}>
              فایل XLSX هلو
            </Button>
          </div>
        ) : null}

        {catalogue.connections.length === 0 ? (
          <div className="mt-4">
            <EmptyState title="هنوز اتصال هلو ندارید">
              برای نگه‌داری امن مشخصات اتصال و ساخت فضای شناسهٔ پایدار، ابتدا آن را در اتصال‌های فنی اضافه و آزمایش کنید.
              <div className="mt-3">
                <Button asChild variant="outline"><Link href="/settings/connections/holoo">رفتن به اتصال‌های فنی هلو</Link></Button>
              </div>
            </EmptyState>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <label className="block text-sm font-medium">
              {direction === "export" ? "اتصال مقصد و شناسه‌های بیرونی" : source === "xlsx" ? "اتصال هلو برای نگه‌داری شناسه‌های بیرونی" : "منبع اتصال"}
              <select
                className={inputClass}
                value={connectionId}
                onChange={(event) => setConnection(event.target.value)}
              >
                <option value="">انتخاب اتصال…</option>
                {catalogue.connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>{connection.name}</option>
                ))}
              </select>
            </label>

            {selectedConnection ? (
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <StatusBadge tone={selectedConnection.status === "active" ? "positive" : selectedConnection.status === "error" ? "danger" : "neutral"}>
                  {selectedConnection.status === "active" ? "فعال" : selectedConnection.status === "error" ? "خطا" : "متوقف"}
                </StatusBadge>
                <span>{selectedConnection.name}</span>
                <span>·</span>
                <span>پروفایل: {selectedConnection.profileKey ?? "ناشناخته"}</span>
                {selectedConnection.currencyUnit ? <span>· واحد پول: {selectedConnection.currencyUnit === "rial" ? "ریال" : "تومان"}</span> : null}
              </div>
            ) : null}

            {direction === "import" && source === "xlsx" ? (
              <>
                <label className="block text-sm font-medium">
                  فایل کتاب‌کار هلو (XLSX)
                  <input
                    className={inputClass}
                    type="file"
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                  />
                </label>
                <InfoBox>شناسه‌های بیرونی بر اساس کد هلو نگه‌داری می‌شوند. رمز SQL یا وب‌سرویس در این صفحه پرسیده یا نمایش داده نمی‌شود.</InfoBox>
              </>
            ) : null}

            {selectedConnection && !profileReady ? (
              <ErrorBox>
                ساختار اتصال هنوز با پروفایل نسخه‌دار تطبیق ندارد. برای تشخیص دوباره به <Link className="underline" href="/settings/connections/holoo">اتصال‌های فنی هلو</Link> بروید و اتصال را آزمایش کنید.
              </ErrorBox>
            ) : null}
            {selectedConnection && direction === "import" && source === "connected_sql" && profileReady && !connectionReady ? (
              <ErrorBox>اتصال SQL فعال یا اطلاعات SQL آن کامل نیست. از تنظیمات اتصال فنی وضعیت را اصلاح کنید.</ErrorBox>
            ) : null}
          </div>
        )}
      </SectionCard>

      {direction === "import" ? (
      <SectionCard title="دامنه‌های مهاجرت" description="فقط دامنه‌هایی که دسترسی لازم را دارید قابل انتخاب‌اند. موجودی افتتاحیه به کالاها وابسته است؛ سندهای حسابداری فقط از XLSX و با هر دو برگه وارد می‌شوند. برگهٔ کدینگ را برای حساب‌های تازه نیز انتخاب کنید.">
        {availableScopeDefinitions.length === 0 ? (
          <InfoBox>برای هیچ‌یک از دامنه‌های پشتیبانی‌شده مجوز انتقال ندارید.</InfoBox>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {availableScopeDefinitions.map((scope) => (
              <label key={scope.key} className="flex items-start gap-3 rounded-xl border border-border p-3 text-sm">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope.key)}
                  onChange={() => toggleScope(scope.key)}
                  disabled={!sourceReady || busy !== null}
                  className="mt-1"
                />
                <span>
                  <span className="block font-medium">{SCOPE_LABELS[scope.key] ?? scope.label}</span>
                  {scope.dependencies.length ? <span className="text-xs text-muted-foreground">وابسته به: {scope.dependencies.map((key) => SCOPE_LABELS[key] ?? key).join("، ")}</span> : null}
                </span>
              </label>
            ))}
          </div>
        )}
        {source === "connected_sql" && catalogue.availableScopes.includes("journal") ? (
          <div className="mt-4"><InfoBox>ورود سندها در این مرحله فقط از کتاب‌کار XLSX نسخه‌دار انجام می‌شود؛ اتصال SQL همچنان محدود به داده‌های پایه است.</InfoBox></div>
        ) : null}
        {unsupportedScopes.length > 0 ? (
          <div className="mt-4">
            <InfoBox>
              دامنه‌های سندیِ دیگر تا آماده‌شدن گروه‌بندی، اعتبارسنجی و rollback امن غیرفعال‌اند: {unsupportedScopes.map((scope) => SCOPE_LABELS[scope.key] ?? scope.label).join("، ")}.
            </InfoBox>
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!sourceReady || !scopes.length || busy !== null}
            onClick={() => void transfer("preview")}
          >
            {busy === "preview" ? "در حال پیش‌نمایش…" : "پیش‌نمایش بدون نوشتن"}
          </Button>
          <Button
            type="button"
            disabled={!sourceReady || !scopes.length || !previewIsCurrent || busy !== null}
            onClick={() => void transfer("apply")}
          >
            {busy === "apply" ? "در حال اعمال…" : "اعمال مهاجرت تأییدشده"}
          </Button>
        </div>
      </SectionCard>
      ) : (
        <HolooExportPanel catalogue={catalogue} connection={selectedConnection} connectionReady={Boolean(profileReady)} connectionId={connectionId} />
      )}

      {direction === "import" && preview ? (
        <SectionCard title="نتیجهٔ پیش‌نمایش" description={`پروفایل ${preview.profile?.key ?? preview.workbook?.profileKey ?? "هلو"} · دامنه‌ها: ${preview.scopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join("، ")}`}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {preview.scopes.includes("goods") ? <CountCard label="کالاهای تازه" value={preview.counts.goods.toCreate} secondary={`تکراری/نگاشت‌شده: ${preview.counts.goods.skipped}`} /> : null}
            {preview.scopes.includes("persons") ? <CountCard label="اشخاص تازه" value={preview.counts.persons.toCreate} secondary={`تکراری/نگاشت‌شده: ${preview.counts.persons.skipped}`} /> : null}
            {preview.scopes.includes("accounts") ? <CountCard label="حساب‌های تازه" value={preview.counts.accounts.toCreate} secondary={`نگاشت به کدینگ پایه: ${preview.counts.accounts.mappedToSeed} · قبلاً نگاشت‌شده: ${preview.counts.accounts.skipped} · والد حل‌نشده: ${preview.counts.accounts.orphaned}`} /> : null}
            {preview.scopes.includes("openingInventory") ? <CountCard label="ردیف‌های موجودی افتتاحیه" value={preview.counts.openingInventory.toImport} secondary={`نگاشت‌شده/غیرقابل‌اعمال: ${preview.counts.openingInventory.skipped}`} /> : null}
            {preview.scopes.includes("journal") && preview.journal ? (
              <CountCard
                label="اسناد حسابداری قابل ورود"
                value={preview.journal.importable}
                secondary={`قبلاً نگاشت‌شده: ${preview.journal.alreadyMapped} · نامتوازن: ${preview.journal.unbalanced.length} · حساب حل‌نشده: ${preview.journal.unmappedAccounts.length} · خالی: ${preview.journal.skippedEmpty.length}`}
              />
            ) : null}
          </div>
          {preview.journal?.unbalanced.length ? (
            <div className="mt-4"><ErrorBox>سندهای نامتوازن وارد نمی‌شوند و به‌طور خودکار تراز نمی‌شوند: {preview.journal.unbalanced.slice(0, 8).map((entry) => `${entry.remoteId} (${toPersianDigits(entry.difference)} ریال)`).join("، ")}</ErrorBox></div>
          ) : null}
          {preview.journal?.unmappedAccounts.length ? (
            <div className="mt-4"><ErrorBox>حساب‌های حل‌نشده مانع ورود همان سند می‌شوند: {preview.journal.unmappedAccounts.slice(0, 8).map((entry) => `${entry.remoteId}→${entry.accountCode}`).join("، ")}</ErrorBox></div>
          ) : null}
          {preview.unresolvedGoodsReferences.length ? (
            <div className="mt-4">
              <ErrorBox>
                {preview.unresolvedGoodsReferences.length} ارجاع کالای حل‌نشده. شناسه‌ها: {preview.unresolvedGoodsReferences.slice(0, 10).map((row) => `${row.stockRemoteId}→${row.goodsRemoteId}`).join("، ")}
              </ErrorBox>
            </div>
          ) : null}
          {preview.workbook?.warnings.length ? (
            <div className="mt-4"><InfoBox>برگه‌های ناشناخته نادیده گرفته شدند: {preview.workbook.warnings.map((warning) => warning.sheetName).join("، ")}</InfoBox></div>
          ) : null}
        </SectionCard>
      ) : null}

      {direction === "import" ? (
      <SectionCard title="تاریخچهٔ مهاجرت‌های هلو" description="تاریخچه شامل نمایه، دامنه‌ها، شمارش‌ها و وضعیت rollback است؛ تاریخ‌ها با تقویم شمسی نمایش داده می‌شوند.">
        {busy === "load" && !runs.length ? (
          <LoadingSkeleton rows={3} compact label="در حال بارگذاری تاریخچه" />
        ) : runs.length === 0 ? (
          <EmptyState title="اجرای هلو ثبت نشده است">پس از اعمال یک مهاجرت، شناسهٔ اجرا و نتیجه اینجا دیده می‌شود.</EmptyState>
        ) : (
          <DataTable caption="تاریخچهٔ اجراهای مهاجرت هلو">
            <DataTableHead>
              <tr><Th>تاریخ</Th><Th>پروفایل</Th><Th>دامنه‌ها</Th><Th>وضعیت</Th><Th>ساخته‌شده</Th><Th> </Th></tr>
            </DataTableHead>
            <DataTableBody>
              {runs.map((run) => {
                const counts = createdCounts(run);
                return (
                  <DataTableRow key={run.id}>
                    <Td><JalaliCell value={run.createdAt} /></Td>
                    <Td>{run.profileKey ?? "—"}{run.profileVersion ? ` · v${run.profileVersion}` : ""}</Td>
                    <Td>{run.selectedScopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join("، ")}</Td>
                    <Td><StatusBadge tone={run.status === "rolled_back" ? "neutral" : run.outcome === "partial_failure" ? "danger" : run.status === "completed" ? "positive" : "active"}>{run.status === "rolled_back" ? "برگشت‌خورده" : run.outcome === "partial_failure" ? "ناتمام؛ قابل بازبینی" : run.status === "completed" ? "انجام‌شده" : "در حال اجرا"}</StatusBadge></Td>
                    <Td>
                      <span>
                        کالا {counts.goods ?? 0} · اشخاص {counts.persons ?? 0} · حساب {counts.accounts ?? 0} · موجودی {counts.openingInventory ?? 0}
                        {run.selectedScopes.includes("journal") ? ` · سند ${run.journalSummary?.imported ?? 0}` : ""}
                      </span>
                      {run.journalSummary?.unbalanced?.length ? <span className="mt-1 block text-xs text-destructive">سند نامتوازن واردنشده: {run.journalSummary.unbalanced.length}</span> : null}
                      <DiscrepancySummary report={run.discrepancies} />
                    </Td>
                    <Td>
                      {run.status === "completed" && run.rollbackState === "available" ? (
                        <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void rollback(run.id)}>
                          {busy === "rollback" ? "در حال rollback…" : "Rollback"}
                        </Button>
                      ) : <span className="text-muted-foreground">—</span>}
                    </Td>
                  </DataTableRow>
                );
              })}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>
      ) : (
        <SectionCard title="تاریخچهٔ خروجی‌های هلو" description="خروجی فایل و ارسال‌های متصل در تاریخچهٔ عمومی Data Transfer نیز ثبت می‌شوند.">
          <InfoBox>برای دانلود دوبارهٔ workbook یا بررسی تعداد اسناد ارسال‌شده، زبانهٔ «تاریخچه» در همین صفحه را باز کنید.</InfoBox>
        </SectionCard>
      )}
    </div>
  );
}

function DiscrepancySummary({
  report,
}: {
  report: HolooRun["discrepancies"];
}) {
  if (!report) return <span className="mt-1 block text-xs text-muted-foreground">گزارش مغایرت در دسترس نیست.</span>;
  const differenceCount = report.entities.length + report.trialBalance.length;
  if (differenceCount === 0) {
    return <span className="mt-1 block text-xs text-muted-foreground">مغایرت شمارشی یا تراز ثبت‌شده‌ای نیست.</span>;
  }
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-destructive">مغایرت‌های گزارش: {toPersianDigits(differenceCount)}</summary>
      <ul className="mt-1 list-inside list-disc space-y-1 text-muted-foreground">
        {report.entities.map((entry) => (
          <li key={`entity-${entry.entityType}`}>
            {DISCREPANCY_LABELS[entry.entityType] ?? entry.entityType} · اختلاف تعداد (سامانه منهای هلو): {toPersianDigits(entry.countDiff)}
            {entry.balanceDiffRial !== "0" ? ` · اختلاف مانده: ${toPersianDigits(entry.balanceDiffRial)} ریال` : ""}
          </li>
        ))}
        {report.trialBalance.map((entry) => (
          <li key={`account-${entry.code}`}>
            حساب {entry.code} · اختلاف بدهکار: {toPersianDigits(entry.debitDiffRial)} · اختلاف بستانکار: {toPersianDigits(entry.creditDiffRial)} ریال
          </li>
        ))}
      </ul>
    </details>
  );
}

function CountCard({ label, value, secondary }: { label: string; value: number; secondary: string }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="mt-1 text-xl font-semibold tabular-nums"><Count value={value} /></div>
      <span className="mt-1 block text-xs text-muted-foreground">{secondary}</span>
    </div>
  );
}

function HolooExportPanel({
  catalogue,
  connection,
  connectionReady,
  connectionId,
}: {
  catalogue: ProviderCatalogue;
  connection: HolooConnectionOption | null;
  connectionReady: boolean;
  connectionId: string;
}) {
  const [scopes, setScopes] = useState<string[]>([]);
  const [busy, setBusy] = useState<"file" | "send" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const scopeDefinitions = useMemo(
    () => catalogue.profile.scopes.filter((scope) => scope.exportSupported && catalogue.availableExportScopes.includes(scope.key)),
    [catalogue.profile.scopes, catalogue.availableExportScopes],
  );
  const exportScopeKeys = useMemo(() => scopeDefinitions.map((scope) => scope.key), [scopeDefinitions]);

  useEffect(() => {
    setScopes((current) => {
      const valid = current.filter((scope) => exportScopeKeys.includes(scope));
      if (current.length > 0 && valid.length === current.length) return current;
      return valid.length ? valid : exportScopeKeys;
    });
  }, [exportScopeKeys]);

  function toggleScope(scope: string) {
    setScopes((current) => current.includes(scope) ? current.filter((entry) => entry !== scope) : [...current, scope]);
    setError("");
    setNotice("");
  }

  async function exportFile() {
    if (!connectionId || !connectionReady || !scopes.length) return;
    setBusy("file");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/data/providers/holoo/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, scopes }),
      });
      if (!response.ok) {
        let code: string | undefined;
        try {
          const body = await response.json() as { error?: unknown };
          code = typeof body.error === "string" ? body.error : undefined;
        } catch {
          code = undefined;
        }
        setError(errorLabel(code));
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
      anchor.download = encoded ? decodeURIComponent(encoded) : plain ?? "holoo-workbook.xlsx";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      const warnings = Number(response.headers.get("X-Provider-Warnings") ?? 0);
      const jobId = response.headers.get("X-Export-Job") ?? "—";
      const downloadable = response.headers.get("X-Export-Downloadable") === "true";
      setNotice(`فایل پروفایل هلو ساخته شد و ${downloadable ? "در تاریخچه نگه‌داری می‌شود" : "به‌علت حجم، فقط همین بار دانلود شد"}. شناسهٔ خروجی: ${jobId}.${warnings ? ` ${warnings} شخص دو‌نقشی در قالب تک‌نقشی هلو قابل نمایش نبود و حذف شد.` : ""}`);
    } catch {
      setError(errorLabel("network_error"));
    } finally {
      setBusy(null);
    }
  }

  async function sendConnected() {
    if (!connectionId || !connectionReady || !window.confirm("اسناد موجود و در صف خروجی این اتصال از مسیر وب‌سرویس هلو ارسال شوند؟ این کار سند جدید نمی‌سازد و فقط outbox فعلی را تخلیه می‌کند.")) return;
    setBusy("send");
    setError("");
    setNotice("");
    const result = await api<Record<string, unknown>>("/api/data/providers/holoo/send", {
      method: "POST",
      body: JSON.stringify({ connectionId }),
    });
    setBusy(null);
    if (!result.ok) {
      setError(errorLabel(typeof result.data.error === "string" ? result.data.error : undefined));
      return;
    }
    const sent = Number(result.data.sent ?? 0);
    const attempted = Number(result.data.attempted ?? 0);
    const remaining = Number(result.data.remainingDue ?? 0);
    const scheduled = Number(result.data.retryScheduled ?? 0);
    const inFlight = Number(result.data.inFlight ?? 0);
    const deadLettered = Number(result.data.deadLettered ?? 0);
    if (result.data.outcome === "partial_failure") {
      setError(`${errorLabel("provider_send_partial")} ارسال موفق: ${sent} از ${attempted}؛ آمادهٔ تلاش دوباره: ${remaining}؛ تلاش بعدی زمان‌بندی‌شده: ${scheduled}؛ در حال پردازش: ${inFlight}؛ مردود نهایی: ${deadLettered}. شناسهٔ کار: ${String(result.data.jobId ?? "—")}`);
    } else {
      setNotice(attempted === 0
        ? `پیام آماده‌ای در صف خروجی نبود. شناسهٔ کار ثبت‌شده: ${String(result.data.jobId ?? "—")}`
        : `${sent} سند از outbox هلو ارسال شد. شناسهٔ کار: ${String(result.data.jobId ?? "—")}`);
    }
  }

  const webServiceReady = Boolean(
    catalogue.canSendConnected && connection?.status === "active" && connection.writeMode === "web_service" &&
    connection.hasWebServiceCredentials && connection.companionActive && connectionReady,
  );

  return (
    <SectionCard
      title="خروجی به هلو"
      description={`پروفایل ${catalogue.profile.key} v${catalogue.profile.version} · workbook با نام، ترتیب، نوع و واحد پول دقیق پروفایل صادر می‌شود.`}
    >
      {error ? <div className="mb-3"><ErrorBox>{error}</ErrorBox></div> : null}
      {notice ? <div className="mb-3"><InfoBox>{notice}</InfoBox></div> : null}
      {!catalogue.canExport ? (
        <InfoBox>مجوز عمومی data.export برای ساخت فایل هلو لازم است.</InfoBox>
      ) : scopeDefinitions.length === 0 ? (
        <InfoBox>برای خروجی هیچ‌یک از دامنه‌های پشتیبانی‌شده مجوز ندارید.</InfoBox>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {scopeDefinitions.map((scope) => (
            <label key={scope.key} className="flex items-start gap-3 rounded-xl border border-border p-3 text-sm">
              <input type="checkbox" className="mt-1" checked={scopes.includes(scope.key)} disabled={!connectionReady || busy !== null} onChange={() => toggleScope(scope.key)} />
              <span className="font-medium">{SCOPE_LABELS[scope.key] ?? scope.label}</span>
            </label>
          ))}
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={!catalogue.canExport || !connectionReady || !scopes.length || busy !== null} onClick={() => void exportFile()}>
          {busy === "file" ? "در حال ساخت workbook…" : "دانلود فایل سازگار با هلو"}
        </Button>
        <Button type="button" disabled={!webServiceReady || busy !== null} onClick={() => void sendConnected()}>
          {busy === "send" ? "در حال تخلیهٔ outbox…" : "ارسال اسناد آماده با وب‌سرویس"}
        </Button>
      </div>
      <div className="mt-4 space-y-3">
        {connection?.writeMode === "direct_sql" ? (
          <InfoBox>این پروفایل Direct SQL را مجاز نمی‌کند. ارسال متصل فقط با Web Service و ریل‌های push موجود انجام می‌شود.</InfoBox>
        ) : null}
        {connection && connection.writeMode === "web_service" && !webServiceReady ? (
          <InfoBox>برای ارسال متصل، وب‌سرویس و حالت همراه را در اتصال‌های فنی پیکربندی و فعال کنید؛ دسترسی مدیریتی اتصال نیز لازم است.</InfoBox>
        ) : null}
        {!connectionReady ? (
          <InfoBox>برای ساخت فایل profile-specific، اتصال مقصد باید با همین پروفایل نسخه‌دار آزمایش شده باشد.</InfoBox>
        ) : null}
        <p className="text-xs leading-5 text-muted-foreground">ارسال متصل، سند تازه نمی‌سازد: فقط اسناد موجود در outbox را از طریق سرویس push فعلی می‌فرستد. Direct SQL در این نسخه قفل است.</p>
      </div>
    </SectionCard>
  );
}
