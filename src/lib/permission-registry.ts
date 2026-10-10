/**
 * The permission catalogue: one description of every capability, in one place.
 *
 * ## Why a registry rather than more constants
 *
 * `permissions.ts` answers "what are the keys and who gets them by default".
 * It deliberately does not answer the questions a *user interface* has to ask
 * about a permission:
 *
 *   * What is this called in Persian, and what does it actually do?
 *   * Which group does it belong to in the role editor?
 *   * Is it dangerous enough to warn about before granting?
 *   * May a custom role or a per-member grant hand it out at all?
 *   * Does exercising it imply another capability (adjusting stock is useless
 *     without being able to see stock)?
 *
 * Before this file each of those was answered by whichever component happened
 * to need it, which is how the same permission ended up labelled two different
 * ways on two screens and how the role editor's "dangerous" styling covered a
 * different set of keys than the confirmation dialog did. Metadata about a
 * permission is a fact about the product, not a screen-local decision — the
 * same argument `role-labels.ts` makes for role names.
 *
 * Framework-free and type-only imports so client components and server code
 * can both read it.
 */
import { ALL_PERMISSIONS, isOwnerOnlyPermission, PERMISSIONS, type Permission } from "./permissions";

/**
 * How much damage holding this key can do, used for the role editor's warning
 * treatment and for deciding what needs a confirmation step.
 *
 *   low      — reading, or a write with no lasting consequence.
 *   medium   — ordinary operational writes.
 *   high     — money moves, data leaves the building, or history is rewritten.
 *   critical — the tenant's own security or continuity is at stake.
 */
export type PermissionRisk = "low" | "medium" | "high" | "critical";

/** Role-editor grouping. One group per screenful of related capability. */
export type PermissionGroup =
  | "ai"
  | "orders"
  | "payments"
  | "floor"
  | "menu"
  | "inventory"
  | "parties"
  | "crm"
  | "workspace"
  | "accounting"
  | "finance"
  | "payroll"
  | "reports"
  | "growth"
  | "website"
  | "data"
  | "team"
  | "settings"
  | "security";

export interface PermissionMetadata {
  key: Permission;
  group: PermissionGroup;
  label: string;
  description: string;
  risk: PermissionRisk;
  /**
   * Whether a custom role or a per-member grant may hand this out. False for
   * the owner-reserved capabilities — represented here, once, rather than as a
   * scattering of `if (role !== "owner")` checks.
   */
  delegatable: boolean;
  /** Only an owner ever holds this, however the tenant configures its roles. */
  ownerOnly: boolean;
  /** Granting, revoking or exercising this should be written to the audit log. */
  audit: boolean;
  /**
   * Capabilities this one is useless without. The role editor turns these on
   * automatically rather than letting an owner save a role that can adjust
   * stock it cannot see.
   */
  implies?: readonly Permission[];
}

const P = PERMISSIONS;

const GROUP_LABELS: Record<PermissionGroup, string> = {
  ai: "دستیار هوشمند",
  orders: "فروش و سفارش‌ها",
  payments: "پرداخت‌ها",
  floor: "سالن و تحویل",
  menu: "منو و کالا",
  inventory: "انبار و خرید",
  parties: "اشخاص",
  crm: "مشتریان و CRM",
  workspace: "میز کار",
  accounting: "حسابداری",
  finance: "عملیات مالی",
  payroll: "حقوق و دستمزد",
  reports: "گزارش‌ها",
  growth: "رشد و بازاریابی",
  website: "مدیریت وب‌سایت",
  data: "ورود و خروج داده",
  team: "تیم و دسترسی",
  settings: "تنظیمات و شعب",
  security: "امنیت و API",
};

export function permissionGroupLabel(group: PermissionGroup): string {
  return GROUP_LABELS[group];
}

export const PERMISSION_GROUP_ORDER: readonly PermissionGroup[] = [
  "ai", "orders", "payments", "floor", "menu", "inventory", "parties", "crm",
  "workspace", "accounting", "finance", "payroll", "reports", "growth", "website", "data",
  "team", "settings", "security",
];

type Draft = Omit<PermissionMetadata, "ownerOnly" | "delegatable"> &
  Partial<Pick<PermissionMetadata, "delegatable">>;

const DRAFTS: Draft[] = [
  // --- AI workspace --------------------------------------------------------
  { key: P.aiUse, group: "ai", label: "استفاده از دستیار هوشمند", description: "باز کردن فضای کار هوش مصنوعی و پرسیدن سؤال با داده‌های مجاز.", risk: "low", audit: false },
  // Issue #812 §4/§9 — the two AI management keys the issue retired are gone
  // from this catalogue entirely: a system agent is built and versioned only by
  // Superadmin, so a tenant never manages one; and knowledge is infrastructure
  // owned by the configured LiteLLM layer, not something a tenant feeds or
  // reindexes. An advertised capability that gates nothing is a permission a
  // reviewer stops trusting, so they were removed rather than left dangling.
  { key: P.aiManage, group: "ai", label: "مدیریت دستیار هوشمند", description: "مدیریت حافظه، همکارها و تنظیمات اصلی دستیار.", risk: "high", audit: true, implies: [P.aiUse] },
  { key: P.aiAutomationsManage, group: "ai", label: "مدیریت اتوماسیون‌های هوشمند", description: "ساخت، بررسی و اجرای گردش‌کارهای هوشمند.", risk: "high", audit: true, implies: [P.aiUse] },
  { key: P.aiUsageView, group: "ai", label: "مشاهده مصرف هوش مصنوعی", description: "دیدن مصرف، هزینه و سابقهٔ استفاده از دستیار.", risk: "low", audit: false, implies: [P.aiUse] },
  // Issue #812 §11 — the widget-management key is gone. A workspace widget is a
  // saved prompt that runs with its creator's OWN permissions, and
  // `ai-widgets.ts` refuses any widget whose `requiredPermissions` the caller
  // does not already hold (`widget_permission_widening`). That intersection is
  // a stronger boundary than a dedicated key would be: it holds per widget
  // rather than per member, and it fails closed on an unknown permission.

  // --- Sales & orders ------------------------------------------------------
  { key: P.ordersView, group: "orders", label: "مشاهده سفارش‌ها", description: "دیدن سفارش‌های باز و بسته‌شده بدون تغییر آن‌ها.", risk: "low", audit: false },
  { key: P.ordersCreate, group: "orders", label: "ثبت سفارش", description: "ایجاد سفارش جدید و افزودن اقلام به آن.", risk: "low", audit: false, implies: [P.menuView, P.ordersView] },
  { key: P.ordersDiscount, group: "orders", label: "اعمال تخفیف", description: "کاهش مبلغ سفارش پیش از تسویه.", risk: "medium", audit: true, implies: [P.ordersCreate] },
  { key: P.ordersVoid, group: "orders", label: "ابطال سفارش باز", description: "حذف سفارشی که هنوز تسویه نشده است.", risk: "medium", audit: true },
  { key: P.ordersAmendClosed, group: "orders", label: "اصلاح سفارش بسته", description: "تغییر یا حذف سفارشی که پرداخت شده است؛ درآمد، مالیات، بهای تمام‌شده و موجودی را برمی‌گرداند.", risk: "high", audit: true, implies: [P.ordersVoid] },

  // --- Payments ------------------------------------------------------------
  { key: P.paymentsTake, group: "payments", label: "دریافت پرداخت", description: "تسویه سفارش با نقد، کارت یا سایر روش‌ها.", risk: "medium", audit: false },
  { key: P.paymentsRefund, group: "payments", label: "بازگشت وجه", description: "برگرداندن پول به مشتری. مستقیماً بر صندوق و دفاتر اثر دارد.", risk: "high", audit: true, implies: [P.paymentsTake] },

  // --- Floor ---------------------------------------------------------------
  { key: P.tablesManage, group: "floor", label: "مدیریت میزها", description: "باز و بسته کردن میز و جابه‌جایی سفارش بین میزها.", risk: "low", audit: false },
  { key: P.tablesEdit, group: "floor", label: "ویرایش نقشه سالن", description: "تغییر نام، جایگاه، اندازه و وضعیت میزها. جدا از نشاندن مهمان.", risk: "medium", audit: true },
  { key: P.reservationsView, group: "floor", label: "مشاهده رزروها", description: "دیدن دفتر رزرو و رزروهای امروز.", risk: "low", audit: false },
  { key: P.reservationsManage, group: "floor", label: "مدیریت رزرو", description: "ثبت، تغییر و لغو رزرو.", risk: "low", audit: false, implies: [P.reservationsView] },
  { key: P.kitchenView, group: "floor", label: "نمایشگر آشپزخانه", description: "مشاهده و به‌روزرسانی وضعیت اقلام در آشپزخانه.", risk: "low", audit: false },
  { key: P.deliveryManage, group: "floor", label: "مدیریت ارسال", description: "تخصیص پیک و پیگیری وضعیت ارسال.", risk: "low", audit: false },
  { key: P.deliveryConfigure, group: "floor", label: "پیکربندی ارسال", description: "نگهداری فهرست پیک‌ها و تنظیمات ارسال.", risk: "medium", audit: true, implies: [P.deliveryManage] },

  // --- Catalogue -----------------------------------------------------------
  { key: P.menuView, group: "menu", label: "مشاهده منو", description: "دیدن کالاها، دسته‌ها و قیمت‌ها.", risk: "low", audit: false },
  { key: P.menuEdit, group: "menu", label: "ویرایش منو", description: "افزودن، تغییر و حذف کالا، دسته و قیمت.", risk: "medium", audit: true, implies: [P.menuView] },

  // --- Inventory -----------------------------------------------------------
  { key: P.inventoryView, group: "inventory", label: "مشاهده انبار", description: "دیدن موجودی، بهای تمام‌شده و گردش کالا.", risk: "low", audit: false },
  { key: P.inventoryAdjust, group: "inventory", label: "اصلاح موجودی", description: "ثبت مغایرت، ضایعات و شمارش انبار.", risk: "high", audit: true, implies: [P.inventoryView] },
  { key: P.purchasesManage, group: "inventory", label: "مدیریت خرید", description: "ثبت سفارش خرید و رسید کالا از تأمین‌کننده.", risk: "medium", audit: true, implies: [P.inventoryView] },

  // --- Parties -------------------------------------------------------------
  { key: P.partiesView, group: "parties", label: "مشاهده اشخاص", description: "دیدن پرونده مشتری، تأمین‌کننده و پرسنل.", risk: "low", audit: false },
  { key: P.partiesManage, group: "parties", label: "ویرایش اشخاص", description: "ایجاد و اصلاح پرونده اشخاص.", risk: "medium", audit: false, implies: [P.partiesView] },

  // --- CRM -----------------------------------------------------------------
  { key: P.crmView, group: "crm", label: "مشاهده CRM", description: "پرونده ۳۶۰ درجه، قیف فروش، بخش‌بندی و گزارش‌های CRM.", risk: "low", audit: false },
  { key: P.crmManage, group: "crm", label: "کار روزمره CRM", description: "یادداشت، وظیفه، فعالیت، پرونده پشتیبانی و معامله.", risk: "medium", audit: false },
  { key: P.crmMerge, group: "crm", label: "ادغام مشتریان", description: "ادغام دو پرونده مشتری. برگشت‌ناپذیر است و تاریخچه هر دو را بازنویسی می‌کند.", risk: "high", audit: true, implies: [P.crmView] },
  { key: P.crmConsentManage, group: "crm", label: "مدیریت رضایت بازاریابی", description: "تغییر رضایت مشتری برای دریافت پیام. یک سابقه حقوقی است.", risk: "high", audit: true },
  { key: P.crmExport, group: "crm", label: "خروجی گرفتن از مشتریان", description: "دانلود فهرست مشتریان. راهی است که یک بانک اطلاعاتی از سازمان خارج می‌شود.", risk: "high", audit: true, implies: [P.crmView] },
  { key: P.crmConfigure, group: "crm", label: "پیکربندی CRM", description: "تغییر مراحل قیف، تعریف بخش‌ها و ساختار گزارش‌ها.", risk: "medium", audit: true, implies: [P.crmView] },
  { key: P.crmDelete, group: "crm", label: "حذف رکورد CRM", description: "حذف کامل پرونده یا فعالیت مشتری همراه با تاریخچه آن.", risk: "high", audit: true, implies: [P.crmView] },

  // --- Workspace -----------------------------------------------------------
  { key: P.workspaceView, group: "workspace", label: "مشاهده میز کار", description: "دیدن پروژه‌ها، وظایف و اسناد.", risk: "low", audit: false },
  { key: P.workspaceManage, group: "workspace", label: "مدیریت میز کار", description: "ایجاد و ویرایش پروژه، وظیفه، سند و تقویم.", risk: "medium", audit: false, implies: [P.workspaceView] },
  { key: P.workspaceContractsManage, group: "workspace", label: "مدیریت قراردادها", description: "ثبت و اصلاح قرارداد اجرا؛ یک تعهد مالی به شخص ثالث است.", risk: "high", audit: true, implies: [P.workspaceView] },
  { key: P.workspaceAdmin, group: "workspace", label: "مدیریت همهٔ پروژه‌ها", description: "دسترسی مدیر به همهٔ پروژه‌ها، حتی بدون عضویت.", risk: "high", audit: true, implies: [P.workspaceView, P.workspaceManage] },
  { key: P.workspaceApprove, group: "workspace", label: "تأیید درخواست‌ها", description: "تصمیم‌گیری درباره درخواست‌های نیازمند تأیید.", risk: "high", audit: true, implies: [P.workspaceView] },
  { key: P.workspaceDocumentsIssue, group: "workspace", label: "صدور نقشه و سند", description: "صدور بازنگری نقشه یا سند برای طرف‌های بیرونی با برگهٔ ارسال. پس از صدور، سابقه تغییرناپذیر می‌شود.", risk: "high", audit: true, implies: [P.workspaceView] },

  // --- Accounting ----------------------------------------------------------
  { key: P.ledgerView, group: "accounting", label: "مشاهده دفاتر", description: "دیدن اسناد حسابداری، دفتر کل و صورت‌های مالی.", risk: "low", audit: false },
  { key: P.ledgerPost, group: "accounting", label: "ثبت سند", description: "ثبت سند حسابداری در دفاتر.", risk: "high", audit: true, implies: [P.ledgerView] },
  { key: P.ledgerApprove, group: "accounting", label: "تأیید سند", description: "تأیید سند ثبت‌شده. جدا از ثبت است تا تفکیک وظایف حفظ شود.", risk: "high", audit: true, implies: [P.ledgerView] },
  { key: P.ledgerClosePeriod, group: "accounting", label: "بستن دوره مالی", description: "بستن یا بازگشایی دوره مالی. پس از آن ثبت در دوره ممکن نیست.", risk: "critical", audit: true, implies: [P.ledgerView] },
  { key: P.accountsEdit, group: "accounting", label: "ویرایش کدینگ حساب‌ها", description: "تغییر ساختار حساب‌ها؛ هر گزارش تاریخی را بازتعریف می‌کند.", risk: "high", audit: true, implies: [P.ledgerView] },
  { key: P.ledgerPropose, group: "accounting", label: "پیش‌نویس سند", description: "تهیه پیش‌نویس سند حسابداری برای بررسی. تا زمانی که تأیید نشود بر دفاتر اثری ندارد.", risk: "low", audit: false, implies: [P.ledgerView] },

  // --- Operational finance -------------------------------------------------
  // Money moving as a consequence of ordinary trading. Separate from the
  // accounting-authority keys above: a manager holds these and none of those.
  { key: P.financeExpensesManage, group: "finance", label: "ثبت هزینه", description: "ثبت هزینه پرداخت‌شده و تخصیص آن به سرفصل و حساب پرداخت.", risk: "medium", audit: true, implies: [P.ledgerView] },
  { key: P.financeReceivablesManage, group: "finance", label: "دریافت از مشتری", description: "ثبت دریافت وجه از مشتری و تسویه مطالبات.", risk: "medium", audit: true, implies: [P.ledgerView] },
  { key: P.financePayablesManage, group: "finance", label: "پرداخت به تأمین‌کننده", description: "ثبت پرداخت به تأمین‌کننده و تسویه بدهی‌ها.", risk: "medium", audit: true, implies: [P.ledgerView] },
  { key: P.financeChequesManage, group: "finance", label: "مدیریت چک", description: "ثبت چک دریافتی و پرداختی و تغییر وضعیت آن (وصول، برگشت، انتقال).", risk: "medium", audit: true, implies: [P.ledgerView] },
  { key: P.financeInstallmentsManage, group: "finance", label: "مدیریت اقساط", description: "تعریف طرح اقساط و ثبت پرداخت هر قسط.", risk: "medium", audit: true, implies: [P.ledgerView] },
  { key: P.financeReconciliationManage, group: "finance", label: "تطبیق بانکی", description: "ایجاد و تکمیل تطبیق صورت‌حساب بانکی با دفاتر.", risk: "medium", audit: true, implies: [P.ledgerView] },
  { key: P.financeAssetsManage, group: "finance", label: "دارایی‌های ثابت", description: "نگهداری دفتر دارایی‌های ثابت و اجرای استهلاک دوره‌ای.", risk: "medium", audit: true, implies: [P.ledgerView] },

  // --- Payroll -------------------------------------------------------------
  // Its own group because compensation data is sensitive in a way the rest of
  // the ledger is not. The default presets give both keys to the owner, the
  // admin and the accountant and neither to the manager; a business can still
  // grant or revoke either one per member.
  { key: P.payrollView, group: "payroll", label: "مشاهده حقوق و دستمزد", description: "دیدن احکام حقوقی، لیست‌های حقوق و مبالغ پرداختی پرسنل.", risk: "high", audit: true },
  { key: P.payrollManage, group: "payroll", label: "اجرای حقوق و دستمزد", description: "تعریف حکم حقوقی، صدور لیست حقوق و پرداخت یا ابطال آن.", risk: "critical", audit: true, implies: [P.payrollView] },

  // --- Reports -------------------------------------------------------------
  { key: P.reportsView, group: "reports", label: "مشاهده گزارش‌ها", description: "دیدن گزارش‌های فروش، مالی و عملیاتی و اجرای گزارش‌های آماده و ذخیره‌شده.", risk: "low", audit: false },
  { key: P.reportsManage, group: "reports", label: "مدیریت گزارش‌های ذخیره‌شده", description: "ساخت، ویرایش، تغییر نام و حذف گزارش‌های سفارشی و ذخیرهٔ چیدمان شخصی داشبورد.", risk: "medium", audit: true, implies: [P.reportsView] },
  { key: P.reportsExport, group: "reports", label: "خروجی گزارش", description: "دانلود گزارش‌ها به صورت فایل (CSV، اکسل، PDF).", risk: "medium", audit: true, implies: [P.reportsView] },
  { key: P.reportsBusinessWide, group: "reports", label: "گزارش سراسری شعب", description: "دیدن و خروجی گرفتن از اعداد تجمیعی همهٔ شعب کسب‌وکار (مقایسهٔ شعبه‌ها). مخصوص مالک.", risk: "critical", audit: true, implies: [P.reportsView] },
  { key: P.reportsDashboardDefaultsManage, group: "reports", label: "مدیریت پیش‌فرض داشبورد نقش‌ها", description: "تعیین چیدمان پیش‌فرض ویجت‌های گزارش برای هر نقش؛ همهٔ اعضای آن نقش این چیدمان را می‌بینند.", risk: "medium", audit: true, implies: [P.reportsView] },

  // --- Growth --------------------------------------------------------------
  { key: P.growthView, group: "growth", label: "میز کار رشد", description: "داشبورد مدیریتی رشد، بینش مخاطبان و پل حسابداری رشد. ابزار صندوق نیست.", risk: "medium", audit: false },
  { key: P.campaignsView, group: "growth", label: "مشاهده کمپین‌ها", description: "دیدن کمپین‌های تخفیف، اثربخشی آن‌ها و کمپین‌های پیامی بدون اجرای آن‌ها.", risk: "low", audit: false },
  { key: P.campaignsManage, group: "growth", label: "اجرای کمپین", description: "ساخت، توقف و ارسال کمپین تخفیف و کمپین پیامی.", risk: "high", audit: true, implies: [P.campaignsView] },
  { key: P.loyaltyView, group: "growth", label: "مشاهده باشگاه مشتریان", description: "مشاهده برنامه‌های وفاداری، امتیاز و اعتبار فروشگاهی مشتری و یادآوری خرید مجدد.", risk: "low", audit: false },
  { key: P.loyaltyManage, group: "growth", label: "پیکربندی باشگاه مشتریان", description: "تعریف و تغییر برنامه وفاداری و قواعد امتیاز.", risk: "high", audit: true, implies: [P.loyaltyView] },
  { key: P.loyaltyRedeem, group: "growth", label: "استفاده از امتیاز مشتری", description: "خرج کردن امتیاز وفاداری مشتری هنگام خرید.", risk: "medium", audit: true, implies: [P.loyaltyView] },
  { key: P.storeCreditIssue, group: "growth", label: "صدور اعتبار فروشگاهی", description: "ایجاد اعتبار فروشگاهی برای مشتری. یک بدهی تازه برای کسب‌وکار می‌سازد.", risk: "high", audit: true, implies: [P.loyaltyView] },
  { key: P.storeCreditPayout, group: "growth", label: "بازپرداخت اعتبار فروشگاهی", description: "پرداخت نقدی یا بانکی ماندهٔ اعتبار فروشگاهی مشتری. پول از صندوق یا حساب خارج می‌شود.", risk: "high", audit: true, implies: [P.loyaltyView] },
  { key: P.giftCardsView, group: "growth", label: "استعلام کارت هدیه", description: "دیدن موجودی و وضعیت کارت هدیه با کد آن.", risk: "low", audit: false },
  { key: P.giftCardsIssue, group: "growth", label: "صدور کارت هدیه", description: "صدور کارت هدیه تازه؛ ارزش آن به‌عنوان بدهی در دفاتر ثبت می‌شود.", risk: "high", audit: true, implies: [P.giftCardsView] },
  { key: P.giftCardsRedeem, group: "growth", label: "مصرف کارت هدیه", description: "کسر مبلغ از موجودی کارت هدیه.", risk: "medium", audit: true, implies: [P.giftCardsView] },
  { key: P.commissionView, group: "growth", label: "مشاهده پورسانت", description: "دیدن قواعد پورسانت و گزارش پورسانت فروشندگان. دادهٔ جبران خدمت است.", risk: "high", audit: true },
  { key: P.commissionManage, group: "growth", label: "مدیریت پورسانت", description: "تعریف و تغییر قواعد پورسانت فروشندگان.", risk: "high", audit: true, implies: [P.commissionView] },
  { key: P.marketingConfigure, group: "growth", label: "تنظیمات رشد و بازاریابی", description: "پیکربندی سراسری برنامه رشد، جدا از اجرای یک کمپین.", risk: "high", audit: true, implies: [P.growthView] },

  // --- Website -------------------------------------------------------------
  { key: P.websiteView, group: "website", label: "مشاهده وب‌سایت", description: "باز کردن مدیریت وب‌سایت و دیدن وضعیت کلی آن.", risk: "low", audit: false },
  { key: P.websiteManage, group: "website", label: "مدیریت وب‌سایت", description: "کارهای وب‌سایت که نه محتوای CMS هستند و نه فروشگاه ووکامرس.", risk: "medium", audit: false, implies: [P.websiteView] },
  { key: P.websiteSettingsManage, group: "website", label: "تنظیمات وب‌سایت", description: "تنظیمات سطح وب‌سایت، جدا از محتوا و فروشگاه.", risk: "medium", audit: true, implies: [P.websiteView] },
  { key: P.cmsView, group: "website", label: "مشاهده محتوای سایت", description: "دیدن محتوا، محصولات و پیش‌نویس‌های سایت‌ساز.", risk: "low", audit: false },
  { key: P.cmsContentManage, group: "website", label: "ویرایش محتوای سایت", description: "ویرایش پیش‌نویس‌ها، نوشته‌ها، محصولات و رسانه.", risk: "medium", audit: false, implies: [P.cmsView] },
  { key: P.cmsPublish, group: "website", label: "انتشار در سایت", description: "منتشر کردن پیش‌نویس روی سایت عمومی. بلافاصله برای همه قابل مشاهده می‌شود.", risk: "high", audit: true, implies: [P.cmsView] },
  { key: P.cmsConfigure, group: "website", label: "پیکربندی سایت", description: "دامنه، DNS، CDN و راه‌اندازی سایت. می‌تواند سایت را از دسترس خارج کند.", risk: "critical", audit: true, implies: [P.cmsView] },
  { key: P.woocommerceView, group: "website", label: "مشاهده ووکامرس", description: "دیدن سفارش‌ها، محصولات و صف همگام‌سازی فروشگاه.", risk: "low", audit: false },
  { key: P.woocommerceManage, group: "website", label: "مدیریت ووکامرس", description: "ویرایش محتوای فروشگاه و سفارش‌های ووکامرس.", risk: "medium", audit: true, implies: [P.woocommerceView] },
  { key: P.woocommerceSync, group: "website", label: "همگام‌سازی ووکامرس", description: "تلاش مجدد و مدیریت صف ارسال قیمت و موجودی به فروشگاه.", risk: "medium", audit: true, implies: [P.woocommerceView] },
  { key: P.woocommerceConfigure, group: "website", label: "پیکربندی ووکامرس", description: "تنظیم اتصال فروشگاه ووکامرس.", risk: "high", audit: true, implies: [P.woocommerceView] },
  { key: P.integrationsView, group: "website", label: "مشاهده اتصال‌ها", description: "دیدن اتصال‌های بیرونی کسب‌وکار.", risk: "low", audit: false },
  { key: P.integrationsManage, group: "website", label: "مدیریت اتصال‌ها", description: "ایجاد و تغییر اتصال‌های بیرونی.", risk: "high", audit: true, implies: [P.integrationsView] },
  { key: P.mediaView, group: "website", label: "مشاهده رسانه", description: "دیدن کتابخانه رسانه.", risk: "low", audit: false },
  { key: P.mediaManage, group: "website", label: "مدیریت رسانه", description: "بارگذاری و ویرایش فایل‌های رسانه.", risk: "medium", audit: false, implies: [P.mediaView] },
  { key: P.printingExecute, group: "settings", label: "چاپ عملیاتی", description: "ارسال سند به چاپگر طبق قواعد ذخیره‌شده.", risk: "low", audit: false },
  { key: P.billingView, group: "settings", label: "مشاهده اشتراک", description: "دیدن طرح، صورتحساب و وضعیت اشتراک.", risk: "low", audit: false },
  { key: P.billingManage, group: "settings", label: "مدیریت اشتراک", description: "تغییر طرح و پرداخت اشتراک.", risk: "high", audit: true, implies: [P.billingView] },

  // --- Data transfer -------------------------------------------------------
  { key: P.dataImport, group: "data", label: "ورود داده انبوه", description: "بارگذاری فایل برای ایجاد یا به‌روزرسانی انبوه رکوردها. همیشه با مجوز خودِ آن بخش ترکیب می‌شود.", risk: "high", audit: true },
  { key: P.dataExport, group: "data", label: "خروج داده انبوه", description: "دریافت خروجی انبوه. همیشه با مجوز خودِ آن بخش ترکیب می‌شود.", risk: "high", audit: true },

  // --- Team ----------------------------------------------------------------
  { key: P.teamView, group: "team", label: "مشاهده تیم", description: "دیدن فهرست همکاران، نقش و دسترسی آن‌ها بدون امکان تغییر.", risk: "low", audit: false },
  { key: P.teamManage, group: "team", label: "مدیریت تیم", description: "افزودن، تعلیق و پایان همکاری، بازنشانی رمز و PIN، دعوت‌نامه‌ها.", risk: "high", audit: true, implies: [P.teamView] },
  { key: P.teamPermissionsManage, group: "team", label: "مدیریت نقش و دسترسی", description: "تغییر نقش و مجوزهای فردی همکاران. راهی است که یک مدیر می‌تواند دسترسی خودش را گسترش دهد.", risk: "critical", audit: true, implies: [P.teamView] },

  // --- Settings & branches -------------------------------------------------
  { key: P.settingsManage, group: "settings", label: "مدیریت تنظیمات", description: "تنظیمات کسب‌وکار، مالیات، چاپ و پیکربندی عمومی.", risk: "medium", audit: true },
  { key: P.locationsManage, group: "settings", label: "مدیریت شعب", description: "ایجاد، ویرایش و غیرفعال کردن شعبه.", risk: "high", audit: true },
  { key: P.backupManage, group: "settings", label: "اجرای پشتیبان", description: "گرفتن پشتیبان و دیدن وضعیت آن.", risk: "high", audit: true },
  { key: P.backupConfigure, group: "settings", label: "پیکربندی پشتیبان", description: "تنظیم مقصد و زمان‌بندی پشتیبان. مخصوص مالک.", risk: "critical", audit: true },
  { key: P.backupExport, group: "settings", label: "خروجی کل داده‌ها", description: "تحویل کل داده کسب‌وکار. مخصوص مالک.", risk: "critical", audit: true },
  { key: P.backupRestore, group: "settings", label: "بازیابی پشتیبان", description: "جایگزین کردن داده‌های فعلی با یک پشتیبان. مخصوص مالک.", risk: "critical", audit: true },
  { key: P.rollupManage, group: "settings", label: "تجمیع شعب", description: "اجرای گزارش تجمیعی بین شعب. مخصوص مالک.", risk: "critical", audit: true },

  // --- Security ------------------------------------------------------------
  { key: P.apiManage, group: "security", label: "مدیریت کلیدهای API", description: "ساخت و ابطال اعتبارنامه‌های بلندمدت برای سامانه‌های بیرونی.", risk: "critical", audit: true },
];

/**
 * `ownerOnly`/`delegatable` are derived from `OWNER_ONLY_PERMISSIONS` rather
 * than restated here, so the registry can never disagree with the code that
 * actually enforces them.
 */
export const PERMISSION_METADATA: Record<Permission, PermissionMetadata> = Object.fromEntries(
  DRAFTS.map((d) => {
    const ownerOnly = isOwnerOnlyPermission(d.key);
    return [d.key, { ...d, ownerOnly, delegatable: d.delegatable ?? !ownerOnly }];
  }),
) as Record<Permission, PermissionMetadata>;

export function permissionMetadata(key: Permission): PermissionMetadata {
  return PERMISSION_METADATA[key];
}

/** Every permission in a group, in catalogue order. */
export function permissionsInGroup(group: PermissionGroup): PermissionMetadata[] {
  return DRAFTS.filter((d) => d.group === group).map((d) => PERMISSION_METADATA[d.key]);
}

/**
 * The keys `selected` implies but does not contain — what the role editor must
 * switch on for the selection to mean anything. Resolved transitively, because
 * `orders.amend_closed` implies `orders.void` and the chain can be longer than
 * one step; a cycle (which would be a bug in the table above) terminates
 * because each key is visited once.
 */
export function impliedPermissions(selected: Iterable<Permission>): Permission[] {
  const result = new Set<Permission>();
  const seen = new Set<Permission>();
  const walk = (key: Permission) => {
    if (seen.has(key)) return;
    seen.add(key);
    for (const implied of PERMISSION_METADATA[key]?.implies ?? []) {
      result.add(implied);
      walk(implied);
    }
  };
  for (const key of selected) walk(key);
  for (const key of selected) result.delete(key);
  return [...result];
}

/**
 * Permission search for the role editor: matches the key, the label, the
 * description and the group name, so «بازگشت وجه», "refund" and
 * "payments.refund" all find the same row.
 */
export function searchPermissions(term: string): PermissionMetadata[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return ALL_PERMISSIONS.map((k) => PERMISSION_METADATA[k]);
  return ALL_PERMISSIONS
    .map((k) => PERMISSION_METADATA[k])
    .filter((m) =>
      [m.key, m.label, m.description, m.group, GROUP_LABELS[m.group]]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
}

/** High-risk keys, for the role editor's warning treatment. */
export function isDangerousPermission(key: Permission): boolean {
  const risk = PERMISSION_METADATA[key]?.risk;
  return risk === "high" || risk === "critical";
}
