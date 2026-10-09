"use client";

/**
 * Cheques register — redesigned with the platform design system.
 *
 * One register for two directions (receivable / payable) because a treasurer
 * thinks in "what is due and what must be covered" not in two separate pages.
 * Every life-cycle step posts its own journal entry server-side; which steps
 * are offered is driven by `availableActions` (src/lib/cheques.ts) so the UI
 * can never offer a transition the server would refuse.
 *
 * Design decisions (platform UI/UX):
 * - DS primitives only: Card, Badge, Button, Input, Table, Tabs, Dialog,
 *   Field, Select, Alert, Skeleton, Separator, DropdownMenu. No hand-rolled
 *   cardClass duplication — the outer ledger chrome stays `cardClass` but
 *   every inner surface is a DS Card so elevation, radius and focus read the
 *   same as CRM, inventory and the store.
 * - Persian-first: RTL, Jalali, Toman via MoneyContext, Persian digits.
 * - One-column KPI strip + filter bar + Tabs for direction + Table (desktop)
 *   / stacked Cards (mobile). Detail is a Dialog with a timeline, not a
 *   second page, so the register stays the single source of truth.
 * - Create and every transition live in Dialogs with Field + JalaliDatePicker
 *   so the form, the validation and the fiscal-period error read the same as
 *   every other ledger form.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useDeferredValue,
  useCallback,
} from "react";
import {
  SearchIcon,
  PlusIcon,
  Building2Icon,
  HashIcon,
  CalendarDaysIcon,
  WalletIcon,
  TrendingUpIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  Clock3Icon,
  ArrowLeftRightIcon,
  HandCoinsIcon,
  EyeIcon,
  FilterIcon,
  LandmarkIcon,
  FileTextIcon,
  XIcon,
  ChevronDownIcon,
} from "lucide-react";

import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableFooter,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Field,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali, todayIsoDate } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import {
  availableActions,
  type ChequeAction,
  type ChequeDirection,
  type ChequeStatus,
} from "@/lib/cheques";
import { api } from "@/app/dashboard/ui";
import { JournalPeekDialog } from "./journal-peek-dialog";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

interface Cheque {
  id: string;
  locationId?: string | null;
  locationName?: string | null;
  direction: ChequeDirection;
  status: ChequeStatus;
  serialNumber: string;
  sayadId: string | null;
  bankName: string;
  accountNumber?: string | null;
  amount: number;
  issueDate: string;
  dueDate: string;
  counterpartyName: string;
  customerId?: string | null;
  supplierId?: string | null;
  memo: string | null;
  replacesChequeId?: string | null;
  replacesSerialNumber?: string | null;
  /** How much of this returned cheque has already been replaced. */
  replacedByAmount?: number;
  createdAt?: string;
}

interface Counterparty {
  id: string;
  name: string;
}

/** The server's accounting-aware totals for the whole filtered register. */
interface SummaryBucket {
  count: number;
  total: number;
}

interface ChequeSummary {
  outstanding: SummaryBucket;
  onHand: SummaryBucket;
  inCollection: SummaryBucket;
  issued: SummaryBucket;
  contingent: SummaryBucket;
  returnedUnresolved: SummaryBucket;
  resolved: SummaryBucket;
  cleared: SummaryBucket;
  cancelled: SummaryBucket;
  settled: SummaryBucket;
  overdue: SummaryBucket;
  dueSoon: SummaryBucket;
}

interface ChequePage {
  cheques?: Cheque[];
  total?: number;
  hasMore?: boolean;
  summary?: ChequeSummary;
  banks?: string[];
  error?: string;
}

/** How many rows one «بیشتر» adds. */
const PAGE_SIZE = 50;

interface ChequeEvent {
  id: string;
  event: string;
  occurredOn: string;
  entryId: string | null;
  endorsedToSupplierId: string | null;
  memo: string | null;
  createdAt: string;
}

const STATUS_LABELS: Record<ChequeStatus, string> = {
  on_hand: "نزد صندوق",
  in_collection: "در جریان وصول",
  endorsed: "واگذارشده",
  issued: "صادرشده",
  cleared: "وصول‌شده",
  bounced: "برگشتی",
  cancelled: "ابطال‌شده",
  resolved: "تعیین‌تکلیف‌شده",
};

const STATUS_TONE: Record<ChequeStatus, string> = {
  on_hand:
    "bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/20",
  in_collection:
    "bg-sky-100 text-sky-900 border-sky-200 dark:bg-sky-500/15 dark:text-sky-200 dark:border-sky-500/20",
  endorsed:
    "bg-violet-100 text-violet-900 border-violet-200 dark:bg-violet-500/15 dark:text-violet-200 dark:border-violet-500/20",
  issued:
    "bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/20",
  cleared:
    "bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-200 dark:border-emerald-500/20",
  bounced: "bg-destructive/10 text-destructive border-destructive/20",
  cancelled: "bg-muted text-muted-foreground border-border",
  resolved: "bg-muted text-foreground border-border",
};

const ACTION_LABELS: Record<ChequeAction, string> = {
  deposit: "واگذاری به بانک",
  endorse: "ظهرنویسی",
  clear: "وصول",
  present: "پاس شد",
  bounce: "برگشت خورد",
  cancel: "ابطال",
  settle: "تسویه نقدی/بانکی",
  restore: "بازگشت به حساب طرف",
};

const ACTION_HINT: Record<ChequeAction, string> = {
  deposit: "به حساب در جریان وصول می‌رود",
  endorse: "به تأمین‌کننده واگذار می‌شود",
  clear: "به حساب بانک واریز می‌شود",
  present: "از بانک کسر می‌شود",
  bounce: "برگشتی ثبت می‌شود؛ در صورت نیاز کارمزد بانکی هم ثبت می‌شود",
  cancel: "بدون اثر بانکی ابطال می‌شود",
  settle: "مبلغ چک برگشتی از حساب چک‌های برگشتی به بانک منتقل می‌شود",
  restore:
    "مانده چک برگشتی به حساب طرف برمی‌گردد؛ چک جایگزین پس از آن مثل یک چک عادی ثبت می‌شود",
};

const DIRECTION_META: Record<
  ChequeDirection,
  { label: string; short: string; hint: string; icon: typeof WalletIcon }
> = {
  receivable: {
    label: "چک‌های دریافتی",
    short: "دریافتی",
    hint: "از مشتریان — نزد صندوق",
    icon: HandCoinsIcon,
  },
  payable: {
    label: "چک‌های صادرشده",
    short: "صادرشده",
    hint: "به تأمین‌کنندگان — در جریان",
    icon: FileTextIcon,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  return Math.floor((db - da) / 86_400_000);
}

function dueState(
  dueDate: string,
  status: ChequeStatus,
): "overdue" | "due_soon" | "ok" | "terminal" {
  if (["cleared", "bounced", "cancelled"].includes(status)) return "terminal";
  const t = todayIsoDate();
  const diff = daysBetween(t, dueDate); // negative = overdue
  if (diff < 0) return "overdue";
  if (diff <= 7) return "due_soon";
  return "ok";
}

function errorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    invalid_amount: "مبلغ معتبر نیست.",
    invalid_direction: "نوع چک معتبر نیست.",
    invalid_action: "این عملیات روی چک تعریف نشده است.",
    invalid_cheque_transition:
      "این تغییر وضعیت ممکن نیست؛ چک قبلاً تغییر کرده است.",
    cheque_not_found: "چک پیدا نشد.",
    duplicate_cheque:
      "چکی با همین شماره و بانک (یا همین شناسه صیاد) قبلاً ثبت شده است.",
    invalid_sayad_id: "شناسه صیاد باید ۱۶ رقم باشد.",
    serial_number_required: "شماره چک الزامی است.",
    bank_name_required: "نام بانک الزامی است.",
    counterparty_name_required: "نام طرف چک الزامی است.",
    due_date_required: "تاریخ سررسید الزامی است.",
    invalid_issue_date: "تاریخ دریافت/صدور معتبر نیست.",
    invalid_due_date: "تاریخ سررسید معتبر نیست.",
    due_date_before_issue: "سررسید نمی‌تواند پیش از تاریخ دریافت/صدور باشد.",
    invalid_occurred_on: "تاریخ وقوع معتبر نیست.",
    action_before_issue: "تاریخ این اقدام نمی‌تواند پیش از تاریخ دریافت/صدور باشد.",
    action_before_previous_event:
      "تاریخ این اقدام نمی‌تواند پیش از تاریخ آخرین رویداد ثبت‌شده چک باشد.",
    invalid_fee_amount: "مبلغ کارمزد معتبر نیست.",
    fee_not_supported_for_action: "ثبت کارمزد فقط هنگام برگشت چک ممکن است.",
    invalid_location: "شعبه انتخاب‌شده معتبر نیست.",
    invalid_counterparty_for_direction: "طرف حساب انتخاب‌شده با نوع چک هم‌خوانی ندارد.",
    network_error: "ارتباط با سرور برقرار نشد. اتصال شبکه را بررسی و دوباره تلاش کنید.",
    customer_not_found: "مشتری انتخاب‌شده معتبر نیست.",
    supplier_not_found: "تأمین‌کننده انتخاب‌شده معتبر نیست.",
    supplier_required:
      "انتخاب تأمین‌کننده الزامی است؛ یا «ثبت بدون اتصال به طرف حساب» را انتخاب کنید.",
    customer_required: "انتخاب مشتری الزامی است؛ یا «ثبت بدون اتصال به طرف حساب» را انتخاب کنید.",
    invalid_status: "وضعیت انتخاب‌شده معتبر نیست.",
    replaced_cheque_not_found: "چک برگشتی مرجع پیدا نشد.",
    replaced_cheque_not_returned: "فقط چک برگشتی را می‌توان با چک جدید جایگزین کرد.",
    replaced_cheque_not_restored:
      "ابتدا باید مانده چک برگشتی با «بازگشت به حساب طرف» تعیین‌تکلیف شود؛ سپس چک جایگزین ثبت می‌شود.",
    replaced_cheque_other_branch: "چک جایگزین باید در همان شعبهٔ چک برگشتی ثبت شود.",
    replaced_cheque_other_party: "چک جایگزین باید به همان طرف حساب چک برگشتی متصل باشد.",
    replacement_before_resolution:
      "تاریخ چک جایگزین نمی‌تواند پیش از تاریخ تعیین‌تکلیف چک برگشتی باشد.",
    replacement_exceeds_original:
      "مجموع چک‌های جایگزین نمی‌تواند از مبلغ چک برگشتی بیشتر شود.",
    idempotency_key_conflict:
      "این درخواست با همان شناسهٔ تکرار ولی اطلاعات متفاوت ارسال شده است؛ صفحه را تازه کنید.",
    invalid_due_from: "تاریخ شروع بازهٔ سررسید معتبر نیست.",
    invalid_due_to: "تاریخ پایان بازهٔ سررسید معتبر نیست.",
    invalid_due_range: "پایان بازهٔ سررسید نمی‌تواند پیش از شروع آن باشد.",
    ledger_account_missing: "یکی از حساب‌های مورد نیاز در سرفصل یافت نشد.",
    fiscal_period_locked: "دوره مالی این تاریخ قفل است.",
    fiscal_period_soft_closed:
      "دوره مالی نیمه‌بسته است؛ فقط مالک یا حسابدار می‌تواند ثبت کند.",
    bad_request: "درخواست نامعتبر بود.",
    unauthorized: "وارد نشده‌اید.",
    forbidden: "دسترسی مجاز نیست.",
  };
  // Never fall back to the raw code: `duplicate_cheque` is an instruction, but
  // an unmapped English identifier is noise a treasurer cannot act on.
  return map[code ?? ""] ?? "خطای غیرمنتظره. دوباره تلاش کنید.";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function ChequesSection({
  busy,
  run,
  canManage,
}: {
  busy: boolean;
  /**
   * Whether this member holds `finance.cheques_manage`. A `ledger.view`-only
   * accountant reads the register, its filters and every cheque's history, and
   * is shown no control that would only come back 403 from the API — the API
   * check stays authoritative either way.
   */
  canManage: boolean;
  run: (
    fn: () => Promise<{ ok: boolean; data: { error?: string } }>,
  ) => Promise<boolean>;
}) {
  const money = useMoney();
  const [direction, setDirection] = useState<ChequeDirection>("receivable");
  const [cheques, setCheques] = useState<Cheque[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [customers, setCustomers] = useState<Counterparty[]>([]);
  const [suppliers, setSuppliers] = useState<Counterparty[]>([]);
  const [counterpartyLoadError, setCounterpartyLoadError] = useState("");

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [bankFilter, setBankFilter] = useState<string>("all");
  const [branchFilter, setBranchFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<string>("due_asc");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");
  /** Rows loaded so far: the first page plus every appended one. */
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState("");
  const [summary, setSummary] = useState<ChequeSummary | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [banks, setBanks] = useState<string[]>([]);
  const [branches, setBranches] = useState<Counterparty[]>([]);

  const [createOpen, setCreateOpen] = useState(false);
  /** The returned cheque a «ثبت چک جایگزین» was started from, if any. */
  const [replacing, setReplacing] = useState<Cheque | null>(null);
  const [detail, setDetail] = useState<Cheque | null>(null);
  const [action, setAction] = useState<{
    cheque: Cheque;
    act: ChequeAction;
  } | null>(null);

  const [localError, setLocalError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");

  /*
   * Fetch. Searching, filtering, sorting and paging are the server's job (a
   * large tenant's register is not a download), so every one of them is a
   * query parameter.
   *
   * Paging *appends*. The first version asked for `limit = 50 × page` with no
   * offset, which the service caps at 200 — so «بیشتر» silently stopped
   * working at the fourth page and the rows the reader already had were
   * blanked on every press. Now each press asks for the next window by
   * offset, over an ordering that ends in the row id (unique, so no row can
   * be skipped or repeated across pages), and the rows already on screen stay
   * on screen while it loads.
   *
   * `requestRef` is the staleness guard: every filter change and every append
   * takes the next ticket, and a response that is not holding the current
   * ticket is dropped — a slow payable answer can never paint under the
   * receivable tab, and a slow page 2 can never land after a filter reset.
   */
  const requestRef = useRef(0);

  const queryFor = useCallback(
    (offset: number) => {
      const params = new URLSearchParams({
        direction,
        sort: sortBy,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (deferredQuery.trim()) params.set("q", deferredQuery.trim());
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (bankFilter !== "all") params.set("bank", bankFilter);
      if (branchFilter !== "all") params.set("locationId", branchFilter);
      if (dueFrom) params.set("dueFrom", dueFrom);
      if (dueTo) params.set("dueTo", dueTo);
      return params;
    },
    [direction, sortBy, deferredQuery, statusFilter, bankFilter, branchFilter, dueFrom, dueTo],
  );

  const applyPage = useCallback(
    (data: ChequePage) => {
      setSummary(data.summary ?? null);
      setTotal(data.total ?? 0);
      setHasMore(Boolean(data.hasMore));
      setBanks((previous) =>
        bankFilter !== "all" && !(data.banks ?? []).includes(bankFilter)
          ? Array.from(new Set([...(data.banks ?? []), bankFilter]))
          : (data.banks ?? previous),
      );
    },
    [bankFilter],
  );

  // First page: filters changed, so the register restarts.
  useEffect(() => {
    const ticket = ++requestRef.current;
    setCheques(null);
    setLoadError("");
    setMoreError("");
    void api<ChequePage>(`/api/ledger/cheques?${queryFor(0)}`).then(({ ok, data }) => {
      if (requestRef.current !== ticket) return;
      if (ok && Array.isArray(data.cheques)) {
        setCheques(data.cheques);
        applyPage(data);
      } else {
        // Do not turn a failed request into the false claim that there are no
        // cheques. Keeping this null selects an explicit retry state below.
        setLoadError("بارگذاری فهرست چک‌ها ناموفق بود. دوباره تلاش کنید.");
      }
    });
  }, [queryFor, applyPage, refreshKey]);

  /** One more window, appended — the rows already read stay put. */
  const loadMore = useCallback(() => {
    if (loadingMore) return;
    const offset = cheques?.length ?? 0;
    const ticket = ++requestRef.current;
    setLoadingMore(true);
    setMoreError("");
    void api<ChequePage>(`/api/ledger/cheques?${queryFor(offset)}`).then(({ ok, data }) => {
      if (requestRef.current !== ticket) return;
      setLoadingMore(false);
      if (ok && Array.isArray(data.cheques)) {
        // Belt and braces against a duplicate the server could only produce
        // if a row were inserted mid-scroll: identity wins over position.
        setCheques((previous) => {
          const seen = new Set((previous ?? []).map((c) => c.id));
          return [...(previous ?? []), ...data.cheques!.filter((c) => !seen.has(c.id))];
        });
        applyPage(data);
      } else {
        // The page that failed is retryable on its own: the reader does not
        // lose the register because one request did.
        setMoreError("بارگذاری ادامهٔ فهرست ناموفق بود.");
      }
    });
  }, [cheques, loadingMore, queryFor, applyPage]);

  // Branch context only means something to a business that has branches.
  useEffect(() => {
    let current = true;
    void api<{ locations?: { id: string; name: string }[] }>("/api/locations/active").then(
      ({ ok, data }) => {
        if (!current || !ok || !Array.isArray(data.locations)) return;
        setBranches(data.locations.map((l) => ({ id: l.id, name: l.name })));
      },
    );
    return () => {
      current = false;
    };
  }, []);

  // Statuses belong to one direction. Keeping a receivable-only status selected
  // when moving to payables produced an unexplained blank register.
  useEffect(() => {
    setStatusFilter("all");
    setBankFilter("all");
    setQuery("");
    setDueFrom("");
    setDueTo("");
  }, [direction]);

  /*
   * `?scope=directory` — every customer and every supplier record, not only the
   * ones carrying an open balance. A cheque is very often the *first* document
   * with a counterparty (a deposit cheque from a new customer, a cheque written
   * to a supplier we owe nothing to yet), and the balances list also carries the
   * «بدون … مشخص» bucket, whose id is the sentinel `"unknown"` rather than a
   * uuid — picking it used to fail with an unexplained server error.
   */
  useEffect(() => {
    let current = true;
    setCounterpartyLoadError("");
    void Promise.all([
      api<{ customers?: { customerId: string; customerName: string }[] }>(
        "/api/ledger/ar/customers?scope=directory",
      ),
      api<{ suppliers?: { supplierId: string; supplierName: string }[] }>(
        "/api/ledger/ap/suppliers?scope=directory",
      ),
    ]).then(([customerResult, supplierResult]) => {
      if (!current) return;
      if (customerResult.ok && Array.isArray(customerResult.data.customers)) {
        setCustomers(
          customerResult.data.customers.map((c) => ({
            id: c.customerId,
            name: c.customerName,
          })),
        );
      }
      if (supplierResult.ok && Array.isArray(supplierResult.data.suppliers)) {
        setSuppliers(
          supplierResult.data.suppliers.map((s) => ({
            id: s.supplierId,
            name: s.supplierName,
          })),
        );
      }
      if (
        !customerResult.ok ||
        !supplierResult.ok ||
        !Array.isArray(customerResult.data.customers) ||
        !Array.isArray(supplierResult.data.suppliers)
      ) {
        setCounterpartyLoadError(
          "فهرست مشتریان یا تأمین‌کنندگان کامل بارگذاری نشد. برای انتخاب طرف حساب، فهرست را نوسازی کنید.",
        );
      }
    });
    return () => {
      current = false;
    };
  }, [refreshKey]);

  // The register the server returned is already filtered, sorted and paged:
  // nothing is re-filtered here, so what the KPIs count and what the table
  // shows can no longer disagree.
  const filtered = cheques ?? [];

  // KPIs — the server's accounting-aware totals for the whole filtered set,
  // not a count of the rows that happen to be loaded. Note what each one is:
  // «outstanding» excludes an endorsed cheque (endorsement already paid the
  // supplier) and a returned one (its value sits in چک‌های برگشتی and has its
  // own tile until it is resolved).
  const kpis = summary
    ? {
        totalActive: summary.outstanding.total,
        activeCount: summary.outstanding.count,
        totalOverdue: summary.overdue.total,
        overdueCount: summary.overdue.count,
        dueSoonCount: summary.dueSoon.count,
        totalReturned: summary.returnedUnresolved.total,
        returnedCount: summary.returnedUnresolved.count,
        settledCount: summary.settled.count,
        totalCount: total,
      }
    : null;

  async function doAction(
    cheque: Cheque,
    act: ChequeAction,
    body: Record<string, unknown> = {},
  ) {
    setLocalError("");
    setActionError("");
    // One key per confirmed action, reused if `run` retries: a lost response
    // must not be able to post the step twice.
    const idempotencyKey = crypto.randomUUID();
    let response: { ok: boolean; data: { error?: string } } | undefined;
    const ok = await run(async () => {
      response = await api<{ error?: string }>(`/api/ledger/cheques/${cheque.id}/${act}`, {
        method: "POST",
        // `api()` lets init.headers replace its default, so the content type
        // has to be restated here.
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      return response;
    });
    if (ok) {
      setAction(null);
      setDetail(null);
      setRefreshKey((k) => k + 1);
    } else {
      setActionError(errorMessage(response?.data.error));
    }
  }

  // One gate, used everywhere a control is drawn: a read-only member is shown
  // the register, not a dialog that would be refused on submit.
  const actionsFor = useCallback(
    (cheque: Cheque): ChequeAction[] =>
      canManage ? availableActions(cheque.direction, cheque.status) : [],
    [canManage],
  );

  const openCreate = useCallback(() => {
    if (!canManage) return;
    setLocalError("");
    setReplacing(null);
    setCreateOpen(true);
  }, [canManage]);

  /**
   * Registering the cheque a counterparty hands over after one bounced. The
   * accounting is the ordinary registration's — what makes it a replacement
   * is the recorded link, which is what the history drills through.
   */
  const openReplacement = useCallback(
    (cheque: Cheque) => {
      if (!canManage) return;
      setLocalError("");
      setDetail(null);
      setReplacing(cheque);
      setCreateOpen(true);
    },
    [canManage],
  );

  const openAction = useCallback((cheque: Cheque, act: ChequeAction) => {
    if (!canManage) return;
    setLocalError("");
    setActionError("");
    // Never stack a second modal on the detail modal — that traps focus between
    // two dialogs on keyboard and makes the close affordance ambiguous.
    setDetail(null);
    setAction({ cheque, act });
  }, [canManage]);

  return (
    <div className="space-y-4" dir="rtl">
      {/* Header card */}
      <Card>
        <CardHeader className="gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <LandmarkIcon className="size-4" />
              </span>
              <CardTitle className="text-base">مدیریت چک‌ها</CardTitle>
              <Badge variant="secondary" className="hidden font-normal sm:inline-flex">
                اسناد دریافتنی و پرداختنی
              </Badge>
            </div>
            <CardDescription className="mt-2 max-w-3xl leading-6">
              چک‌های دریافتی و صادرشده، سررسید و هر مرحله از وصول یا ظهرنویسی —
              هر مرحله سند حسابداری خودش را ثبت می‌کند. تغییر وضعیت بر پایه جدول
              انتقال سرور انجام می‌شود، نه حدس رابط.
            </CardDescription>
          </div>
          <CardAction className="flex flex-wrap items-center gap-2 self-start">
            {canManage ? (
              <Button onClick={openCreate} className="gap-1.5">
                <PlusIcon className="size-4" />
                ثبت چک جدید
              </Button>
            ) : (
              <Badge variant="secondary" className="font-normal">
                دسترسی فقط خواندنی
              </Badge>
            )}
          </CardAction>
        </CardHeader>

        {/* KPI strip */}
        {kpis ? (
          <CardContent className="pt-0">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <ChequeToneTile
                icon={WalletIcon}
                label={
                  direction === "receivable"
                    ? "مانده فعال دریافتی"
                    : "مانده صادرشده فعال"
                }
                value={money.format(kpis.totalActive)}
                hint={`${toPersianDigits(kpis.activeCount)} فقره — از ${toPersianDigits(kpis.totalCount)} کل`}
                tone="primary"
              />
              <ChequeToneTile
                icon={AlertTriangleIcon}
                label="سررسید گذشته"
                value={money.format(kpis.totalOverdue)}
                hint={`${toPersianDigits(kpis.overdueCount)} فقره نیاز به پیگیری`}
                tone={kpis.overdueCount > 0 ? "destructive" : "muted"}
              />
              <ChequeToneTile
                icon={AlertTriangleIcon}
                label={
                  direction === "receivable"
                    ? "چک‌های برگشتی تعیین‌تکلیف‌نشده"
                    : "چک‌های برگشتی پرداختنی"
                }
                value={money.format(kpis.totalReturned)}
                hint={
                  kpis.returnedCount > 0
                    ? `${toPersianDigits(kpis.returnedCount)} فقره — مانده در حساب چک‌های برگشتی`
                    : "موردی باز نیست"
                }
                tone={kpis.returnedCount > 0 ? "destructive" : "muted"}
              />
              <ChequeToneTile
                icon={Clock3Icon}
                label="۷ روز آینده"
                value={toPersianDigits(kpis.dueSoonCount) + " فقره"}
                hint="سررسید در هفته جاری"
                tone="amber"
              />
              <ChequeToneTile
                icon={CheckCircle2Icon}
                label="تعیین‌تکلیف‌شده"
                value={toPersianDigits(kpis.settledCount) + " فقره"}
                hint={`وصول‌شده، ابطال‌شده یا تعیین‌تکلیف‌شده — از ${toPersianDigits(kpis.totalCount)} فقره`}
                tone="muted"
              />
            </div>

            {/* Where the register's value actually sits. Each line names the
                control account it reconciles to, so "the register says X"
                and "the ledger says X" are the same claim. */}
            {summary ? (
              <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {categoryBreakdown(direction, summary).map((row) => (
                  <li
                    key={row.key}
                    className="flex items-center justify-between gap-2 rounded-lg border bg-background/60 px-3 py-2"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium">{row.label}</span>
                      <span className="block text-[11px] text-muted-foreground" dir="rtl">
                        {row.account}
                      </span>
                    </span>
                    <span className="shrink-0 text-end">
                      <span className="block text-xs font-semibold tabular-nums">
                        {money.format(row.bucket.total)}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        {toPersianDigits(row.bucket.count)} فقره
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            {/* Due-date distribution — counts only live cheques, so a cleared
                item does not masquerade as an upcoming one. */}
            <div className="mt-4 rounded-xl border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">
                  نمای سررسید چک‌های باز
                </p>
                <span className="text-xs text-muted-foreground">
                  {toPersianDigits(kpis.activeCount)} فقره در کل ثبت
                </span>
              </div>
              <div
                role="img"
                className="mt-2 flex h-2 overflow-hidden rounded-full bg-muted"
                aria-label={`سررسید ${toPersianDigits(kpis.overdueCount)} فقره گذشته، ${toPersianDigits(kpis.dueSoonCount)} فقره در هفت روز آینده`}
              >
                {kpis.activeCount > 0 ? (
                  <>
                    {kpis.overdueCount > 0 ? (
                      <span
                        className="bg-destructive"
                        style={{ width: `${(kpis.overdueCount / kpis.activeCount) * 100}%` }}
                      />
                    ) : null}
                    {kpis.dueSoonCount > 0 ? (
                      <span
                        className="bg-amber-500 dark:bg-amber-400"
                        style={{ width: `${(kpis.dueSoonCount / kpis.activeCount) * 100}%` }}
                      />
                    ) : null}
                    <span className="flex-1 bg-primary/20" />
                  </>
                ) : (
                  <span className="w-full bg-muted" />
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-destructive" /> سررسید
                  گذشته
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-amber-500 dark:bg-amber-400" />{" "}
                  هفته جاری
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-primary/40" /> آتی
                </span>
              </div>
            </div>
          </CardContent>
        ) : null}
      </Card>

      {/* Filters + Tabs */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          {/* Search + selects */}
          <div className="grid gap-3 lg:grid-cols-[1.4fr_0.9fr_0.9fr_0.9fr_0.9fr]">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute end-auto start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="جستجو: نام، بانک، شماره چک، صیاد، یادداشت…"
                aria-label="جستجوی چک‌ها"
                className="ps-9"
              />
            </div>

            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger aria-label="فیلتر وضعیت چک">
                <SelectValue placeholder="وضعیت" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">همه وضعیت‌ها</SelectItem>
                {STATUS_GROUP_OPTIONS.map((group) => (
                  <SelectItem key={group.value} value={group.value}>
                    {group.label}
                  </SelectItem>
                ))}
                {availableStatusesFor(direction).map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={bankFilter} onValueChange={setBankFilter}>
              <SelectTrigger aria-label="فیلتر بانک">
                <SelectValue placeholder="بانک" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">همه بانک‌ها</SelectItem>
                {banks.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {branches.length > 1 ? (
              <Select value={branchFilter} onValueChange={setBranchFilter}>
                <SelectTrigger aria-label="فیلتر شعبه">
                  <SelectValue placeholder="شعبه" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">همه شعب</SelectItem>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}

            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger aria-label="مرتب‌سازی چک‌ها">
                <SelectValue placeholder="مرتب‌سازی" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="due_asc">سررسید ↑ نزدیک‌ترین</SelectItem>
                <SelectItem value="due_desc">سررسید ↓ دورترین</SelectItem>
                <SelectItem value="amount_desc">مبلغ ↓ بیشترین</SelectItem>
                <SelectItem value="amount_asc">مبلغ ↑ کمترین</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* The treasurer's question: what falls due between these two dates.
              Shamsi throughout — the wire carries ISO, the reader never sees
              it — and validated again on the server. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:w-2/3">
            <div className="flex items-center gap-2">
              <span id="cheque-due-from-label" className="shrink-0 text-xs text-muted-foreground">
                سررسید از
              </span>
              <JalaliDatePicker
                value={dueFrom}
                onChange={setDueFrom}
                labelledBy="cheque-due-from-label"
                placeholder="بدون محدودیت"
                className="flex-1"
              />
            </div>
            <div className="flex items-center gap-2">
              <span id="cheque-due-to-label" className="shrink-0 text-xs text-muted-foreground">
                تا
              </span>
              <JalaliDatePicker
                value={dueTo}
                onChange={setDueTo}
                labelledBy="cheque-due-to-label"
                placeholder="بدون محدودیت"
                className="flex-1"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(query || statusFilter !== "all" || bankFilter !== "all" || branchFilter !== "all" || dueFrom || dueTo) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setStatusFilter("all");
                  setBankFilter("all");
                  setBranchFilter("all");
                  setDueFrom("");
                  setDueTo("");
                }}
                className="h-7 gap-1.5 px-2.5 text-xs"
              >
                <XIcon className="size-3.5" />
                پاک کردن فیلترها
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
              {cheques === null
                ? "در حال بارگذاری…"
                : `${toPersianDigits(filtered.length)} از ${toPersianDigits(total)} چک`}
              {direction === "receivable" ? " دریافتی" : " صادرشده"}
            </span>
            <Separator orientation="vertical" className="mx-1 h-4" />
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <FilterIcon className="size-3.5" /> جستجو، وضعیت، بانک، شعبه و
              بازهٔ سررسید روی سرور اعمال می‌شود
            </span>
          </div>

          {/* Direction tabs */}
          <Tabs
            value={direction}
            onValueChange={(v) => setDirection(v as ChequeDirection)}
            dir="rtl"
          >
            <TabsList className="w-full justify-start">
              {(["receivable", "payable"] as const).map((dir) => {
                const meta = DIRECTION_META[dir];
                const Icon = meta.icon;
                return (
                  <TabsTrigger
                    key={dir}
                    value={dir}
                    className="gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                  >
                    <Icon className="size-4" />
                    {meta.label}
                  </TabsTrigger>
                );
              })}
            </TabsList>

            <TabsContent value={direction} className="mt-4 space-y-3">
              {localError ? (
                <Alert variant="destructive">
                  <AlertTriangleIcon className="size-4" />
                  <AlertTitle>خطا</AlertTitle>
                  <AlertDescription>{localError}</AlertDescription>
                </Alert>
              ) : null}

              {cheques === null ? (
                loadError ? (
                  <ChequeLoadError
                    message={loadError}
                    onRetry={() => setRefreshKey((key) => key + 1)}
                  />
                ) : (
                  <ChequesSkeleton />
                )
              ) : filtered.length === 0 ? (
                <EmptyCheques
                  onCreate={openCreate}
                  hasAny={cheques.length > 0}
                  direction={direction}
                />
              ) : (
                <>
                  {/* Desktop table */}
                  <div className="hidden overflow-hidden rounded-xl border lg:block">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-muted/50 hover:bg-muted/50">
                          <TableHead className="w-[22%]">طرف حساب</TableHead>
                          <TableHead>بانک / شماره</TableHead>
                          <TableHead>سررسید</TableHead>
                          <TableHead>مبلغ</TableHead>
                          <TableHead>وضعیت</TableHead>
                          <TableHead className="text-end">اقدام</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filtered.map((c) => {
                          const ds = dueState(c.dueDate, c.status);
                          return (
                            <TableRow
                              key={c.id}
                              className={
                                ds === "overdue"
                                  ? "bg-destructive/[0.03] hover:bg-destructive/[0.06]"
                                  : undefined
                              }
                            >
                              <TableCell>
                                <div className="min-w-0">
                                  <p className="truncate font-medium">
                                    {c.counterpartyName}
                                  </p>
                                  <p className="truncate text-xs text-muted-foreground">
                                    {c.direction === "receivable" ? "دریافت" : "صدور"}{" "}
                                    {toPersianDigits(formatJalali(c.issueDate))}{" "}
                                    {c.memo ? `· ${c.memo}` : ""}
                                  </p>
                                </div>
                              </TableCell>
                              <TableCell>
                                <div className="min-w-0">
                                  <p className="flex items-center gap-1.5 text-sm">
                                    <LandmarkIcon className="size-3.5 shrink-0 text-muted-foreground" />
                                    <span className="truncate">
                                      {c.bankName}
                                    </span>
                                  </p>
                                  <p
                                    className="flex items-center gap-1.5 text-xs text-muted-foreground"
                                    dir="ltr"
                                  >
                                    <HashIcon className="size-3 h-3 shrink-0" />
                                    <span className="truncate">
                                      {toPersianDigits(c.serialNumber)}
                                    </span>
                                    {c.sayadId ? (
                                      <span className="truncate">
                                        · {toPersianDigits(c.sayadId)}
                                      </span>
                                    ) : null}
                                  </p>
                                </div>
                              </TableCell>
                              <TableCell>
                                <div className="space-y-1">
                                  <span className="inline-flex items-center gap-1.5 text-sm">
                                    <CalendarDaysIcon className="size-3.5 text-muted-foreground" />
                                    {toPersianDigits(formatJalali(c.dueDate))}
                                  </span>
                                  {ds === "overdue" ? (
                                    <Badge
                                      variant="destructive"
                                      className="gap-1"
                                    >
                                      <AlertTriangleIcon className="size-3" />
                                      {toPersianDigits(
                                        String(
                                          Math.abs(
                                            daysBetween(c.dueDate, todayIsoDate()),
                                          ),
                                        ),
                                      )}{" "}
                                      روز گذشته
                                    </Badge>
                                  ) : ds === "due_soon" ? (
                                    <Badge
                                      variant="secondary"
                                      className="gap-1 bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200"
                                    >
                                      <Clock3Icon className="size-3" />
                                      {toPersianDigits(
                                        String(
                                          daysBetween(todayIsoDate(), c.dueDate),
                                        ),
                                      )}{" "}
                                      روز مانده
                                    </Badge>
                                  ) : null}
                                </div>
                              </TableCell>
                              <TableCell className="font-medium tabular-nums">
                                {money.format(c.amount)}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className={`gap-1 border ${STATUS_TONE[c.status]}`}
                                >
                                  {STATUS_LABELS[c.status]}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-end">
                                <div className="flex justify-end gap-1">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 px-2.5"
                                    onClick={() => setDetail(c)}
                                  >
                                    <EyeIcon className="size-4" />
                                    جزئیات
                                  </Button>
                                  <ChequeRowActions
                                    cheque={c}
                                    actions={actionsFor(c)}
                                    busy={busy}
                                    onAction={(act) => openAction(c, act)}
                                    onDetail={() => setDetail(c)}
                                  />
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                      <TableFooter>
                        <TableRow>
                          <TableCell colSpan={3} className="font-medium">
                            جمع ردیف‌های نمایش‌داده‌شده
                          </TableCell>
                          <TableCell className="font-bold tabular-nums">
                            {money.format(
                              filtered.reduce((s, c) => s + c.amount, 0),
                            )}
                          </TableCell>
                          <TableCell
                            colSpan={2}
                            className="text-xs text-muted-foreground"
                          >
                            {toPersianDigits(filtered.length)} از{" "}
                            {toPersianDigits(total)} فقره
                          </TableCell>
                        </TableRow>
                      </TableFooter>
                    </Table>
                  </div>

                  {/* Mobile cards */}
                  <div className="grid gap-3 lg:hidden">
                    {filtered.map((c) => {
                      const ds = dueState(c.dueDate, c.status);
                      return (
                        <Card
                          key={c.id}
                          className={`overflow-hidden ${ds === "overdue" ? "border-destructive/30" : ""}`}
                        >
                          <CardHeader className="pb-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <CardTitle className="truncate text-sm">
                                  {c.counterpartyName}
                                </CardTitle>
                                <CardDescription className="flex items-center gap-1.5 truncate">
                                  <Building2Icon className="size-3.5 shrink-0" />
                                  {c.bankName} ·{" "}
                                  {toPersianDigits(c.serialNumber)}
                                </CardDescription>
                              </div>
                              <Badge
                                variant="outline"
                                className={`shrink-0 border text-xs ${STATUS_TONE[c.status]}`}
                              >
                                {STATUS_LABELS[c.status]}
                              </Badge>
                            </div>
                          </CardHeader>
                          <CardContent className="space-y-3 pt-0">
                            <div className="grid grid-cols-2 gap-3 rounded-lg bg-muted/40 p-3">
                              <div>
                                <p className="text-xs text-muted-foreground">
                                  مبلغ
                                </p>
                                <p className="mt-1 font-bold tabular-nums">
                                  {money.format(c.amount)}
                                </p>
                              </div>
                              <div>
                                <p className="text-xs text-muted-foreground">
                                  سررسید
                                </p>
                                <p className="mt-1 flex items-center gap-1 text-sm font-medium">
                                  <CalendarDaysIcon className="size-3.5 text-muted-foreground" />
                                  {toPersianDigits(formatJalali(c.dueDate))}
                                </p>
                              </div>
                              {c.sayadId ? (
                                <div className="col-span-2">
                                  <p className="text-xs text-muted-foreground">
                                    شناسه صیاد
                                  </p>
                                  <p
                                    className="mt-1 font-mono text-xs"
                                    dir="ltr"
                                  >
                                    {toPersianDigits(c.sayadId)}
                                  </p>
                                </div>
                              ) : null}
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                              <span>
                                {c.direction === "receivable" ? "دریافت" : "صدور"}{" "}
                                {toPersianDigits(formatJalali(c.issueDate))}
                              </span>
                              <span>·</span>
                              {ds === "overdue" ? (
                                <Badge variant="destructive" className="gap-1">
                                  <AlertTriangleIcon className="size-3" />{" "}
                                  سررسید گذشته
                                </Badge>
                              ) : ds === "due_soon" ? (
                                <Badge
                                  variant="secondary"
                                  className="bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200"
                                >
                                  به‌زودی
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="gap-1">
                                  <Clock3Icon className="size-3" />{" "}
                                  {toPersianDigits(
                                    String(
                                      Math.max(
                                        0,
                                        daysBetween(todayIsoDate(), c.dueDate),
                                      ),
                                    ),
                                  )}{" "}
                                  روز مانده
                                </Badge>
                              )}
                            </div>

                            {c.memo ? (
                              <p className="rounded-lg border bg-card px-3 py-2 text-xs leading-5 text-muted-foreground">
                                {c.memo}
                              </p>
                            ) : null}

                            <div className="flex flex-wrap gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                className="flex-1"
                                onClick={() => setDetail(c)}
                              >
                                <EyeIcon className="size-4" /> جزئیات و تاریخچه
                              </Button>
                              <ChequeRowActions
                                cheque={c}
                                actions={actionsFor(c)}
                                busy={busy}
                                onAction={(act) => openAction(c, act)}
                                onDetail={() => setDetail(c)}
                              />
                            </div>

                            {actionsFor(c).length > 0 ? (
                              <div className="flex flex-wrap gap-1.5 border-t pt-3">
                                {actionsFor(c).map(
                                  (act) => (
                                    <Button
                                      key={act}
                                      size="sm"
                                      variant={
                                        act === "bounce" || act === "cancel"
                                          ? "destructive"
                                          : act === "clear" || act === "present"
                                            ? "default"
                                            : "secondary"
                                      }
                                      className="h-8 flex-1 text-xs"
                                      disabled={busy}
                                      onClick={() => openAction(c, act)}
                                    >
                                      {ACTION_LABELS[act]}
                                    </Button>
                                  ),
                                )}
                              </div>
                            ) : null}
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>

                  {hasMore || moreError ? (
                    <div className="flex flex-col items-center gap-2 pt-4">
                      {moreError ? (
                        <p className="text-xs text-destructive" role="alert">
                          {moreError}
                        </p>
                      ) : null}
                      <Button
                        variant="outline"
                        onClick={loadMore}
                        disabled={cheques === null || loadingMore}
                        aria-busy={loadingMore}
                      >
                        {loadingMore
                          ? "در حال بارگذاری…"
                          : moreError
                            ? "تلاش دوباره"
                            : `نمایش ${toPersianDigits(PAGE_SIZE)} مورد بیشتر`}
                      </Button>
                    </div>
                  ) : null}
                </>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>

        <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/30 py-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <TrendingUpIcon className="size-3.5" />
            هر تغییر وضعیت سند حسابداری خودش را ثبت می‌کند؛ برگشت چک‌های
            واگذارشده بدهی تأمین‌کننده را برمی‌گرداند.
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            نوسازی فهرست
          </Button>
        </CardFooter>
      </Card>

      {/* Create dialog — never mounted for a read-only member. */}
      {canManage ? (
      <CreateChequeDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) {
            setLocalError("");
            setReplacing(null);
          }
        }}
        direction={direction}
        replaces={replacing}
        customers={customers}
        suppliers={suppliers}
        counterpartyLoadError={counterpartyLoadError}
        busy={busy}
        onCreated={() => {
          setCreateOpen(false);
          setReplacing(null);
          setRefreshKey((k) => k + 1);
        }}
        run={run}
        onError={setLocalError}
      />
      ) : null}

      {/* Detail dialog */}
      {detail ? (
        <ChequeDetailDialog
          cheque={detail}
          onClose={() => setDetail(null)}
          actions={actionsFor(detail)}
          onAction={(act) => openAction(detail, act)}
          onReplace={canManage ? () => openReplacement(detail) : undefined}
          suppliers={suppliers}
          money={money}
          busy={busy}
        />
      ) : null}

      {/* Action dialog */}
      {action ? (
        <ChequeActionDialog
          cheque={action.cheque}
          action={action.act}
          suppliers={suppliers}
          supplierLoadError={counterpartyLoadError}
          busy={busy}
          error={actionError}
          onClose={() => {
            setActionError("");
            setAction(null);
          }}
          onConfirm={(body) => doAction(action.cheque, action.act, body)}
          onError={setActionError}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

/**
 * A *toned* summary tile — the cheque book's four status totals, each washed in
 * its own status colour (primary / destructive / amber / muted).
 *
 * Deliberately not page-chrome's `KpiCard`, which is the neutral white tile the
 * overview screens use: here the tile's fill *is* the status, so the two are
 * different components rather than one with a prop. Named apart so the
 * primitive lint can tell them apart too.
 */
function ChequeToneTile({
  icon: Icon,
  label,
  value,
  hint,
  tone = "muted",
}: {
  icon: typeof WalletIcon;
  label: string;
  value: string;
  hint?: string;
  tone?: "primary" | "destructive" | "amber" | "muted";
}) {
  const toneClass =
    tone === "primary"
      ? "bg-primary/10 text-primary border-primary/20"
      : tone === "destructive"
        ? "bg-destructive/10 text-destructive border-destructive/20"
        : tone === "amber"
          ? "bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/20"
          : "bg-muted text-muted-foreground border-border";
  return (
    <div className={`rounded-xl border p-4 ${toneClass}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/*
            Label and hint carry the tone's own colour at full strength. They
            used to be faded to 70–80% opacity, which on these tinted cards
            measured 2.6:1–3.5:1 (axe color-contrast) — 12px text a cashier
            could not read on a bright screen.
          */}
          <p className="text-xs font-medium">{label}</p>
          <p className="mt-2 truncate text-sm font-bold leading-5 sm:text-base">
            {value}
          </p>
          {hint ? (
            <p className="mt-1 text-xs leading-4">{hint}</p>
          ) : null}
        </div>
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-card/70 text-foreground/70">
          <Icon className="size-4" />
        </span>
      </div>
    </div>
  );
}

function ChequesSkeleton() {
  return (
    <div className="space-y-3">
      <div className="hidden lg:block">
        <div className="overflow-hidden rounded-xl border">
          <div className="space-y-0">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-4 border-b p-4 last:border-0"
              >
                <Skeleton className="h-10 w-28" />
                <Skeleton className="h-10 flex-1" />
                <Skeleton className="h-6 w-20" />
                <Skeleton className="h-8 w-24" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="grid gap-3 lg:hidden">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="p-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="mt-2 h-4 w-48" />
            <Skeleton className="mt-4 h-16 w-full" />
          </Card>
        ))}
      </div>
    </div>
  );
}

function ChequeLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert variant="destructive" className="items-start">
      <AlertTriangleIcon className="mt-0.5 size-4" />
      <div className="min-w-0 flex-1">
        <AlertTitle>فهرست چک‌ها در دسترس نیست</AlertTitle>
        <AlertDescription className="mt-1 flex flex-wrap items-center gap-3">
          <span>{message}</span>
          <Button variant="outline" size="sm" onClick={onRetry}>
            تلاش دوباره
          </Button>
        </AlertDescription>
      </div>
    </Alert>
  );
}

function EmptyCheques({
  onCreate,
  hasAny,
  direction,
}: {
  onCreate: () => void;
  hasAny: boolean;
  direction: ChequeDirection;
}) {
  const meta = DIRECTION_META[direction];
  return (
    <div className="rounded-xl border border-dashed bg-muted/20 px-6 py-10 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <FileTextIcon className="size-6" />
      </div>
      <h3 className="mt-4 text-sm font-semibold">
        {hasAny
          ? "موردی با این فیلتر یافت نشد"
          : `هنوز ${meta.label} ثبت نشده است`}
      </h3>
      <p className="mx-auto mt-2 max-w-md text-xs leading-5 text-muted-foreground">
        {hasAny
          ? "فیلترها را پاک کنید یا عبارت جستجو را تغییر دهید تا نتایج بیشتری ببینید."
          : direction === "receivable"
            ? "چک‌های دریافتی از مشتریان را با شماره، بانک، مبلغ و سررسید ثبت کنید. هر چک حساب دریافتنی را تسویه و در سررسید تعیین تکلیف می‌شود."
            : "چک‌های صادره به تأمین‌کنندگان را ثبت کنید؛ پاس شدن، برگشت یا ابطال هر چک سند خودش را می‌زند."}
      </p>
      {!hasAny ? (
        <Button onClick={onCreate} className="mt-4 gap-1.5">
          <PlusIcon className="size-4" />{" "}
          {direction === "receivable" ? "ثبت چک دریافتی" : "ثبت چک صادرشده"}
        </Button>
      ) : null}
    </div>
  );
}

function ChequeRowActions({
  cheque,
  actions,
  busy,
  onAction,
  onDetail,
}: {
  cheque: Cheque;
  /** Already gated: empty for a read-only member, so nothing is drawn. */
  actions: ChequeAction[];
  busy: boolean;
  onAction: (act: ChequeAction) => void;
  onDetail: () => void;
}) {
  if (actions.length === 0) return null;
  // On desktop we show a dropdown to keep the row tight
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1"
          disabled={busy}
        >
          اقدام
          <ChevronDownIcon className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel className="flex items-center gap-1.5 text-xs">
          <ArrowLeftRightIcon className="size-3.5" /> تغییر وضعیت
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {actions.map((act) => (
          <DropdownMenuItem
            key={act}
            onClick={() => onAction(act)}
            className={`gap-2 ${act === "bounce" || act === "cancel" ? "text-destructive focus:text-destructive" : ""}`}
          >
            <span className="flex-1 text-sm">{ACTION_LABELS[act]}</span>
            <span className="text-xs text-muted-foreground">
              {ACTION_HINT[act]}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onDetail} className="gap-2">
          <EyeIcon className="size-4" /> جزئیات و تاریخچه
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function availableStatusesFor(direction: ChequeDirection): ChequeStatus[] {
  return direction === "receivable"
    ? ["on_hand", "in_collection", "endorsed", "cleared", "bounced", "resolved"]
    : ["issued", "cleared", "bounced", "cancelled", "resolved"];
}

/**
 * The accounting-aware groups the server also understands, offered above the
 * individual statuses: «در جریان» is where the money still is, «برگشتی
 * تعیین‌تکلیف‌نشده» is what is stranded in چک‌های برگشتی.
 */
const STATUS_GROUP_OPTIONS: { value: string; label: string }[] = [
  { value: "outstanding", label: "در جریان (دارایی/بدهی باز)" },
  { value: "returned_unresolved", label: "برگشتی تعیین‌تکلیف‌نشده" },
  { value: "contingent", label: "واگذارشده (تعهد احتمالی)" },
  { value: "settled", label: "تعیین‌تکلیف‌شده" },
];

// ---------------------------------------------------------------------------
// Detail dialog — timeline + meta + actions
// ---------------------------------------------------------------------------

function ChequeDetailDialog({
  cheque,
  onClose,
  actions,
  onAction,
  onReplace,
  suppliers,
  money,
  busy,
}: {
  cheque: Cheque;
  onClose: () => void;
  /** Already gated by `finance.cheques_manage`; empty means read-only. */
  actions: ChequeAction[];
  onAction: (act: ChequeAction) => void;
  /** Offered on a returned cheque only, and only to a member who may write. */
  onReplace?: () => void;
  suppliers: Counterparty[];
  money: ReturnType<typeof useMoney>;
  busy: boolean;
}) {
  const [events, setEvents] = useState<ChequeEvent[] | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [historyRefresh, setHistoryRefresh] = useState(0);
  // The journal document behind one history row. An audit screen that says
  // «سند حسابداری ثبت شد» and leaves the reader to find it by hand is not an
  // audit screen.
  const [entryId, setEntryId] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setEvents(null);
    setHistoryError("");
    void api<{ events?: ChequeEvent[]; history?: ChequeEvent[] }>(
      `/api/ledger/cheques/${cheque.id}/history`,
    ).then(({ ok, data }) => {
      if (!current) return;
      const history = data.events ?? data.history;
      if (ok && Array.isArray(history)) setEvents(history);
      else setHistoryError("بارگذاری تاریخچه چک ناموفق بود. دوباره تلاش کنید.");
    });
    return () => {
      current = false;
    };
  }, [cheque.id, historyRefresh]);

  const endorsedSupplierId = events?.find((event) => event.event === "endorsed")?.endorsedToSupplierId;
  const linkedSupplierId = cheque.direction === "payable" ? cheque.supplierId : endorsedSupplierId;
  const linkedSupplier = linkedSupplierId
    ? (suppliers.find((supplier) => supplier.id === linkedSupplierId)?.name ?? "تأمین‌کننده")
    : null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        dir="rtl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LandmarkIcon className="size-5 text-primary" />
            جزئیات چک {toPersianDigits(cheque.serialNumber)}
            <Badge
              variant="outline"
              className={`border ${STATUS_TONE[cheque.status]}`}
            >
              {STATUS_LABELS[cheque.status]}
            </Badge>
          </DialogTitle>
          <DialogDescription className="leading-6">
            {cheque.bankName} · مبلغ {money.format(cheque.amount)} · سررسید{" "}
            {toPersianDigits(formatJalali(cheque.dueDate))} · طرف{" "}
            {cheque.counterpartyName}
            {cheque.sayadId ? ` · صیاد ${toPersianDigits(cheque.sayadId)}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">مشخصات چک</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <DetailItem label="طرف حساب" value={cheque.counterpartyName} />
              <DetailItem label="بانک" value={cheque.bankName} />
              <DetailItem
                label="شماره چک"
                value={toPersianDigits(cheque.serialNumber)}
                dir="ltr"
              />
              <DetailItem
                label="شناسه صیاد"
                value={cheque.sayadId ? toPersianDigits(cheque.sayadId) : "—"}
                dir="ltr"
              />
              <DetailItem label="مبلغ" value={money.format(cheque.amount)} />
              <DetailItem
                label="سررسید"
                value={toPersianDigits(formatJalali(cheque.dueDate))}
              />
              <DetailItem
                label={cheque.direction === "receivable" ? "تاریخ دریافت" : "تاریخ صدور"}
                value={toPersianDigits(formatJalali(cheque.issueDate))}
              />
              <DetailItem label="وضعیت چک" value={STATUS_LABELS[cheque.status]} />
              {/* The branch that owns the instrument: every entry of this
                  cheque's life posts there, whatever branch the operator is
                  currently switched into. */}
              <DetailItem
                label="شعبه ثبت چک"
                value={cheque.locationName ?? "کل کسب‌وکار"}
              />
              {cheque.status === "resolved" && (cheque.replacedByAmount ?? 0) > 0 ? (
                <DetailItem
                  label="جایگزین‌شده تا کنون"
                  value={`${money.format(cheque.replacedByAmount ?? 0)} از ${money.format(cheque.amount)}`}
                />
              ) : null}
              {cheque.replacesChequeId ? (
                <DetailItem
                  label="جایگزین چک برگشتی"
                  value={
                    cheque.replacesSerialNumber
                      ? toPersianDigits(cheque.replacesSerialNumber)
                      : "ثبت‌شده"
                  }
                  dir="ltr"
                />
              ) : null}
              {cheque.accountNumber ? (
                <DetailItem
                  label="شماره حساب"
                  value={toPersianDigits(cheque.accountNumber)}
                  dir="ltr"
                />
              ) : null}
              {linkedSupplier ? (
                <DetailItem
                  label={cheque.direction === "payable" ? "تأمین‌کننده" : "واگذارشده به"}
                  value={linkedSupplier}
                />
              ) : null}
              {cheque.memo ? (
                <DetailItem
                  label="یادداشت"
                  value={cheque.memo}
                  className="sm:col-span-2"
                />
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">اقدامات قابل انجام</CardTitle>
              <CardDescription>
                هر اقدام تاریخ وقوع و یادداشت خود را می‌گیرد و سند حسابداری
                متناظر را ثبت می‌کند.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {actions.length === 0 ? (
                <p className="rounded-lg border border-dashed bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">
                  این چک در وضعیت نهایی است و اقدام دیگری ندارد.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {actions.map((act) => (
                    <Button
                      key={act}
                      size="sm"
                      variant={
                        act === "bounce" || act === "cancel"
                          ? "destructive"
                          : act === "clear" || act === "present"
                            ? "default"
                            : "secondary"
                      }
                      onClick={() => onAction(act)}
                      disabled={busy}
                    >
                      {ACTION_LABELS[act]}
                    </Button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">تاریخچه</CardTitle>
              <CardDescription>
                هر رویداد، تاریخ وقوع و سند حسابداری پیوندی‌اش.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {events === null ? (
                historyError ? (
                  <Alert variant="destructive" className="items-start">
                    <AlertTriangleIcon className="mt-0.5 size-4" />
                    <div className="min-w-0 flex-1">
                      <AlertTitle>تاریخچه در دسترس نیست</AlertTitle>
                      <AlertDescription className="mt-1 flex flex-wrap items-center gap-3">
                        <span>{historyError}</span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setHistoryRefresh((key) => key + 1)}
                        >
                          تلاش دوباره
                        </Button>
                      </AlertDescription>
                    </div>
                  </Alert>
                ) : (
                  <div className="space-y-2">
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-full" />
                  </div>
                )
              ) : events.length === 0 ? (
                <p className="rounded-lg border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
                  هنوز رویدادی فراتر از ثبت اولیه وجود ندارد.
                </p>
              ) : (
                <ol className="relative space-y-3 border-s ps-4">
                  {events.map((e) => (
                    <li key={e.id} className="relative">
                      <span className="absolute -start-[21px] top-1 size-2.5 rounded-full border-2 border-primary bg-card" />
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary" className="text-xs">
                          {eventLabel(e.event)}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {toPersianDigits(formatJalali(e.occurredOn))}
                        </span>
                        {e.entryId ? (
                          <Button
                            variant="link"
                            size="sm"
                            className="h-auto p-0 text-xs"
                            onClick={() => setEntryId(e.entryId)}
                          >
                            مشاهده سند حسابداری
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            · بدون سند (این مرحله مبلغی جابه‌جا نکرد)
                          </span>
                        )}
                      </div>
                      {e.memo ? (
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {e.memo}
                        </p>
                      ) : null}
                      {e.endorsedToSupplierId ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          واگذاری به{" "}
                          {suppliers.find(
                            (s) => s.id === e.endorsedToSupplierId,
                          )?.name ?? "تأمین‌کننده"}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>

        <DialogFooter className="flex-wrap gap-2 sm:justify-start">
          {onReplace && cheque.status === "resolved" && replaceableRemainder(cheque) > 0 ? (
            <Button onClick={onReplace} className="gap-1.5">
              <PlusIcon className="size-4" /> ثبت چک جایگزین
            </Button>
          ) : null}
          {cheque.status === "bounced" ? (
            // Not an option yet, and saying why is the point: the balance is
            // still in چک‌های برگشتی, and a replacement registered now would
            // credit a receivable nobody restored.
            <p className="basis-full text-xs leading-5 text-muted-foreground">
              برای ثبت چک جایگزین، ابتدا «بازگشت به حساب طرف» را انجام دهید تا
              مانده چک برگشتی به حساب طرف حساب برگردد.
            </p>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            بستن
          </Button>
        </DialogFooter>

        {entryId ? (
          <JournalPeekDialog
            entryId={entryId}
            title="سند این مرحله از زندگی چک"
            onClose={() => setEntryId(null)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The register's value by accounting category, each tied to the control
 * account it must agree with. Payable cancellation is its own line because
 * «ابطال» is not «وصول»: it gives the liability back to the supplier, and a
 * treasurer reconciling 2121 needs to see it separately.
 */
/**
 * How much of a returned cheque is still unreplaced. Splitting one returned
 * cheque into several smaller replacements is ordinary practice, so the
 * question is never "has it been replaced" but "is there anything left" —
 * and the server refuses anything above this remainder anyway.
 */
function replaceableRemainder(cheque: Cheque): number {
  return Math.max(0, cheque.amount - (cheque.replacedByAmount ?? 0));
}

function categoryBreakdown(
  direction: ChequeDirection,
  summary: ChequeSummary,
): { key: string; label: string; account: string; bucket: SummaryBucket }[] {
  if (direction === "receivable") {
    return [
      { key: "onHand", label: "نزد صندوق", account: "۱۲۴۱ چک‌های دریافتنی نزد صندوق", bucket: summary.onHand },
      { key: "inCollection", label: "در جریان وصول", account: "۱۲۴۲ چک‌های در جریان وصول", bucket: summary.inCollection },
      { key: "contingent", label: "ظهرنویسی‌شده (تعهد احتمالی)", account: "خارج از دارایی‌ها — بازگشت در صورت برگشت چک", bucket: summary.contingent },
      { key: "returned", label: "برگشتی تعیین‌تکلیف‌نشده", account: "۱۲۴۴ چک‌های برگشتی", bucket: summary.returnedUnresolved },
      { key: "resolved", label: "بازگشته به حساب طرف", account: "۱۲۰۰ حساب‌های دریافتنی", bucket: summary.resolved },
      { key: "cleared", label: "وصول‌شده", account: "۱۱۱۰ بانک", bucket: summary.cleared },
    ];
  }
  return [
    { key: "issued", label: "صادرشده در جریان", account: "۲۱۲۱ اسناد پرداختنی", bucket: summary.issued },
    { key: "returned", label: "برگشتی تعیین‌تکلیف‌نشده", account: "۲۱۲۲ چک‌های پرداختنی برگشتی", bucket: summary.returnedUnresolved },
    { key: "resolved", label: "بازگشته به حساب تأمین‌کننده", account: "۲۱۰۰ حساب‌های پرداختنی", bucket: summary.resolved },
    { key: "cancelled", label: "ابطال‌شده", account: "۲۱۰۰ حساب‌های پرداختنی — بدهی بازگشته", bucket: summary.cancelled },
    { key: "cleared", label: "پاس‌شده", account: "۱۱۱۰ بانک", bucket: summary.cleared },
  ];
}

function DetailItem({
  label,
  value,
  dir,
  className,
}: {
  label: string;
  value: string;
  dir?: "ltr" | "rtl";
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-sm font-medium" dir={dir}>
        {value}
      </p>
    </div>
  );
}

function eventLabel(event: string): string {
  const m: Record<string, string> = {
    received: "دریافت",
    issued: "صدور",
    deposited: "واگذاری به بانک",
    endorsed: "ظهرنویسی",
    cleared: "وصول / پاس",
    bounced: "برگشت",
    cancelled: "ابطال",
    settled: "تسویه چک برگشتی",
    restored: "بازگشت مانده به حساب طرف",
  };
  return m[event] ?? event;
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

function CreateChequeDialog({
  open,
  onOpenChange,
  direction,
  replaces,
  customers,
  suppliers,
  counterpartyLoadError,
  busy,
  onCreated,
  run,
  onError,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  direction: ChequeDirection;
  /** Set when this registration replaces a returned cheque. */
  replaces: Cheque | null;
  customers: Counterparty[];
  suppliers: Counterparty[];
  counterpartyLoadError: string;
  busy: boolean;
  onCreated: () => void;
  run: (
    fn: () => Promise<{ ok: boolean; data: { error?: string } }>,
  ) => Promise<boolean>;
  onError: (m: string) => void;
}) {
  const money = useMoney();
  const [dir, setDir] = useState<ChequeDirection>(direction);
  const counterparties = dir === "receivable" ? customers : suppliers;

  const [serialNumber, setSerialNumber] = useState("");
  const [sayadId, setSayadId] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [issueDate, setIssueDate] = useState(todayIsoDate());
  const [dueDate, setDueDate] = useState("");
  const [counterpartyId, setCounterpartyId] = useState("");
  const [counterpartyName, setCounterpartyName] = useState("");
  const [memo, setMemo] = useState("");
  const [formError, setFormError] = useState("");
  // The exception, never the default: a cheque with no party lands in the A/R
  // or A/P subledger's unattributed bucket, which no reconciliation can
  // explain. Ticking this is the user saying they mean it.
  const [unattributed, setUnattributed] = useState(false);
  // One key per *attempt at a form*, so a retry after a lost response returns
  // the first cheque instead of registering a second instrument.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const reportError = useCallback(
    (message: string) => {
      setFormError(message);
      onError(message);
    },
    [onError],
  );

  useEffect(() => setDir(direction), [direction]);
  useEffect(() => {
    // IDs are scoped to the selected direction. Retaining a customer ID after
    // switching to «صادرشده» submitted it as a supplier and failed on save.
    setCounterpartyId("");
    setCounterpartyName("");
  }, [dir]);
  // Pre-fill from the returned cheque being replaced: same counterparty, same
  // bank, and the link the history will show.
  useEffect(() => {
    if (!open || !replaces) return;
    setDir(replaces.direction);
    setBankName(replaces.bankName);
    setCounterpartyName(replaces.counterpartyName);
    setCounterpartyId(
      (replaces.direction === "receivable" ? replaces.customerId : replaces.supplierId) ?? "",
    );
    setAmount(String(replaces.amount));
  }, [open, replaces]);

  useEffect(() => {
    if (!open) {
      setSerialNumber("");
      setSayadId("");
      setBankName("");
      setAccountNumber("");
      setAmount("");
      setIssueDate(todayIsoDate());
      setDueDate("");
      setCounterpartyId("");
      setCounterpartyName("");
      setMemo("");
      setFormError("");
      setUnattributed(false);
      setIdempotencyKey(crypto.randomUUID());
    }
  }, [open]);

  const selected = counterparties.find((c) => c.id === counterpartyId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (
      !serialNumber.trim() ||
      !bankName.trim() ||
      !dueDate ||
      !amount.trim()
    ) {
      reportError("شماره چک، بانک، مبلغ و سررسید الزامی هستند.");
      return;
    }
    if (issueDate && dueDate < issueDate) {
      reportError(errorMessage("due_date_before_issue"));
      return;
    }
    let rial: number;
    try {
      rial = money.parse(amount);
    } catch {
      reportError(errorMessage("invalid_amount"));
      return;
    }
    const name = counterpartyName.trim() || selected?.name || "";
    if (!name) {
      reportError(errorMessage("counterparty_name_required"));
      return;
    }
    if (!counterpartyId && !unattributed) {
      reportError(
        errorMessage(dir === "receivable" ? "customer_required" : "supplier_required"),
      );
      return;
    }
    const body: Record<string, unknown> = {
      direction: dir,
      serialNumber: serialNumber.trim(),
      sayadId: sayadId.trim() || undefined,
      bankName: bankName.trim(),
      accountNumber: accountNumber.trim() || undefined,
      amount: rial,
      issueDate: issueDate || undefined,
      dueDate,
      counterpartyName: name,
      memo: memo.trim() || undefined,
      [dir === "receivable" ? "customerId" : "supplierId"]:
        counterpartyId || undefined,
      allowUnattributed: !counterpartyId && unattributed ? true : undefined,
      replacesChequeId: replaces?.id,
      idempotencyKey,
    };
    reportError("");
    let response: { ok: boolean; data: { error?: string } } | undefined;
    const ok = await run(async () => {
      response = await api<{ error?: string }>("/api/ledger/cheques", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return response;
    });
    if (ok) onCreated();
    else reportError(errorMessage(response?.data.error));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        dir="rtl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlusIcon className="size-5 text-primary" />
            {replaces ? "ثبت چک جایگزین" : "ثبت چک جدید"}
          </DialogTitle>
          <DialogDescription>
            {replaces ? (
              <span className="mb-1 block">
                جایگزین چک برگشتی {toPersianDigits(replaces.serialNumber)} —
                مانده آن قبلاً با «بازگشت به حساب طرف» از حساب چک‌های برگشتی
                خارج شده است، بنابراین این ثبت بدهی را دوباره تسویه نمی‌کند.
              </span>
            ) : null}
            چک دریافتی حساب‌های دریافتنی را کاهش می‌دهد؛ چک صادرشده بدهی به
            تأمین‌کننده را در حساب چک‌های صادره قرار می‌دهد. هر دو فوراً سند
            حسابداری می‌خورند.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="grid gap-4" noValidate>
          {formError ? (
            <Alert variant="destructive" role="alert">
              <AlertTriangleIcon className="size-4" />
              <AlertTitle>ثبت چک انجام نشد</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}
          {counterpartyLoadError ? (
            <Alert className="border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
              <AlertTriangleIcon className="size-4 text-amber-700 dark:text-amber-300" />
              <AlertDescription>{counterpartyLoadError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-2">
            <Label>نوع چک</Label>
            <Tabs
              value={dir}
              onValueChange={(v) => setDir(v as ChequeDirection)}
            >
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="receivable" className="gap-1.5">
                  <HandCoinsIcon className="size-4" /> دریافتی از مشتری
                </TabsTrigger>
                <TabsTrigger value="payable" className="gap-1.5">
                  <FileTextIcon className="size-4" /> صادرشده به تأمین‌کننده
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="serial">شماره چک *</FieldLabel>
              <Input
                id="serial"
                value={serialNumber}
                onChange={(e) => setSerialNumber(e.target.value)}
                placeholder="مثلاً ۱۲۳۴۵۶۷۸۹۰"
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="bank">بانک *</FieldLabel>
              <Input
                id="bank"
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                placeholder="مثلاً ملت، ملی، سامان"
                required
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="sayad">شناسه صیاد (اختیاری)</FieldLabel>
              <PersianNumberInput
                id="sayad"
                value={sayadId}
                onChange={(e) => setSayadId(e.target.value)}
                inputMode="numeric"
                allowNegative={false}
                grouping={false}
                placeholder="۱۶ رقم"
                className="h-10 w-full rounded-lg border border-input bg-transparent px-3 text-sm"
              />
              <FieldDescription>
                ۱۶ رقم؛ فارسی هم می‌پذیرد و فاصله/خط‌تیره نادیده گرفته می‌شود.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="accno">شماره حساب (اختیاری)</FieldLabel>
              <Input
                id="accno"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
                placeholder="اختیاری"
                dir="ltr"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="amount">
                مبلغ ({money.unitLabel}) *
              </FieldLabel>
              <PersianNumberInput
                id="amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="numeric"
                allowNegative={false}
                placeholder="مثلاً ۲٬۵۰۰٬۰۰۰"
                className="h-10 w-full rounded-lg border border-input bg-transparent px-3 text-sm"
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="cheque-due-date">سررسید *</FieldLabel>
              <JalaliDatePicker
                id="cheque-due-date"
                ariaLabel="سررسید چک"
                value={dueDate}
                onChange={setDueDate}
                placeholder="انتخاب سررسید"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="cheque-issue-date">
                {dir === "receivable" ? "تاریخ دریافت" : "تاریخ صدور"}
              </FieldLabel>
              <JalaliDatePicker
                id="cheque-issue-date"
                ariaLabel={dir === "receivable" ? "تاریخ دریافت چک" : "تاریخ صدور چک"}
                value={issueDate}
                onChange={setIssueDate}
                clearable={false}
              />
              <FieldDescription>
                تاریخ سند حسابداری همین روز است، نه سررسید.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>
                {dir === "receivable" ? "مشتری" : "تأمین‌کننده"}{" "}
                {unattributed ? "(بدون اتصال)" : "*"}
              </FieldLabel>
              <SearchableSelect
                value={counterpartyId}
                onChange={(id) => {
                  setCounterpartyId(id);
                  if (id) {
                    setCounterpartyName(counterparties.find((counterparty) => counterparty.id === id)?.name ?? "");
                  }
                }}
                options={counterparties.map((c) => ({
                  value: c.id,
                  label: c.name,
                }))}
                placeholder={
                  dir === "receivable" ? "انتخاب مشتری…" : "انتخاب تأمین‌کننده…"
                }
                ariaLabel={dir === "receivable" ? "مشتری" : "تأمین‌کننده"}
              />
              <FieldDescription>
                اتصال به طرف حساب، این چک را در معین دریافتنی/پرداختنی همان طرف
                می‌نشاند؛ بدون آن قابل مغایرت‌گیری نیست.
              </FieldDescription>
            </Field>
          </div>

          {/* The exception, visibly an exception. */}
          {!counterpartyId ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-amber-600"
                  checked={unattributed}
                  onChange={(e) => setUnattributed(e.target.checked)}
                />
                <span>
                  <span className="font-medium">
                    ثبت بدون اتصال به طرف حساب
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                    فقط برای چک‌های قدیمی یا ناشناس. این چک در سرفصل
                    دریافتنی/پرداختنی بدون طرف حساب می‌نشیند و برای مغایرت‌گیری
                    باید بعداً طبقه‌بندی شود.
                  </span>
                </span>
              </label>
            </div>
          ) : null}

          <Field>
            <FieldLabel htmlFor="cname">
              {dir === "receivable" ? "نام صادرکننده روی چک" : "در وجه / دریافت‌کننده"} *
            </FieldLabel>
            <Input
              id="cname"
              value={counterpartyName}
              onChange={(e) => setCounterpartyName(e.target.value)}
              placeholder={
                selected?.name ??
                (dir === "receivable" ? "نام درج‌شده روی چک" : "نام دریافت‌کننده")
              }
              required
              aria-invalid={Boolean(formError) || undefined}
            />
            <FieldDescription>
              انتخاب طرف حساب، سرفصل تسویه را مشخص می‌کند. اگر نام درج‌شده روی
              چک متفاوت است، این نام را اصلاح کنید.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="memo">یادداشت</FieldLabel>
            <Input
              id="memo"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="اختیاری — مثلاً بابت فاکتور ۱۲۳"
            />
          </Field>

          <Alert className="bg-primary/5 border-primary/20">
            <LandmarkIcon className="size-4 text-primary" />
            <AlertTitle className="text-primary">نکته حسابداری</AlertTitle>
            <AlertDescription className="leading-6">
              {dir === "receivable"
                ? "چک دریافتی: بدهکار چک‌های نزد صندوق / بستانکار حساب‌های دریافتنی. وصول، انتقال به بانک و ظهرنویسی هرکدام سند خود را دارند."
                : "چک صادرشده: بدهکار حساب‌های پرداختنی / بستانکار چک‌های صادره. پاس شدن از بانک کسر می‌کند؛ برگشت یا ابطال بدهی را برمی‌گرداند."}
            </AlertDescription>
          </Alert>

          <DialogFooter className="gap-2 sm:justify-start">
            <Button type="submit" disabled={busy} className="min-w-28">
              ثبت چک
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              انصراف
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Generic action dialog (deposit / endorse / clear / present / bounce / cancel)
// ---------------------------------------------------------------------------

function ChequeActionDialog({
  cheque,
  action,
  suppliers,
  supplierLoadError,
  busy,
  error,
  onClose,
  onConfirm,
  onError,
}: {
  cheque: Cheque;
  action: ChequeAction;
  suppliers: Counterparty[];
  supplierLoadError: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (body: Record<string, unknown>) => void;
  onError: (m: string) => void;
}) {
  const money = useMoney();
  const [occurredOn, setOccurredOn] = useState(todayIsoDate());
  const [memo, setMemo] = useState("");
  // No default: preselecting `suppliers[0]` meant one careless «ظهرنویسی»
  // handed a customer's cheque to whichever supplier sorted first.
  const [supplierId, setSupplierId] = useState("");
  // The bank's returned-cheque charge, posted to «۵۸۶۰ هزینه چک برگشتی و جرایم
  // بانکی» alongside the bounce itself. Optional: not every bounce is charged.
  const [feeAmount, setFeeAmount] = useState("");

  const isEndorse = action === "endorse";
  const isBounce = action === "bounce";
  const isDestructive = action === "bounce" || action === "cancel";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isDestructive ? (
              <AlertTriangleIcon className="size-5 text-destructive" />
            ) : (
              <ArrowLeftRightIcon className="size-5 text-primary" />
            )}
            {ACTION_LABELS[action]} — چک {toPersianDigits(cheque.serialNumber)}
          </DialogTitle>
          <DialogDescription className="leading-6">
            {ACTION_HINT[action]} · مبلغ {money.format(cheque.amount)} ·{" "}
            {cheque.bankName} · سررسید{" "}
            {toPersianDigits(formatJalali(cheque.dueDate))}
            {isEndorse
              ? " — واگذاری به تأمین‌کننده بدهی او را کم می‌کند؛ برگشت احتمالی بدهی را برمی‌گرداند."
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertTriangleIcon className="size-4" />
              <AlertTitle>تغییر وضعیت انجام نشد</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {isEndorse && supplierLoadError ? (
            <Alert className="border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
              <AlertTriangleIcon className="size-4 text-amber-700 dark:text-amber-300" />
              <AlertDescription>{supplierLoadError}</AlertDescription>
            </Alert>
          ) : null}
          {isEndorse ? (
            <Field>
              <FieldLabel>تأمین‌کننده *</FieldLabel>
              <SearchableSelect
                value={supplierId}
                onChange={setSupplierId}
                options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
                placeholder="انتخاب تأمین‌کننده…"
                ariaLabel="تأمین‌کننده"
              />
              <FieldDescription>
                کل مبلغ چک از بدهی این تأمین‌کننده کسر می‌شود.
              </FieldDescription>
            </Field>
          ) : null}

          <Field>
            <FieldLabel htmlFor="cheque-action-date">تاریخ وقوع</FieldLabel>
            <JalaliDatePicker
              id="cheque-action-date"
              ariaLabel="تاریخ وقوع اقدام چک"
              value={occurredOn}
              onChange={setOccurredOn}
              clearable={false}
            />
            <FieldDescription>
              تاریخ سند حسابداری همین روز ثبت می‌شود.
            </FieldDescription>
          </Field>

          {isBounce ? (
            <Field>
              <FieldLabel htmlFor="cheque-fee">
                کارمزد/جریمه بانکی (اختیاری)
              </FieldLabel>
              <PersianNumberInput
                id="cheque-fee"
                value={feeAmount}
                onChange={(e) => setFeeAmount(e.target.value)}
                inputMode="numeric"
                allowNegative={false}
                placeholder="۰"
                aria-label="مبلغ کارمزد چک برگشتی"
                className="h-10 w-full rounded-lg border border-input bg-transparent px-3 text-sm"
              />
              <FieldDescription>
                در صورت ثبت، همراه همین سند به حساب «هزینه چک برگشتی و جرایم
                بانکی» منتقل و از بانک کسر می‌شود.
              </FieldDescription>
            </Field>
          ) : null}

          <Field>
            <FieldLabel htmlFor="amemo">یادداشت (اختیاری)</FieldLabel>
            <Input
              id="amemo"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="مثلاً شماره پیگیری بانکی"
            />
          </Field>

          {isDestructive ? (
            <Alert variant="destructive">
              <AlertTriangleIcon className="size-4" />
              <AlertTitle>تأیید اقدام برگشتی/ابطالی</AlertTitle>
              <AlertDescription>
                این اقدام سند برگشتی/ابطالی را در دفتر روزنامه ثبت می‌کند. چک
                برگشتی پس از آن باید تعیین‌تکلیف شود: تسویه نقدی/بانکی یا
                بازگشت مانده به حساب طرف (و سپس ثبت چک جایگزین).
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-start">
          <Button
            variant={isDestructive ? "destructive" : "default"}
            disabled={busy}
            onClick={() => {
              if (isEndorse && !supplierId) {
                onError("انتخاب تأمین‌کننده الزامی است.");
                return;
              }
              onError("");
              onConfirm({
                occurredOn: occurredOn || undefined,
                memo: memo.trim() || undefined,
                ...(isEndorse ? { endorsedToSupplierId: supplierId } : {}),
                ...(isBounce && Number(feeAmount) > 0
                  ? { feeAmount: Number(feeAmount) }
                  : {}),
              });
            }}
          >
            {ACTION_LABELS[action]}
          </Button>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            انصراف
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
