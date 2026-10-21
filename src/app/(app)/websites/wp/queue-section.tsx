"use client";

/**
 * The operational queue: outbound outbox jobs (stock/price pushes, product/
 * order operations, export requests) plus inbound events that failed or
 * succeeded. One screen for «چرا سفارش/مشتری/محصول نیامد؟» — complete with
 * status filtering, payload inspector, single and batch retries, outbox flush,
 * and responsive diagnostic tools.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  RefreshCwIcon,
  ArrowUpRightIcon,
  ArrowDownLeftIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  ClockIcon,
  LayersIcon,
  SearchIcon,
  CopyIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  RotateCcwIcon,
  ExternalLinkIcon,
  SendIcon,
  XIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { api } from "@/app/dashboard/ui";
import { cardClass, EmptyState, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { ConnectionPicker } from "./connection-lite";
import { PluginWaitNote } from "./plugin-wait-note";
import { useWpStore } from "./wp-store-context";
import type { WpQueueRow, WpQueueRowDetail, WpQueueSummary } from "@/lib/integrations/wp-manager-service";

export const KIND_LABELS: Record<string, { label: string; desc: string; link?: string }> = {
  stock: { label: "به‌روزرسانی موجودی انبار", desc: "ارسال تعداد موجودی کالا به فروشگاه", link: "/websites/wp/products" },
  price: { label: "به‌روزرسانی قیمت کالا", desc: "ارسال قیمت ریالی/تومانی به فروشگاه", link: "/websites/wp/products" },
  product_update: { label: "ویرایش و تغییر محصول", desc: "تغییر عنوان، قیمت، موجودی یا وضعیت محصول", link: "/websites/wp/products" },
  order_status: { label: "تغییر وضعیت سفارش", desc: "به‌روزرسانی وضعیت پردازش یا تکمیل سفارش در فروشگاه", link: "/websites/wp/orders" },
  refund_create: { label: "ثبت برگشت وجه (مرجوعی)", desc: "ثبت مبلغ مرجوعی برای سفارش", link: "/websites/wp/orders" },
  catalogue_export: { label: "درخواست خروجی کل کاتالوگ", desc: "دستور به افزونه برای ارسال همه محصولات به سیستم", link: "/websites/wp/products" },
  customer_export: { label: "درخواست خروجی مشتریان", desc: "دستور به افزونه برای ارسال فهرست مشتریان", link: "/websites/wp/customers" },
  orders_export: { label: "درخواست خروجی سفارش‌ها", desc: "دستور به افزونه برای ارسال سفارش‌های گذشته", link: "/websites/wp/orders" },
  content_export: { label: "درخواست خروجی محتوا", desc: "دستور به افزونه برای ارسال نوشته‌ها، برگه‌ها و رسانه‌ها", link: "/websites/wp/content" },
  taxonomy_export: { label: "درخواست خروجی دسته‌بندی‌ها", desc: "دستور به افزونه برای ارسال درخت دسته‌ها، برچسب‌ها و ویژگی‌ها", link: "/websites/wp/taxonomies" },
  post_upsert: { label: "ایجاد یا ویرایش نوشته/برگه", desc: "ذخیره تغییرات متنی در وردپرس", link: "/websites/wp/content" },
  media_create: { label: "افزودن فایل رسانه‌ای", desc: "آپلود یا ثبت فایل در کتابخانه رسانه", link: "/websites/wp/media" },
  holoo_sale: { label: "ارسال فاکتور فروش به هلو", desc: "ثبت سند فاکتور در نرم‌افزار هلو" },
  holoo_receipt: { label: "ارسال دریافت وجه به هلو", desc: "ثبت سند مالی دریافت در نرم‌زار هلو" },
  holoo_purchase: { label: "ارسال خرید به هلو", desc: "ثبت فاکتور خرید در نرم‌افزار هلو" },
  "order.created": { label: "رویداد: ثبت سفارش تازه", desc: "دریافت سفارش ثبت‌شده از فروشگاه آنلاین", link: "/websites/wp/orders" },
  "order.updated": { label: "رویداد: ویرایش سفارش", desc: "به‌روزرسانی وضعیت یا اطلاعات سفارش", link: "/websites/wp/orders" },
  "order.restored": { label: "رویداد: بازیابی سفارش", desc: "بازیابی سفارش از زباله‌دان فروشگاه", link: "/websites/wp/orders" },
  "refund.created": { label: "رویداد: ثبت مرجوعی وجه", desc: "دریافت برگشت وجه انجام‌شده در فروشگاه", link: "/websites/wp/orders" },
  "product.created": { label: "رویداد: ایجاد محصول تازه", desc: "دریافت محصول جدید تعریف‌شده در فروشگاه", link: "/websites/wp/products" },
  "product.updated": { label: "رویداد: ویرایش محصول", desc: "دریافت تغییرات مشخصات محصول از فروشگاه", link: "/websites/wp/products" },
  "customer.created": { label: "رویداد: مشتری تازه", desc: "دریافت مشخصات مشتری ثبت‌نام‌شده", link: "/websites/wp/customers" },
  "customer.updated": { label: "رویداد: ویرایش مشتری", desc: "به‌روزرسانی اطلاعات حساب کاربری مشتری", link: "/websites/wp/customers" },
  "content.created": { label: "رویداد: ایجاد محتوای تازه", desc: "دریافت نوشته یا برگه جدید از وردپرس", link: "/websites/wp/content" },
  "content.updated": { label: "رویداد: ویرایش محتوا", desc: "دریافت تغییرات نوشته یا برگه از وردپرس", link: "/websites/wp/content" },
  "content.deleted": { label: "رویداد: حذف دائمی محتوا", desc: "حذف نوشته، برگه یا رسانه از آینهٔ محلی", link: "/websites/wp/content" },
  "catalogue.taxonomy_terms": { label: "رویداد: آینهٔ دسته‌بندی‌ها", desc: "دریافت فهرست واژه‌های یک طبقه‌بندی از فروشگاه", link: "/websites/wp/taxonomies" },
};

export const STATUS_CONFIG: Record<string, { label: string; tone: "positive" | "active" | "danger" | "neutral"; desc: string }> = {
  pending: { label: "در انتظار ارسال", tone: "neutral", desc: "آماده برای ارسال به فروشگاه در نوبت بعدی" },
  deferred: { label: "متوقف تا خروج از مکث", tone: "neutral", desc: "در حالت مکث دریافت و ذخیره شده و پس از فعال‌سازی پردازش می‌شود" },
  processing: { label: "در حال پردازش", tone: "active", desc: "در حال حاضر در فرآیند ارسال یا اعمال توسط افزونه" },
  failed: { label: "ناموفق (تلاش مجدد)", tone: "danger", desc: "تلاش با خطا روبرو شد؛ در نوبت بعدی مجدداً ارسال می‌شود" },
  dead: { label: "متوقف‌شده", tone: "danger", desc: "پس از حداکثر تلاش‌ها متوقف شد؛ نیاز به بررسی و تلاش مجدد دستی دارد" },
  // Issue #942 (F15): the outcome of a non-idempotent write could not be
  // proven; only an operator who checked the store may resolve it.
  needs_review: { label: "نیازمند بررسی دستی", tone: "danger", desc: "نتیجهٔ عملیات در فروشگاه قطعی نیست؛ پس از بررسی در فروشگاه، یکی از گزینه‌های تصمیم‌گیری را انتخاب کنید" },
  // Issue #942 (F10): the plugin's local policy switch was off, so nothing
  // was written — visible, and never counted as delivered.
  skipped: { label: "اعمال‌نشده (تنظیم افزونه)", tone: "neutral", desc: "افزونه به‌دلیل خاموش بودن اعمال موجودی/قیمت در تنظیماتش این کار را انجام نداد؛ فروشگاه مقدار قبلی را دارد" },
  sent: { label: "ارسال‌شده", tone: "positive", desc: "با موفقیت به فروشگاه آنلاین ارسال شد" },
  processed: { label: "ثبت‌شده", tone: "positive", desc: "رویداد ورودی با موفقیت دریافت و در سیستم ثبت گردید" },
  duplicate: { label: "تکراری (صرف‌نظر)", tone: "neutral", desc: "رویداد قبلاً پردازش شده و شناسه تحویل تکراری بوده است" },
};

type StatusFilter = "all" | "open" | "failed" | "pending" | "processing" | "needs_review" | "deferred" | "sent";
type DirectionFilter = "all" | "out" | "in";

export function describePersianError(raw: string | null): string {
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("econnrefused") || lower.includes("fetch failed")) {
    return "خطای شبکه و عدم پاسخ‌گویی سرور فروشگاه وردپرس (Timeout / Connection Refused).";
  }
  if (lower.includes("404") || lower.includes("not found")) {
    return "منبع موردنظر (محصول، سفارش یا نوشته) در وردپرس یافت نشد (404 Not Found). ممکن است در سایت حذف شده باشد.";
  }
  if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized") || lower.includes("forbidden")) {
    return "خطای عدم دسترسی یا کلیدهای امنیتی نامعتبر (401 / 403). اتصال فروشگاه را بررسی فرمایید.";
  }
  if (lower.includes("500") || lower.includes("internal server error")) {
    return "خطای داخلی سرور وردپرس (500 Internal Server Error). ممکن است یکی از افزونه‌های سایت تداخل داشته باشد.";
  }
  if (lower.includes("replayed_nonce")) {
    return "درخواست تکراری تشخیص داده شد؛ جهت حفظ امنیت تراکنش لغو شد.";
  }
  if (lower.includes("terms_not_array")) {
    return "رویداد دسته‌بندی، فهرست معتبری از واژه‌ها نداشت؛ برای جلوگیری از پاک‌شدن آینهٔ محلی، رویداد بدون تغییر داده رد شد. نسخهٔ افزونه را به‌روز کنید و «همگام‌سازی با فروشگاه» را دوباره بزنید.";
  }
  if (lower.includes("taxonomy_missing")) {
    return "رویداد دسته‌بندی، نام طبقه‌بندی (taxonomy) نداشت و قابل پردازش نیست.";
  }
  if (lower.includes("bad_chunk_index") || lower.includes("bad_chunk_count") || lower.includes("bad_snapshot_id")) {
    return "بخش‌های (چانک) رویداد دسته‌بندی ناقص یا نامرتب بودند؛ آینهٔ محلی دست‌نخورده مانده است.";
  }
  if (lower.includes("bad_id")) {
    return "شناسهٔ یکی از واژه‌های ارسالی از فروشگاه نامعتبر بود؛ رویداد جهت بررسی نگه داشته شد و داده‌ای پاک نشد.";
  }
  if (lower.includes("malformed_taxonomy_snapshot")) {
    return "رویداد دسته‌بندی نامعتبر بود و بدون تغییر داده رد شد؛ آینهٔ محلی دست‌نخورده مانده است.";
  }
  if (lower.includes("taxonomy_sync_partial")) {
    return "همگام‌سازی دسته‌بندی‌ها ناقص بود؛ برخی درخت‌ها از فروشگاه خوانده نشدند. داده‌های خوانده‌شده امن هستند — «همگام‌سازی با فروشگاه» را در صفحهٔ دسته‌بندی‌ها دوباره امتحان کنید.";
  }
  if (lower.includes("wordpress_credentials_missing")) {
    return "برای خواندن دسته‌بندی‌های سفارشی، اعتبارنامهٔ وردپرس (Application Password) روی این اتصال ثبت نشده است.";
  }
  if (lower.includes("parent")) {
    return "شناسه محصول والد یا تنوع در ساختار ووکامرس نامعتبر است.";
  }
  return raw;
}

export function WpQueueSection() {
  const { connections, selectedId, setSelectedId, canSync } = useWpStore();
  const [rows, setRows] = useState<WpQueueRow[] | null>(null);
  const [summary, setSummary] = useState<WpQueueSummary | null>(null);
  // Filtered totals from the server (issue #942, F17) — pagination and the
  // "how many match" line read these, never rows.length guesses.
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  // The attempt cap in force for this connection's mode (F16).
  const [maxAttempts, setMaxAttempts] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  // Debounced twin of searchQuery: the API hears about a search once the
  // operator pauses typing, not on every keystroke (issue #942, F18).
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);

  // UI state
  const [loading, setLoading] = useState(false);
  const [busyRowId, setBusyRowId] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState<"retry_all" | "flush" | null>(null);
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  // Lazily fetched, redacted per-row diagnostics (issue #942, F13) — the
  // list itself carries no payload bodies anymore.
  const [details, setDetails] = useState<Record<string, WpQueueRowDetail | "loading" | "error">>({});
  // F11 verify assist: per-row remote-verification verdicts for
  // needs_review rows (landed / not_landed / unknown + explanation).
  const [verifyResults, setVerifyResults] = useState<
    Record<string, { verdict: "landed" | "not_landed" | "unknown"; detail: string } | "error">
  >({});
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [bannerMessage, setBannerMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 350);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // In-flight list request, cancelled when a newer one starts so a slow
  // earlier response can never overwrite fresher rows (issue #942, F18).
  const loadAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (connectionId: string, status = statusFilter, direction = directionFilter, search = debouncedSearch, nextPage = page) => {
      if (!connectionId) return;
      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;
      setLoading(true);
      const params = new URLSearchParams({ connectionId, page: String(nextPage), pageSize: String(pageSize) });
      if (status !== "all") params.set("status", status);
      if (direction !== "all") params.set("direction", direction);
      if (search.trim()) params.set("search", search.trim());

      const res = await api<{
        rows: WpQueueRow[];
        summary?: WpQueueSummary;
        page?: number;
        total?: number;
        totalPages?: number;
        maxAttempts?: number;
        error?: string;
      }>(`/api/integrations/wp-manager/queue?${params.toString()}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setLoading(false);
      if (res.ok) {
        setLoadError(null);
        setRows(res.data.rows);
        setPage(typeof res.data.page === "number" ? res.data.page : nextPage);
        setTotal(typeof res.data.total === "number" ? res.data.total : res.data.rows.length);
        setTotalPages(typeof res.data.totalPages === "number" ? res.data.totalPages : 1);
        if (typeof res.data.maxAttempts === "number") setMaxAttempts(res.data.maxAttempts);
        if (res.data.summary) setSummary(res.data.summary);
      } else {
        // A failed load is an error to show, not an empty queue to imply
        // everything is in sync (issue #942, F17/F18).
        setLoadError(res.data?.error ?? "خطا در بارگیری صف");
        setRows([]);
        setTotal(0);
        setTotalPages(1);
      }
    },
    [statusFilter, directionFilter, debouncedSearch, page, pageSize],
  );

  // A different store is a different queue: drop the previous store's rows,
  // page and inspector state instead of flashing them under the new name.
  useEffect(() => {
    setRows(null);
    setSummary(null);
    setPage(1);
    setExpandedRowId(null);
    setDetails({});
    setLoadError(null);
  }, [selectedId]);

  useEffect(() => {
    if (selectedId) {
      load(selectedId, statusFilter, directionFilter, debouncedSearch, page);
    }
  }, [selectedId, statusFilter, directionFilter, debouncedSearch, page, load]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    // The debounced effect is the only loader; submitting must not fire a
    // second, duplicate request (issue #942, F18).
    e.preventDefault();
    setPage(1);
    setDebouncedSearch(searchQuery);
  };

  const handleClearSearch = () => {
    setSearchQuery("");
    setDebouncedSearch("");
    setPage(1);
  };

  const loadDetail = useCallback(
    async (row: WpQueueRow) => {
      if (!selectedId || details[row.id]) return;
      setDetails((prev) => ({ ...prev, [row.id]: "loading" }));
      const res = await api<{ row: WpQueueRowDetail }>(
        `/api/integrations/wp-manager/queue/${row.id}?connectionId=${selectedId}&direction=${row.direction}`,
      );
      setDetails((prev) => ({ ...prev, [row.id]: res.ok ? res.data.row : "error" }));
    },
    [selectedId, details],
  );

  const selectedConnection = useMemo(
    () => connections?.find((c) => c.id === selectedId) ?? null,
    [connections, selectedId],
  );

  async function retryRow(row: WpQueueRow) {
    if (!selectedId) return;
    setBusyRowId(row.id);
    setBannerMessage(null);
    const res = await api<{ ok: boolean; error?: string; status?: string }>(`/api/integrations/wp-manager/queue`, {
      method: "POST",
      body: JSON.stringify({
        action: "retry",
        connectionId: selectedId,
        id: row.id,
        direction: row.direction,
      }),
    });
    setBusyRowId(null);
    if (res.ok) {
      setBannerMessage({ kind: "ok", text: "کار مجدداً در صف قرار گرفت و در نوبت ارسال قرار گرفت." });
      await load(selectedId);
    } else if (res.data?.error === "not_retryable") {
      // The row moved on without us (already sent, in flight, or waiting on
      // a manual review decision) — say which, and show the fresh state.
      const current = res.data.status ? (STATUS_CONFIG[res.data.status]?.label ?? res.data.status) : "نامشخص";
      setBannerMessage({
        kind: "err",
        text: `این ردیف دیگر قابل تلاش مجدد نیست؛ وضعیت فعلی آن «${current}» است. فهرست تازه شد.`,
      });
      await load(selectedId);
    } else if (res.data?.error === "connection_paused") {
      setBannerMessage({ kind: "err", text: "اتصال این فروشگاه متوقف (مکث) است؛ ابتدا آن را فعال کنید." });
    } else {
      setBannerMessage({ kind: "err", text: res.data?.error ? `خطا در تلاش مجدد: ${res.data.error}` : "خطا در تلاش مجدد." });
    }
  }

  async function resolveReviewRow(row: WpQueueRow, resolution: "mark_sent" | "retry" | "stop") {
    if (!selectedId) return;
    setBusyRowId(row.id);
    setBannerMessage(null);
    const res = await api<{ ok: boolean; error?: string; status?: string }>(`/api/integrations/wp-manager/queue`, {
      method: "POST",
      body: JSON.stringify({
        action: "resolve_review",
        connectionId: selectedId,
        id: row.id,
        resolution,
      }),
    });
    setBusyRowId(null);
    if (res.ok) {
      setBannerMessage({
        kind: "ok",
        text:
          resolution === "mark_sent"
            ? "ردیف به‌عنوان «انجام‌شده در فروشگاه» ثبت و تصمیم شما در سوابق ذخیره شد."
            : resolution === "retry"
              ? "ردیف پس از بررسی شما دوباره در صف ارسال قرار گرفت."
              : "ردیف متوقف شد و دیگر ارسال نمی‌شود؛ تصمیم شما در سوابق ثبت شد.",
      });
      await load(selectedId);
    } else {
      setBannerMessage({
        kind: "err",
        text:
          res.data?.error === "not_in_review"
            ? "این ردیف دیگر در وضعیت نیازمند بررسی نیست؛ فهرست را تازه کنید."
            : res.data?.error === "connection_paused"
              ? "اتصال این فروشگاه متوقف (مکث) است؛ ابتدا آن را فعال کنید."
              : "خطا در ثبت تصمیم بررسی.",
      });
      await load(selectedId);
    }
  }

  // F11: ask the store (REST mode) whether this needs_review operation
  // actually landed, before the operator has to guess. Read-only.
  async function verifyReviewRow(row: WpQueueRow) {
    if (!selectedId) return;
    setVerifyingId(row.id);
    const res = await api<{
      ok: boolean;
      verdict?: "landed" | "not_landed" | "unknown";
      detail?: string;
      error?: string;
    }>(`/api/integrations/wp-manager/queue`, {
      method: "POST",
      body: JSON.stringify({ action: "verify_review", connectionId: selectedId, id: row.id }),
    });
    setVerifyingId(null);
    if (res.ok && res.data?.verdict) {
      setVerifyResults((prev) => ({
        ...prev,
        [row.id]: { verdict: res.data!.verdict!, detail: res.data!.detail ?? "" },
      }));
    } else {
      setVerifyResults((prev) => ({ ...prev, [row.id]: "error" }));
    }
  }

  async function handleRetryAll() {
    if (!selectedId) return;
    setBatchBusy("retry_all");
    setBannerMessage(null);
    const res = await api<{
      ok: boolean;
      outboxRetried: number;
      inboxRetried: number;
      inboxFailed?: number;
      remaining?: number;
      hasMore?: boolean;
      error?: string;
    }>(`/api/integrations/wp-manager/queue`, {
      method: "POST",
      body: JSON.stringify({
        action: "retry_all",
        connectionId: selectedId,
      }),
    });
    setBatchBusy(null);
    if (res.ok) {
      // One call moves one bounded batch (issue #942, F07) — report exactly
      // what this batch did and what is still owed, not "همه انجام شد".
      const totalRetried = (res.data?.outboxRetried ?? 0) + (res.data?.inboxRetried ?? 0);
      const failedAgain = res.data?.inboxFailed ?? 0;
      const remaining = res.data?.remaining ?? 0;
      setBannerMessage({
        kind: "ok",
        text:
          `در این نوبت ${toPersianDigits(totalRetried)} کار و رویداد ناموفق به صف بازگشت` +
          (failedAgain > 0 ? ` و ${toPersianDigits(failedAgain)} رویداد ورودی دوباره خطا داد` : "") +
          (remaining > 0
            ? `؛ ${toPersianDigits(remaining)} مورد ناموفق دیگر باقی مانده است — برای ادامه دوباره تلاش کنید.`
            : "؛ مورد ناموفق دیگری باقی نماند."),
      });
      await load(selectedId);
    } else {
      setBannerMessage({ kind: "err", text: res.data?.error ?? "خطا در اجرای تلاش مجدد همگانی." });
    }
  }

  async function handleFlush() {
    if (!selectedId) return;
    setBatchBusy("flush");
    setBannerMessage(null);
    const res = await api<{ ok: boolean; mode: "rest_api" | "plugin"; message?: string; error?: string }>(
      `/api/integrations/wp-manager/queue`,
      {
        method: "POST",
        body: JSON.stringify({
          action: "flush",
          connectionId: selectedId,
        }),
      },
    );
    setBatchBusy(null);
    if (res.ok) {
      setBannerMessage({
        kind: "ok",
        text: res.data?.message ?? "صف همگام‌سازی با موفقیت بررسی و ارسال شد.",
      });
      await load(selectedId);
    } else {
      setBannerMessage({ kind: "err", text: res.data?.error ?? "خطا در ارسال صف." });
    }
  }

  const copyPayload = (id: string, payload: unknown) => {
    try {
      navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Browser fallback
    }
  };

  if (connections === null) return <SectionCardSkeleton rows={6} />;
  if (connections.length === 0) {
    return (
      <EmptyState>
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <AlertTriangleIcon className="size-10 text-muted-foreground/60" />
          <p className="font-semibold text-foreground">فروشگاهی متصل نیست</p>
          <p className="max-w-md text-sm text-muted-foreground">
            جهت مشاهده و مدیریت صف همگام‌سازی و رویدادها، ابتدا یک فروشگاه وردپرس/ووکامرس متصل فرمایید.
          </p>
          <Link href="/settings/connections?tab=woocommerce">
            <Button size="sm">اتصال فروشگاه</Button>
          </Link>
        </div>
      </EmptyState>
    );
  }

  // `summary.failed` is the whole خطا و متوقف bucket (failed + dead) in the
  // one server-side classification — adding dead again would double-count.
  const totalFailedCount = summary?.failed ?? 0;
  const needsReviewCount = summary?.needsReview ?? 0;
  const isPluginMode = selectedConnection?.linkMode === "plugin";
  // The plugin's own on-site queue, as its last handshake reported it
  // (issue #942, F12) — a third layer beside platform-outbound and
  // platform-inbound, shown so «رویداد هنوز از سایت خارج نشده» is visible.
  const pluginHealth = (selectedConnection?.pluginHealth ?? {}) as Record<string, unknown>;
  const pluginLocalQueue = isPluginMode
    ? {
        pending: typeof pluginHealth.localQueuePending === "number" ? pluginHealth.localQueuePending : null,
        deferred: typeof pluginHealth.localQueueDeferred === "number" ? pluginHealth.localQueueDeferred : null,
        failed: typeof pluginHealth.localQueueFailed === "number" ? pluginHealth.localQueueFailed : null,
      }
    : null;
  // Per-event stuck list from the plugin (issue #942, F12). `null` means the
  // plugin predates per-event reporting — different from an empty list.
  const pluginLocalRecent: Array<{
    topic: string;
    remoteId: string;
    status: "pending" | "failed";
    attempts: number;
    lastError: string | null;
    createdAt: string | null;
  }> | null =
    isPluginMode && Array.isArray(pluginHealth.localQueueRecent)
      ? (pluginHealth.localQueueRecent as Array<Record<string, unknown>>)
          .filter((item) => item && typeof item.topic === "string")
          .map((item) => ({
            topic: String(item.topic),
            remoteId: typeof item.remoteId === "string" ? item.remoteId : "",
            status: item.status === "failed" ? "failed" : "pending",
            attempts: typeof item.attempts === "number" ? item.attempts : 0,
            lastError: typeof item.lastError === "string" ? item.lastError : null,
            createdAt: typeof item.createdAt === "string" ? item.createdAt : null,
          }))
      : null;
  // The plugin's next scheduled run (issue #942, F19): `wp_next_scheduled`
  // reports unix seconds or false when WP-Cron has no hook at all.
  const pluginNextCron: { reported: boolean; at: Date | null } = (() => {
    if (!isPluginMode) return { reported: false, at: null };
    const next = pluginHealth.nextCron;
    if (!next || typeof next !== "object") return { reported: false, at: null };
    const fast = (next as Record<string, unknown>).fast;
    return typeof fast === "number" && fast > 0
      ? { reported: true, at: new Date(fast * 1000) }
      : { reported: true, at: null };
  })();

  return (
    <div className="space-y-4 sm:space-y-5">
      {/* Connection & Top Actions */}
      <ConnectionPicker connections={connections} value={selectedId} onChange={setSelectedId}>
        <div className="flex flex-wrap items-center gap-2">
          {totalFailedCount > 0 ? (
            <Button
              variant="outline"
              size="sm"
              disabled={batchBusy !== null || loading || !canSync}
              onClick={handleRetryAll}
              className="border-amber-300 dark:border-amber-700/60 bg-amber-50/50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40"
            >
              <RotateCcwIcon className="size-4" />
              {batchBusy === "retry_all"
                ? "در حال بازنشانی…"
                : `تلاش مجدد موارد ناموفق (${toPersianDigits(totalFailedCount)})`}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={batchBusy !== null || loading || !canSync}
            onClick={handleFlush}
            title={isPluginMode ? "بررسی وضعیت صف در افزونه وردپرس" : "ارسال فوری کارهای معوقه به فروشگاه"}
          >
            <SendIcon className="size-4" />
            {batchBusy === "flush"
              ? "در حال ارسال…"
              : isPluginMode
                ? "وضعیت ارسال صف"
                : "ارسال فوری صف"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => load(selectedId)}
            className="shrink-0"
          >
            <RefreshCwIcon className="size-4" />
            {loading ? "در حال به‌روزرسانی…" : "تازه‌سازی"}
          </Button>
        </div>
      </ConnectionPicker>

      {!canSync ? (
        <p className="text-xs text-muted-foreground" role="note">
          حالت فقط مشاهده — برای تلاش دوباره و اقدامات صف، دسترسی «همگام‌سازی ووکامرس» لازم است؛ بررسی رسیدن عملیات همچنان در دسترس است.
        </p>
      ) : null}

      <PluginWaitNote connections={connections} selectedId={selectedId} />

      {/* Connection health strip (issue #942, F12/F19): mode, plugin
          liveness, backlog age — and, for plugin stores, the plugin's own
          on-site queue counts, which are a separate layer from the platform
          rows listed below. */}
      {selectedConnection ? (
        <div className={`${cardClass} px-4 py-3 text-xs text-muted-foreground`}>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
            <span>
              حالت اتصال:{" "}
              <span className="font-medium text-foreground">{isPluginMode ? "افزونهٔ وردپرس" : "REST API"}</span>
              {selectedConnection.status === "paused" ? (
                <span className="ms-1 font-semibold text-amber-700 dark:text-amber-300">(متوقف / مکث)</span>
              ) : null}
            </span>
            {isPluginMode && selectedConnection.pluginVersion ? (
              <span>
                نسخهٔ افزونه: <span className="font-medium text-foreground" dir="ltr">{selectedConnection.pluginVersion}</span>
              </span>
            ) : null}
            {isPluginMode && selectedConnection.lastPluginSeenAt ? (
              <span>
                آخرین تماس افزونه:{" "}
                <span className="font-medium text-foreground">
                  {formatJalali(selectedConnection.lastPluginSeenAt, { withTime: true })}
                </span>
              </span>
            ) : null}
            {isPluginMode && pluginNextCron.reported ? (
              pluginNextCron.at ? (
                <span>
                  اجرای زمان‌بندی بعدی افزونه:{" "}
                  <span className="font-medium text-foreground">
                    {formatJalali(pluginNextCron.at.toISOString(), { withTime: true })}
                  </span>
                  {Date.now() - pluginNextCron.at.getTime() > 15 * 60 * 1000 &&
                  (pluginLocalQueue?.pending ?? 0) > 0 ? (
                    <span className="ms-1 font-semibold text-amber-700 dark:text-amber-300">
                      — از موعد آن گذشته است؛ احتمالاً WP-Cron سایت اجرا نمی‌شود
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="font-semibold text-amber-700 dark:text-amber-300">
                  زمان‌بندی بعدی افزونه یافت نشد؛ WP-Cron وردپرس را بررسی کنید.
                </span>
              )
            ) : null}
            {selectedConnection.lastSyncAt ? (
              <span>
                آخرین همگام‌سازی:{" "}
                <span className="font-medium text-foreground">
                  {formatJalali(selectedConnection.lastSyncAt, { withTime: true })}
                </span>
              </span>
            ) : null}
            {summary?.oldestOpenAt ? (
              <span>
                قدیمی‌ترین کار باز:{" "}
                <span className="font-medium text-foreground">{formatJalali(summary.oldestOpenAt, { withTime: true })}</span>
              </span>
            ) : null}
            {summary?.nextRetryAt ? (
              <span>
                تلاش بعدی:{" "}
                <span className="font-medium text-foreground">{formatJalali(summary.nextRetryAt, { withTime: true })}</span>
              </span>
            ) : null}
          </div>
          {pluginLocalQueue && (pluginLocalQueue.pending !== null || pluginLocalQueue.failed !== null) ? (
            <p className="mt-1.5">
              صف محلی افزونه در سایت (رویدادهایی که هنوز به سیستم نرسیده‌اند):{" "}
              <span className="font-medium text-foreground">
                {toPersianDigits(pluginLocalQueue.pending ?? 0)} در انتظار ارسال
              </span>
              {pluginLocalQueue.deferred ? (
                <span className="font-medium text-foreground">، {toPersianDigits(pluginLocalQueue.deferred)} تعویق‌شده</span>
              ) : null}
              {pluginLocalQueue.failed ? (
                <span className="font-semibold text-red-600 dark:text-red-400">
                  ، {toPersianDigits(pluginLocalQueue.failed)} ناموفق — در پیشخوان وردپرس، بخش افزونهٔ اتصال، قابل بررسی است
                </span>
              ) : null}
            </p>
          ) : null}
          {/* Per-event detail behind those counts (issue #942, F12): which
              exact events are stuck in the plugin and why. */}
          {pluginLocalRecent && pluginLocalRecent.length > 0 ? (
            <details className="mt-2">
              <summary className="cursor-pointer select-none font-medium text-foreground">
                مشاهدهٔ رویدادهای گیرکرده در افزونه ({toPersianDigits(pluginLocalRecent.length)})
              </summary>
              <ul className="mt-1.5 space-y-1">
                {pluginLocalRecent.map((item, index) => (
                  <li
                    key={`${item.topic}-${item.remoteId}-${index}`}
                    className="flex flex-wrap items-baseline gap-x-2 rounded-lg bg-muted/50 px-2.5 py-1.5"
                  >
                    <span className="font-medium text-foreground" dir="ltr">{item.topic}</span>
                    {item.remoteId ? (
                      <span className="font-mono" dir="ltr">{item.remoteId}</span>
                    ) : null}
                    <span
                      className={
                        item.status === "failed"
                          ? "font-semibold text-red-600 dark:text-red-400"
                          : "text-amber-700 dark:text-amber-300"
                      }
                    >
                      {item.status === "failed" ? "ناموفق" : "در انتظار ارسال"}
                    </span>
                    <span>تلاش: {toPersianDigits(item.attempts)}</span>
                    {item.createdAt ? (
                      <span>از {formatJalali(item.createdAt, { withTime: true })}</span>
                    ) : null}
                    {item.lastError ? (
                      <span className="w-full break-words text-red-600 dark:text-red-400">{item.lastError}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : pluginLocalRecent === null && (pluginLocalQueue?.failed ?? 0) > 0 ? (
            <p className="mt-1.5">
              نمایش ریز رویدادهای گیرکرده به نسخهٔ جدید افزونه نیاز دارد؛ افزونهٔ وردپرس را به‌روز کنید تا هر رویداد و دلیل توقفش همین‌جا دیده شود.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Needs-review callout (issue #942, F15): these are never swept into
          a bulk retry — each one needs an operator who checked the store. */}
      {needsReviewCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 dark:border-red-800/60 bg-red-50/70 dark:bg-red-950/30 p-3.5 text-sm">
          <div className="flex items-center gap-2.5 text-red-900 dark:text-red-200">
            <AlertTriangleIcon className="size-5 shrink-0 text-red-600 dark:text-red-400" />
            <span>
              <strong>{toPersianDigits(needsReviewCount)}</strong> عملیات نتیجه‌اش در فروشگاه قطعی نیست و نیازمند بررسی
              دستی است؛ این موارد در «تلاش مجدد همگانی» شرکت نمی‌کنند.
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setPage(1); setStatusFilter("needs_review"); }}
            className="border-red-300 dark:border-red-700 text-red-800 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40"
          >
            مشاهده و تصمیم‌گیری
          </Button>
        </div>
      ) : null}

      {/* Banner message if any action completed */}
      {bannerMessage ? (
        <div
          className={`flex items-center justify-between gap-3 rounded-xl p-3.5 text-sm transition-all ${
            bannerMessage.kind === "ok"
              ? "bg-teal-50 dark:bg-teal-950/40 text-teal-800 dark:text-teal-200 border border-teal-200 dark:border-teal-800/60"
              : "bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200 border border-red-200 dark:border-red-800/60"
          }`}
        >
          <div className="flex items-center gap-2.5">
            {bannerMessage.kind === "ok" ? (
              <CheckCircle2Icon className="size-5 shrink-0 text-teal-600 dark:text-teal-400" />
            ) : (
              <AlertTriangleIcon className="size-5 shrink-0 text-red-600 dark:text-red-400" />
            )}
            <span>{bannerMessage.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setBannerMessage(null)}
            className="p-1 text-muted-foreground hover:text-foreground rounded-md"
            aria-label="بستن پیام"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      ) : null}

      {/* KPI Summary Tiles */}
      {summary ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
          <button
            type="button"
            onClick={() => { setPage(1); setStatusFilter("all"); }}
            className={`${cardClass} p-3 sm:p-4 text-start transition-all hover:border-teal-500/50 ${
              statusFilter === "all" ? "ring-2 ring-teal-500/30 border-teal-500/50" : ""
            }`}
          >
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-xs font-medium">کل موارد</span>
              <LayersIcon className="size-4" />
            </div>
            <p className="mt-2 text-xl sm:text-2xl font-bold tabular-nums text-foreground">
              {toPersianDigits(summary.total)}
            </p>
            <span className="text-[10px] text-muted-foreground">رویدادها و کارها</span>
          </button>

          <button
            type="button"
            onClick={() => { setPage(1); setStatusFilter("pending"); }}
            className={`${cardClass} p-3 sm:p-4 text-start transition-all hover:border-teal-500/50 ${
              statusFilter === "pending" ? "ring-2 ring-teal-500/30 border-teal-500/50" : ""
            }`}
          >
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-xs font-medium">در انتظار ارسال</span>
              <ClockIcon className="size-4 text-amber-600 dark:text-amber-400" />
            </div>
            <p className="mt-2 text-xl sm:text-2xl font-bold tabular-nums text-foreground">
              {toPersianDigits(summary.pending)}
            </p>
            <span className="text-[10px] text-muted-foreground">
              {summary.deferred > 0 ? `${toPersianDigits(summary.deferred)} تعویق‌شده در مکث` : "در صف ارسال به فروشگاه"}
            </span>
          </button>

          <button
            type="button"
            onClick={() => { setPage(1); setStatusFilter("processing"); }}
            className={`${cardClass} p-3 sm:p-4 text-start transition-all hover:border-teal-500/50 ${
              statusFilter === "processing" ? "ring-2 ring-teal-500/30 border-teal-500/50" : ""
            }`}
          >
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-xs font-medium">در حال پردازش</span>
              <RefreshCwIcon className="size-4 text-teal-600 dark:text-teal-400" />
            </div>
            <p className="mt-2 text-xl sm:text-2xl font-bold tabular-nums text-foreground">
              {toPersianDigits(summary.processing)}
            </p>
            <span className="text-[10px] text-muted-foreground">در حال اجرای جاری</span>
          </button>

          <button
            type="button"
            onClick={() => { setPage(1); setStatusFilter("failed"); }}
            className={`${cardClass} p-3 sm:p-4 text-start transition-all hover:border-red-500/50 ${
              statusFilter === "failed" ? "ring-2 ring-red-500/30 border-red-500/50" : ""
            } ${totalFailedCount > 0 ? "bg-red-50/40 dark:bg-red-950/20" : ""}`}
          >
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-xs font-medium text-red-600 dark:text-red-400">خطا و متوقف</span>
              <AlertTriangleIcon className="size-4 text-red-600 dark:text-red-400" />
            </div>
            <p className="mt-2 text-xl sm:text-2xl font-bold tabular-nums text-red-600 dark:text-red-400">
              {toPersianDigits(totalFailedCount)}
            </p>
            <span className="text-[10px] text-muted-foreground">
              {summary.dead > 0 ? `${toPersianDigits(summary.dead)} متوقف دائمی` : "نیازمند تلاش مجدد"}
            </span>
          </button>

          <button
            type="button"
            onClick={() => { setPage(1); setStatusFilter("sent"); }}
            className={`${cardClass} col-span-2 sm:col-span-1 p-3 sm:p-4 text-start transition-all hover:border-teal-500/50 ${
              statusFilter === "sent" ? "ring-2 ring-teal-500/30 border-teal-500/50" : ""
            }`}
          >
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-xs font-medium text-teal-700 dark:text-teal-300">موفق / تکمیل</span>
              <CheckCircle2Icon className="size-4 text-teal-600 dark:text-teal-400" />
            </div>
            <p className="mt-2 text-xl sm:text-2xl font-bold tabular-nums text-teal-700 dark:text-teal-300">
              {toPersianDigits(summary.sent)}
            </p>
            <span className="text-[10px] text-muted-foreground">ارسال یا دریافت شده</span>
          </button>
        </div>
      ) : null}

      {/* Filter and Search Bar */}
      <div className={`${cardClass} p-3 sm:p-4 space-y-3`}>
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
          {/* Status Tabs */}
          <div className="flex flex-wrap items-center gap-1.5 p-1 rounded-xl bg-muted text-xs">
            {(
              [
                { key: "open", label: "کارهای باز" },
                { key: "failed", label: "ناموفق / خطا" },
                { key: "needs_review", label: "نیازمند بررسی" },
                { key: "pending", label: "در انتظار" },
                { key: "processing", label: "در حال پردازش" },
                { key: "deferred", label: "تعویق‌شده" },
                { key: "sent", label: "تکمیل‌شده" },
                { key: "all", label: "همه موارد" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => { setPage(1); setStatusFilter(tab.key); }}
                className={`px-3 py-1.5 font-medium rounded-lg transition-all ${
                  statusFilter === tab.key
                    ? "bg-card text-foreground font-semibold"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Direction Filter & Search Form */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 text-xs">
              <SlidersHorizontalIcon className="size-3.5 text-muted-foreground" />
              <select
                value={directionFilter}
                onChange={(e) => { setPage(1); setDirectionFilter(e.target.value as DirectionFilter); }}
                className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-400"
                aria-label="فیلتر جهت رویداد"
              >
                <option value="all">همه جهات</option>
                <option value="out">فقط خروجی (به فروشگاه ↗)</option>
                <option value="in">فقط ورودی (از فروشگاه ↙)</option>
              </select>
            </div>

            <form onSubmit={handleSearchSubmit} className="relative flex-1 sm:w-64">
              <input
                type="text"
                placeholder="جست‌وجو با شناسه، عنوان یا خطا…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded-lg border border-border bg-card pe-8 ps-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-400"
              />
              {searchQuery ? (
                <button
                  type="button"
                  onClick={handleClearSearch}
                  className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="پاک کردن جست‌وجو"
                >
                  <XIcon className="size-3.5" />
                </button>
              ) : (
                <SearchIcon className="absolute end-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
              )}
            </form>
          </div>
        </div>
      </div>

      {/* Main Queue Table & Event Cards */}
      <section className={`${cardClass} overflow-hidden`}>
        <div className="border-b border-border/80 px-4 py-3.5 sm:px-5 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold text-foreground text-sm sm:text-base">
              صف همگام‌سازی و گزارش رویدادها
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {rows === null
                ? "در حال بارگیری صف…"
                : `نمایش ${toPersianDigits(rows.length)} مورد${
                    searchQuery ? ` برای عبارت «${searchQuery}»` : ""
                  }`}
            </p>
          </div>
          {isPluginMode ? (
            <span className="text-[11px] text-muted-foreground bg-muted px-2.5 py-1 rounded-full">
              حالت افزونه: همگام‌سازی با دوره‌های اجرای افزونه در وردپرس انجام می‌شود
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground bg-muted px-2.5 py-1 rounded-full">
              حالت REST: همگام‌سازی مستقیم از طریق درگاه برنامه
            </span>
          )}
        </div>

        {rows === null ? (
          <SectionCardSkeleton rows={5} />
        ) : loadError ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground sm:px-5 space-y-2">
            <AlertTriangleIcon className="size-8 mx-auto text-red-600 dark:text-red-400" />
            <p className="font-medium text-foreground">بارگیری صف با خطا روبه‌رو شد.</p>
            <p className="font-mono text-[11px]" dir="ltr">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => load(selectedId)}>
              تلاش دوباره
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground sm:px-5 space-y-2">
            <CheckCircle2Icon className="size-8 mx-auto text-teal-600 dark:text-teal-400" />
            <p className="font-medium text-foreground">
              {debouncedSearch || directionFilter !== "all"
                ? "موردی با این فیلتر یافت نشد."
                : statusFilter === "failed"
                  ? "هیچ کار یا رویداد ناموفقی در صف وجود ندارد."
                  : statusFilter === "needs_review"
                    ? "موردی نیازمند بررسی دستی نیست."
                    : statusFilter === "processing"
                      ? "در حال حاضر کاری در دست پردازش نیست."
                      : statusFilter === "pending"
                        ? summary && summary.open > 0
                          ? "کاری در صف انتظار نیست."
                          : "کاری در صف انتظار نیست؛ تمامی داده‌ها با فروشگاه همگام هستند."
                        : statusFilter === "deferred"
                          ? "رویداد تعویق‌شده‌ای وجود ندارد."
                          : statusFilter === "sent"
                            ? "موردی در تاریخچه تکمیل‌شده با این فیلتر یافت نشد."
                            : "صف خالی است — کار در انتظار یا خطایی وجود ندارد."}
            </p>
            {searchQuery || statusFilter !== "open" || directionFilter !== "all" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setPage(1);
                  setStatusFilter("open");
                  setDirectionFilter("all");
                  setSearchQuery("");
                  setDebouncedSearch("");
                }}
              >
                بازنشانی فیلترها
              </Button>
            ) : null}
          </div>
        ) : (
          <ul className="divide-y divide-border/80">
            {rows.map((row) => {
              const kindInfo = KIND_LABELS[row.kind] ?? {
                label: row.kind,
                desc: row.direction === "out" ? "عملیات خروجی به وردپرس" : "رویداد دریافتی از وردپرس",
              };
              const statusCfg = STATUS_CONFIG[row.status] ?? {
                label: row.status,
                tone: "neutral" as const,
                desc: "",
              };
              const isExpanded = expandedRowId === row.id;
              const isBusy = busyRowId === row.id;
              const hasError = Boolean(row.error);
              const isFailedOrDead = row.status === "failed" || row.status === "dead";
              // Only these states may be retried (issue #942, F05) — the
              // button is never offered for sent/processing/needs_review,
              // and the server fences it again regardless.
              const isRetryable = row.status === "failed" || row.status === "dead";
              const isNeedsReview = row.status === "needs_review";
              const detail = details[row.id];
              const detailPayload = detail && detail !== "loading" && detail !== "error" ? detail.payload : null;

              return (
                <li
                  key={`${row.direction}-${row.id}`}
                  className={`p-4 sm:px-5 transition-colors ${
                    isFailedOrDead ? "bg-red-50/20 dark:bg-red-950/10" : ""
                  }`}
                >
                  <div className="flex flex-col md:flex-row md:items-start justify-between gap-3">
                    {/* Direction Icon & Title */}
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <span
                        className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl ${
                          row.direction === "out"
                            ? "bg-teal-50 dark:bg-teal-500/15 text-teal-700 dark:text-teal-300"
                            : "bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300"
                        }`}
                        title={row.direction === "out" ? "خروجی به فروشگاه آنلاین" : "ورودی از فروشگاه آنلاین"}
                      >
                        {row.direction === "out" ? (
                          <ArrowUpRightIcon className="size-4.5" />
                        ) : (
                          <ArrowDownLeftIcon className="size-4.5" />
                        )}
                      </span>

                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-foreground text-sm">
                            {kindInfo.label}
                          </span>
                          <span
                            className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
                              row.direction === "out"
                                ? "bg-teal-100/60 dark:bg-teal-900/40 text-teal-800 dark:text-teal-300"
                                : "bg-indigo-100/60 dark:bg-indigo-900/40 text-indigo-800 dark:text-indigo-300"
                            }`}
                          >
                            {row.direction === "out" ? "ارسال به فروشگاه" : "دریافت از فروشگاه"}
                          </span>
                          {row.remoteId && row.remoteId !== "all" ? (
                            <span
                              className="rounded-md border border-border/80 bg-muted px-2 py-0.5 text-[11px] font-mono text-foreground/80"
                              dir="ltr"
                            >
                              #{row.remoteId}
                            </span>
                          ) : null}
                        </div>

                        <p className="text-xs text-muted-foreground">{kindInfo.desc}</p>

                        {/* Metadata row */}
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground pt-0.5">
                          <span>
                            ثبت: {formatJalali(row.createdAt, { withTime: true })}
                          </span>
                          {row.attempts > 0 ? (
                            <span className="font-medium text-amber-700 dark:text-amber-300">
                              {toPersianDigits(row.attempts)} تلاش ناموفق
                            </span>
                          ) : null}
                          {row.nextAttemptAt && isFailedOrDead ? (
                            <span>
                              تلاش بعدی: {formatJalali(row.nextAttemptAt, { withTime: true })}
                            </span>
                          ) : null}
                          {row.sentAt ? (
                            <span className="text-teal-700 dark:text-teal-300">
                              ارسال شد: {formatJalali(row.sentAt, { withTime: true })}
                            </span>
                          ) : null}
                          {row.processedAt ? (
                            <span className="text-teal-700 dark:text-teal-300">
                              ثبت شد: {formatJalali(row.processedAt, { withTime: true })}
                            </span>
                          ) : null}
                          {row.deliveryId ? (
                            <span className="font-mono text-[10px]" dir="ltr" title="شناسه تحویل یکتا">
                              ID: {row.deliveryId.slice(0, 8)}…
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    {/* Status badge & Action buttons */}
                    <div className="flex flex-wrap items-center gap-2 md:self-start md:ms-2 shrink-0">
                      <StatusBadge tone={statusCfg.tone}>
                        {statusCfg.label}
                      </StatusBadge>

                      {isRetryable ? (
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={isBusy || !canSync}
                          onClick={() => retryRow(row)}
                          className="border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                        >
                          <RotateCcwIcon className="size-3.5" />
                          {isBusy ? "در حال ثبت…" : "تلاش مجدد"}
                        </Button>
                      ) : null}

                      {kindInfo.link ? (
                        <Link href={kindInfo.link}>
                          <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground">
                            <ExternalLinkIcon className="size-3.5" />
                            بخش مربوطه
                          </Button>
                        </Link>
                      ) : null}

                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => {
                          setExpandedRowId(isExpanded ? null : row.id);
                          if (!isExpanded) void loadDetail(row);
                        }}
                        className="text-xs text-muted-foreground hover:text-foreground"
                        aria-expanded={isExpanded}
                      >
                        {isExpanded ? (
                          <>
                            بستن
                            <ChevronUpIcon className="size-3.5" />
                          </>
                        ) : (
                          <>
                            داده‌ها و جزئیات
                            <ChevronDownIcon className="size-3.5" />
                          </>
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* Error Box if failed */}
                  {hasError ? (
                    <div className="mt-3 rounded-xl border border-red-200 dark:border-red-800/60 bg-red-50/80 dark:bg-red-950/40 p-3 text-xs text-red-900 dark:text-red-200 space-y-1">
                      <div className="flex items-center gap-1.5 font-semibold text-red-800 dark:text-red-300">
                        <AlertTriangleIcon className="size-4 shrink-0" />
                        <span>شرح خطا: {describePersianError(row.error)}</span>
                      </div>
                      <p className="font-mono text-[11px] break-all text-red-700 dark:text-red-300/80 pe-2" dir="ltr">
                        {row.error}
                      </p>
                      {row.status === "dead" ? (
                        <p className="text-[11px] text-red-600 dark:text-red-400 font-medium">
                          راهنما: این کار پس از {toPersianDigits(maxAttempts ?? (isPluginMode ? 6 : 8))} بار تلاش ناموفق
                          متوقف شده است. پس از رفع مشکل در فروشگاه وردپرس، دکمهٔ «تلاش مجدد» را بزنید.
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Needs-review decision box (issue #942, F15): the remote
                      outcome of a non-idempotent write is unproven, so there
                      is deliberately no one-click replay — the operator
                      checks the store, then records one explicit decision. */}
                  {isNeedsReview ? (
                    <div className="mt-3 rounded-xl border border-red-300 dark:border-red-700/70 bg-red-50 dark:bg-red-950/50 p-3 text-xs text-red-900 dark:text-red-200 space-y-2">
                      <div className="flex items-center gap-1.5 font-semibold text-red-800 dark:text-red-300">
                        <AlertTriangleIcon className="size-4 shrink-0" />
                        <span>نتیجهٔ این عملیات در فروشگاه قطعی نیست و تلاش مجدد خودکار برای آن انجام نمی‌شود.</span>
                      </div>
                      <p className="text-red-800/90 dark:text-red-200/90">
                        ابتدا در فروشگاه وردپرس بررسی کنید که این عملیات انجام شده است یا نه
                        {row.operationId ? (
                          <>
                            {" "}(شناسهٔ عملیات: <span className="font-mono" dir="ltr">{row.operationId}</span>)
                          </>
                        ) : null}
                        ، سپس یکی از تصمیم‌های زیر را ثبت کنید؛ تصمیم و نام شما در سوابق همگام‌سازی ذخیره می‌شود.
                      </p>
                      {/* F11 verify assist: where a remote probe exists the
                          store answers instead of the operator guessing. */}
                      <div className="space-y-1.5">
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={isBusy || verifyingId === row.id}
                          onClick={() => verifyReviewRow(row)}
                          className="border-red-300 dark:border-red-700 bg-white/60 dark:bg-red-900/20 text-red-900 dark:text-red-200 hover:bg-white dark:hover:bg-red-900/40"
                        >
                          <SearchIcon className="size-3.5" />
                          {verifyingId === row.id ? "در حال استعلام…" : "استعلام خودکار از فروشگاه"}
                        </Button>
                        {verifyResults[row.id] ? (
                          verifyResults[row.id] === "error" ? (
                            <p className="rounded-lg bg-red-100/80 dark:bg-red-900/40 px-2.5 py-1.5 text-red-800 dark:text-red-200">
                              استعلام انجام نشد؛ وضعیت عملیات را دستی در فروشگاه بررسی کنید.
                            </p>
                          ) : (
                            <p
                              className={`rounded-lg px-2.5 py-1.5 ${
                                (verifyResults[row.id] as { verdict: string }).verdict === "landed"
                                  ? "bg-teal-100/80 dark:bg-teal-900/40 text-teal-900 dark:text-teal-200"
                                  : (verifyResults[row.id] as { verdict: string }).verdict === "not_landed"
                                    ? "bg-amber-100/80 dark:bg-amber-900/40 text-amber-900 dark:text-amber-200"
                                    : "bg-red-100/60 dark:bg-red-900/30 text-red-800 dark:text-red-200"
                              }`}
                            >
                              <strong className="font-semibold">
                                {(verifyResults[row.id] as { verdict: string }).verdict === "landed"
                                  ? "نتیجهٔ استعلام: انجام شده. "
                                  : (verifyResults[row.id] as { verdict: string }).verdict === "not_landed"
                                    ? "نتیجهٔ استعلام: یافت نشد. "
                                    : "نتیجهٔ استعلام: نامشخص. "}
                              </strong>
                              {(verifyResults[row.id] as { detail: string }).detail}
                            </p>
                          )
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={isBusy || !canSync}
                          onClick={() => resolveReviewRow(row, "mark_sent")}
                          className="border-teal-300 dark:border-teal-700 bg-teal-50 dark:bg-teal-950/40 text-teal-800 dark:text-teal-300 hover:bg-teal-100 dark:hover:bg-teal-900/40"
                        >
                          <CheckCircle2Icon className="size-3.5" />
                          بررسی کردم؛ در فروشگاه انجام شده
                        </Button>
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={isBusy || !canSync}
                          onClick={() => resolveReviewRow(row, "retry")}
                          className="border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                        >
                          <RotateCcwIcon className="size-3.5" />
                          انجام نشده؛ دوباره ارسال شود
                        </Button>
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={isBusy || !canSync}
                          onClick={() => resolveReviewRow(row, "stop")}
                          className="border-red-300 dark:border-red-700 bg-red-100/60 dark:bg-red-900/30 text-red-800 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/50"
                        >
                          <XIcon className="size-3.5" />
                          توقف و صرف‌نظر
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {/* Expanded Inspector (Payload & Deep Metadata) */}
                  {isExpanded ? (
                    <div className="mt-3 rounded-xl border border-border/80 bg-muted/60 p-3 sm:p-4 text-xs space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2">
                        <span className="font-semibold text-foreground">
                          جزئیات فنی و بسته اطلاعات (Payload)
                        </span>
                        {detailPayload ? (
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => copyPayload(row.id, detailPayload)}
                            className="gap-1.5"
                          >
                            {copiedId === row.id ? (
                              <>
                                <CheckIcon className="size-3.5 text-teal-600 dark:text-teal-400" />
                                کپی شد
                              </>
                            ) : (
                              <>
                                <CopyIcon className="size-3.5" />
                                کپی JSON
                              </>
                            )}
                          </Button>
                        ) : null}
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-[11px]">
                        <div>
                          <span className="text-muted-foreground">شناسه رویداد: </span>
                          <span className="font-mono text-foreground" dir="ltr">{row.id}</span>
                        </div>
                        {row.localId ? (
                          <div>
                            <span className="text-muted-foreground">شناسه داخلی سیستم: </span>
                            <span className="font-mono text-foreground" dir="ltr">{row.localId}</span>
                          </div>
                        ) : null}
                        {row.deliveryId ? (
                          <div>
                            <span className="text-muted-foreground">شناسه تحویل (Delivery ID): </span>
                            <span className="font-mono text-foreground" dir="ltr">{row.deliveryId}</span>
                          </div>
                        ) : null}
                        {row.operationId ? (
                          <div>
                            <span className="text-muted-foreground">شناسه عملیات (Operation ID): </span>
                            <span className="font-mono text-foreground" dir="ltr">{row.operationId}</span>
                          </div>
                        ) : null}
                        <div>
                          <span className="text-muted-foreground">نوع رویداد: </span>
                          <span className="font-mono text-foreground" dir="ltr">{row.kind}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">شناسه منبع در فروشگاه: </span>
                          <span className="font-mono text-foreground" dir="ltr">{row.remoteId}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">تعداد دفعات تلاش: </span>
                          <span className="text-foreground">{toPersianDigits(row.attempts)}</span>
                        </div>
                      </div>

                      {detail === "loading" ? (
                        <p className="text-[11px] text-muted-foreground">در حال بارگیری جزئیات…</p>
                      ) : detail === "error" ? (
                        <p className="text-[11px] text-red-600 dark:text-red-400">
                          بارگیری جزئیات این ردیف ناموفق بود؛ دوباره تلاش کنید.
                        </p>
                      ) : detailPayload && typeof detailPayload === "object" && Object.keys(detailPayload as object).length > 0 ? (
                        <div>
                          <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                            محتوای بسته ارسالی/دریافتی (رمزها حذف و اطلاعات تماس مشتری پوشانده شده‌اند):
                          </p>
                          <pre
                            className="max-h-60 overflow-auto rounded-lg bg-card p-2.5 font-mono text-[11px] leading-relaxed text-foreground border border-border/80"
                            dir="ltr"
                          >
                            {JSON.stringify(detailPayload, null, 2)}
                          </pre>
                        </div>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">بسته ارسالی خالی است یا بدنه ساختاری ندارد.</p>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {rows && (total > 0 || page > 1) ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/80 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            <span>
              صفحه {toPersianDigits(page)} از {toPersianDigits(totalPages)} — مجموعاً {toPersianDigits(total)} ردیف
            </span>
            <span className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>
                قبلی
              </Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages || loading} onClick={() => setPage((value) => value + 1)}>
                بعدی
              </Button>
            </span>
          </div>
        ) : null}
      </section>
    </div>
  );
}
