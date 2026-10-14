/**
 * Issue #799 §26 — the AEC registers' deployment-mode classification.
 *
 * §26 asks for an audit, not for replication: *"Audit all new entities for
 * deployment-mode behavior … Classify each new entity … If new entities are
 * replicated, update [the replication catalogue, sync registry, pairing
 * snapshot, drift checks, desktop bootstrap, sync tests, conflict behavior]."*
 * This module is that audit, written down where the platform's own replication
 * contract can see it rather than left in a document nobody checks.
 *
 * ## The decision it records
 *
 * **Nothing in the AEC register set replicates today, and that is a decision,
 * not an omission.** The desktop install is a *till*: `site-routes.ts` keeps
 * selling, the floor, the kitchen, shifts and the machine's own settings local,
 * and every other screen is cloud-by-default. An AEC business has no `pos`,
 * `orders` or `stock` module at all, so a paired AEC desktop opens with nothing
 * local to run and shows the cloud pane — which is exactly what §26 asks for
 * instead of a silently-created "cloud-only AEC workflow where the desktop
 * architecture expects operational continuity": there is no AEC workflow on the
 * desktop to lose continuity of, and this file says so with reasons.
 *
 * ## Why the two buckets are not the same protocol
 *
 * §26 names eleven **good offline candidates** — tasks, checklists, site logs,
 * site photo metadata, inspections, snag lists, daily progress, document
 * metadata, drawing metadata, RFI drafts and submittal review drafts — and then
 * says the financial/high-risk ones *"need deliberate sync/event semantics and
 * conflict policy. Do not simply put transactional commercial/accounting
 * operations into generic last-write-wins master-data sync."* The difference is
 * real and it is a property of the *record*, not of the table: a site log is a
 * signed fact about a day (append and amend it under its own rule), while a
 * commitment, a certificate or a variation is a status machine whose terminal
 * states move money and feed Accounting. Merging the second kind field by field
 * would let two branches agree that an award exists at two different values —
 * a state the registers' own trigger guards refuse.
 *
 * So each entry below carries the *write model* that put it in its bucket and,
 * for the candidates, the **boundary** that may ever leave the cloud (a draft,
 * never a frozen row) plus what a future protocol has to add first. Changing a
 * classification is therefore a code change with a reason, not a table name
 * appended to `MASTER_SYNC_TABLES`.
 *
 * ## The guard
 *
 * `aecSyncClassificationProblems(tables)` is the CI half: given the schema's
 * real table list it reports any AEC table that no entry claims (`uncovered`)
 * and any table an entry claims that the schema does not have (`unknown`). The
 * database suite runs it against PostgreSQL, and asserts none of these tables
 * carries the master-data capture trigger — the mechanism §26 forbids using for
 * them — so a later wave cannot quietly make a commercial register
 * last-write-wins by adding one line to the sync registry.
 *
 * `src/lib/replication-catalogue.ts` carries the two domains this classification
 * projects into (`aec_field_capture`, `aec_commercial_registers`), both
 * `cloud_only`, which is what the pairing screen's coverage copy reads.
 */

/** §26's two buckets, plus the identity data a field app would read but never own. */
export type AecSyncClass = "offline_candidate" | "financial_or_high_risk" | "cloud_reference";

export const AEC_SYNC_CLASS_LABELS: Record<AecSyncClass, string> = {
  offline_candidate: "کاندید کار در حالت آفلاین",
  financial_or_high_risk: "مالی یا پرخطر — نیازمند رویداد و سیاست تعارض صریح",
  cloud_reference: "دادهٔ مرجع ابری",
};

/**
 * How the record is written, which is what decides its bucket.
 *
 *   * `append_fact` — a fact about something that happened (a day, a photo, an
 *     observation). Idempotent by its own key; a later edit is an amendment, and
 *     the register's guard already says when that is allowed.
 *   * `signed_record` — a record that is frozen the moment it is submitted and
 *     has a review step attached (a submitted RFI's answer, a submittal
 *     revision under review). Only its *draft* half is a candidate.
 *   * `state_machine` — a chain whose transitions are gated by a permission and
 *     whose terminal states move money.
 *   * `derived_by_register` — a figure or a status another register computes;
 *     if it ever needs to travel it travels as the fact, never as the number.
 */
export type AecSyncWriteModel =
  | "append_fact"
  | "signed_record"
  | "state_machine"
  | "derived_by_register";

export interface AecSyncClassificationEntry {
  /** Stable key used by the catalogue and the tests. */
  key: string;
  label: string;
  class: AecSyncClass;
  /** The tables this family owns — the set the guard compares with the schema. */
  tables: readonly string[];
  /** Where the family lives on screen, so the classification can be checked. */
  surface: string;
  writeModel: AecSyncWriteModel;
  /**
   * The part that may ever leave the cloud. `null` means none of it: the whole
   * family is cloud-only for as long as it is this class.
   */
  offlineBoundary: string | null;
  /** What a future field-capture protocol has to add before the class changes. */
  requirement: string;
  /** The conflict rule that would apply if it ever travelled. */
  conflictRule: string;
  /** §26's own language, quoted where it applies. */
  reason: string;
}

/**
 * Every AEC table, in one of §26's buckets. Ordered the way the phase doc tells
 * the story: the field first (§26's candidates), then the commercial registers,
 * then the reference data that sits behind both.
 */
export const AEC_SYNC_CLASSIFICATION: readonly AecSyncClassificationEntry[] = [
  {
    key: "tasks",
    label: "وظایف پروژه",
    class: "offline_candidate",
    tables: ["ai_project_tasks"],
    surface: "تب وظایف و نمای کلی پروژه",
    writeModel: "append_fact",
    offlineBoundary: "وظیفهٔ ساخت یا ویرایش‌شده روی دستگاه، تا زمانی که همگام شود",
    requirement:
      "وظایف امروز در `ai_project_tasks` هستند و هیچ رویدادی ندارند: برای کار آفلاین باید یک رویداد `task.*` با کلید تکرارپذیر، یک میدان بازبینی (revision) برای حل تعارض ویرایش هم‌زمان دو دستگاه، و بروزرسانی snapshot/bootstrap اضافه شود.",
    conflictRule:
      "ادغام میدانی با آخرین بازبینی برنده؛ حذف فقط نرم (بایگانی) تا وظیفهٔ ارجاع‌شده از تاریخی حذف نشود.",
    reason: "«tasks» در فهرست کاندیدهای §26 است و ثبت آن یک واقعیت دربارهٔ کار است، نه یک تراکنش مالی.",
  },
  {
    key: "checklists",
    label: "چک‌لیست‌های بازرسی",
    class: "offline_candidate",
    tables: ["aec_inspection_checklists", "aec_inspection_checklist_items"],
    surface: "تب بازرسی و کنترل کیفیت — الگوهای چک‌لیست",
    writeModel: "append_fact",
    offlineBoundary: "الگوی چک‌لیست و پاسخ‌های آن روی دستگاه، تا زمان همگام‌سازی",
    requirement:
      "پرکردن چک‌لیست روی موبایل بدون شبکه، امروز ممکن نیست: هر پاسخ باید یک ردیف با شناسهٔ خودش بنویسد و بررسی «همهٔ بندها پاسخ داده شده» باید سمت دستگاه هم اجرا شود، وگرنه بازرسی نیمه‌کاره به سرور می‌رسد.",
    conflictRule:
      "هر پاسخ ردیف خودش است؛ تعارض با اتحاد پاسخ‌ها حل می‌شود و ویرایش یک پاسخ، ویرایش همان ردیف است.",
    reason: "«checklists» و «complete checklist» در §26 و §25 نام برده شده‌اند و ماهیت آن‌ها ثبت مشاهده است.",
  },
  {
    key: "site_logs",
    label: "روزنگار کارگاه و روزهای اجرا",
    class: "offline_candidate",
    tables: ["aec_site_logs", "aec_site_log_lines"],
    surface: "تب کارگاه — روزنگار",
    writeModel: "signed_record",
    offlineBoundary:
      "پیش‌نویس روز روی دستگاه؛ روز «ارسال‌شده» فقط با رویداد صریح و پس از تأیید سرور قابل تغییر است",
    requirement:
      "«submit» یک روز را در دیتابیس ثابت می‌کند (تریگر `aec_site_log_guard`) و خطوط آن روز را با آن قفل می‌کند؛ برای کار آفلاین باید پیش‌نویس‌ها با شناسهٔ محلی نوشته شوند، عدد روز پس از همگام‌سازی از سرور گرفته شود (شماره‌گذاری سرور مرجع است) و ارسال، یک رویداد صریح باشد تا امضا در دو جا معنا نشود.",
    conflictRule:
      "پیش‌نویس: آخرین نوشته برنده. ارسال: یک‌بار و تکرارپذیر؛ پس از ارسال هر تغییر با کد خطای همان تریگر رد می‌شود.",
    reason: "«site logs» و «daily progress» در فهرست §26 هستند و §19 («یک روز امضا می‌شود») را نمی‌شکنند اگر ارسال، رویداد باشد.",
  },
  {
    key: "site_photos",
    label: "فرادادهٔ عکس‌های کارگاه",
    class: "offline_candidate",
    tables: ["workspace_documents"],
    surface: "پیوست هر رکورد AEC از طریق `workspace_document-links`",
    writeModel: "append_fact",
    offlineBoundary: "فراداده و صف آپلود عکس؛ خودِ فایل وقتی شبکه هست منتقل می‌شود",
    requirement:
      "فراداده امروز ردیف `workspace_documents` است و با `AttachmentColumn` به هر ثبت AEC وصل می‌شود؛ §25 «clear upload progress» می‌خواهد، یعنی صف آپلود سمت دستگاه با وضعیت هر فایل (در انتظار/در حال/انجام‌شده/خطا) و تلاش دوباره — نه انتقال کامل مخزن رسانه که `mediaTransfer` آن را در کاتالوگ replication «on_demand» نگه داشته است.",
    conflictRule:
      "فراداده: درج تکرارپذیر با شناسهٔ محلی فایل؛ اگر فایل نرسیده باشد ردیف «بدون فایل» می‌ماند و حذف نمی‌شود.",
    reason: "«site photos metadata» در §26 است؛ خودِ بایت‌ها در کاتالوگ replication جداگانه و on_demand هستند.",
  },
  {
    key: "inspection_and_snags",
    label: "بازرسی‌ها، عدم‌انطباق‌ها و نقص‌ها",
    class: "offline_candidate",
    tables: ["aec_site_issues", "aec_site_issue_checks"],
    surface: "تب کارگاه — بازرسی و کنترل کیفیت و فهرست نقص‌ها",
    writeModel: "append_fact",
    offlineBoundary:
      "ثبت مورد و بررسی‌های آن روی دستگاه؛ «بسته‌شدن» همیشه با تأیید سرور (نیازمند `workspace.approve`)",
    requirement:
      "شمارهٔ مورد (`SN-…`/`NCR-…`) را سرور با `nextAecNumber` و قفل مشورتی می‌سازد؛ برای کار آفلاین باید شناسهٔ محلی تا زمان همگام‌سازی شماره را نگه دارد و بستن مورد (که در §14 به `workspace.approve` و تأیید مجدد نیاز دارد) از مسیر آفلاین خارج بماند.",
    conflictRule:
      "درج تکرارپذیر با شناسهٔ محلی؛ وضعیت فقط با رویداد تغییر می‌کند و بستن یک مورد هرگز از ادغام میدانی نتیجه نمی‌شود.",
    reason: "«inspections» و «snag lists» در §26 هستند؛ §14 بستن را به تأیید انسانی گره زده و همان مرز باید حفظ شود.",
  },
  {
    key: "document_and_drawing_metadata",
    label: "فرادادهٔ نقشه‌ها، اسناد و بازنگری‌ها",
    class: "offline_candidate",
    tables: ["aec_documents", "aec_document_revisions"],
    surface: "تب نقشه‌ها و اسناد و «آخرین بازنگری نقشه»",
    writeModel: "derived_by_register",
    offlineBoundary: "خواندن آخرین بازنگری برای «چه چیزی باید ساخته شود»؛ هیچ نوشتنی روی دستگاه نیست",
    requirement:
      "«latest revision» سمت دیتابیس از بازنگری‌ها مشتق می‌شود (`aec_document_revision_totals`) و ابلاغ (transmittal) دقیقاً همان بازنگری را قفل می‌کند؛ برای نمایش آفلاین آخرین بازنگری، کافی است همان رکوردهای مشتق به‌صورت فقط-خواندنی به دستگاه برسند — و صدور سند (که در `financial_or_high_risk` است) هرگز از دستگاه صادر نشود.",
    conflictRule: "فقط-خواندنی: تعارضی وجود ندارد، و نوشتن روی دستگاه مجاز نیست.",
    reason: "«document metadata» و «drawing metadata» و «view latest drawing» در §26/§25 هستند؛ خواندن بی‌خطر است، صدور سند نیست.",
  },
  {
    key: "rfi_drafts",
    label: "پیش‌نویس استعلام (RFI)",
    class: "offline_candidate",
    tables: ["aec_rfis"],
    surface: "تب استعلام‌ها (RFI)",
    writeModel: "signed_record",
    offlineBoundary:
      "فقط وضعیت `draft`: پرسش و تاریخ؛ ارسال (که پرسش را ثابت می‌کند) از مسیر آفلاین بیرون است",
    requirement:
      "تریگر `aec_rfi_guard` پرسش را از لحظهٔ ارسال ثابت می‌کند؛ برای پیش‌نویس آفلاین، شناسهٔ محلی، شمارهٔ سرور پس از همگام‌سازی، و یک «ارسال» صریح لازم است تا دو دستگاه نتوانند یک RFI را با دو پرسش به سرور بفرستند.",
    conflictRule:
      "پیش‌نویس: آخرین ویرایش برنده. ارسال: تکرارپذیر و یک‌طرفه؛ پس از ارسال، تغییر پرسش با خطای همان تریگر رد می‌شود.",
    reason: "«RFI drafts» صریحاً در §26 آمده است — و فقط پیش‌نویس آن، نه پاسخ و اثر مالی آن.",
  },
  {
    key: "submittal_review_drafts",
    label: "پیش‌نویس بررسی سابمیتال",
    class: "offline_candidate",
    tables: ["aec_submittals", "aec_submittal_revisions"],
    surface: "تب سابمیتال‌ها و صف بررسی",
    writeModel: "signed_record",
    offlineBoundary: "فقط پیش‌نویس بازنگری و یادداشت بازبین؛ تصمیم (approved/rejected/…) از مسیر آفلاین بیرون است",
    requirement:
      "تصمیم بازنگری از صف `workspace_approvals` می‌گذرد و `workspace.approve` می‌خواهد (§24)؛ پس فقط پیش‌نویس یادداشت بازبین و فرادادهٔ بازنگری می‌تواند آفلاین نوشته شود، و تصمیم همیشه روی سرور گرفته می‌شود.",
    conflictRule: "پیش‌نویس: آخرین نوشته برنده. تصمیم: فقط سرور، با همان صف تأیید و همان مجوز.",
    reason: "«submittal review drafts» در §26 است؛ خود «review submittal» در §25 یک تصمیم است، نه یک ویرایش.",
  },

  {
    key: "boq_and_estimates",
    label: "برآورد، متره و فهرست‌بهای مصوب",
    class: "financial_or_high_risk",
    tables: [
      "aec_estimates",
      "aec_estimate_versions",
      "aec_boq_sections",
      "aec_boq_items",
      "aec_estimate_events",
    ],
    surface: "تب برآورد و متره (BOQ)",
    writeModel: "state_machine",
    offlineBoundary: null,
    requirement:
      "یک نسخهٔ مصوب، بودجهٔ کاری پروژه را تغییر می‌دهد و در دیتابیس پس از تأیید قفل می‌شود. اگر روزی لازم شد، مترهٔ در جریان باید به‌صورت رویداد `boq.version.*` با شناسهٔ نسخه و تصمیم صریح سرور منتقل شود، نه با ادغام میدانی ردیف‌های قیمت.",
    conflictRule:
      "نسخه‌ای و تصمیمی: هر نسخه یک رویداد مستقل است و تعارض با «شمارهٔ نسخه» حل می‌شود؛ جمع مبالغ هیچ‌وقت ادغام نمی‌شود.",
    reason:
      "§30 می‌گوید ارقام مالی باید از حسابداری خوانده شوند و §24 می‌گوید عمل مالی پرخطر مجوز جدا می‌خواهد؛ برآورد مصوب، مبنای همین اعداد است.",
  },
  {
    key: "variations",
    label: "تغییرات و دستور کارها",
    class: "financial_or_high_risk",
    tables: ["aec_variations", "aec_contract_commercials"],
    surface: "تب تغییرات و بلوک تجاری قرارداد",
    writeModel: "state_machine",
    offlineBoundary: null,
    requirement:
      "ارزش اصلاح‌شدهٔ قرارداد با تریگر از تغییرات تأییدشده مشتق می‌شود؛ یک ادغام آخرین‌نویسنده-برنده می‌تواند دو دستگاه را به دو ارزش قرارداد برساند. هر انتقال وضعیت باید رویداد صریح با تصمیم تأییدکننده باشد.",
    conflictRule:
      "ماشین وضعیت با تصمیم تأییدکننده؛ تعارض با «آخرین تصمیم» حل می‌شود و ادغام میدانی ممنوع است.",
    reason: "§15 و §24: تصویب تغییر، یک تصمیم پرخطر مالی است، نه ویرایش میدان.",
  },
  {
    key: "payment_certificates",
    label: "صورت‌وضعیت‌ها و گواهی‌های پرداخت",
    class: "financial_or_high_risk",
    tables: ["aec_payment_certificates", "aec_payment_certificate_lines"],
    surface: "تب صورت‌وضعیت‌ها و گواهی‌ها",
    writeModel: "state_machine",
    offlineBoundary: null,
    requirement:
      "خالص گواهی محاسبهٔ دیتابیس است و خطوط اندازه‌گیری باید با ناخالص جمع بزنند؛ گواهی‌شدن یعنی پول تأیید شده، پس انتقال وضعیت باید رویداد دارای تصمیم باشد و ارقام هرگز از دستگاه نمی‌آیند.",
    conflictRule:
      "ماشین وضعیت با تصمیم تأییدکننده؛ تعارض با «آخرین تصمیم» و هرگز با ادغام مبلغ.",
    reason: "§16 و §30: «گواهی‌شده» یعنی وصول‌نشده، و مبلغ تأییدشده یک واقعیت حسابداری است.",
  },
  {
    key: "procurement",
    label: "درخواست کالا، استعلام، پیشنهاد و تعهد تأمین",
    class: "financial_or_high_risk",
    tables: [
      "aec_material_requests",
      "aec_material_request_lines",
      "aec_rfqs",
      "aec_rfq_suppliers",
      "aec_supplier_quotations",
      "aec_commitments",
      "aec_commitment_deliveries",
      "aec_procurement_events",
    ],
    surface: "تب تأمین کالا",
    writeModel: "state_machine",
    offlineBoundary: null,
    requirement:
      "تعهد، پول وعده‌داده‌شده است و از لحظهٔ تأیید در پیش‌بینی هزینهٔ نهایی و در هشدار تأخیر اثر می‌گذارد؛ شماره‌گذاری سرور است و هر انتقال وضعیت یک تصمیم. آنچه روزی می‌تواند آفلاین شود «تحویل کالا» به‌عنوان ثبت واقعیت است، آن هم با رویداد و مدرک، نه با ادغام تعهد.",
    conflictRule:
      "ماشین وضعیت با تصمیم تأییدکننده؛ ثبت تحویل تکرارپذیر با شناسهٔ خودش و بدون تغییر وضعیت تعهد.",
    reason:
      "§18 و §24: تحویل یک واقعیت است اما تأیید تعهد یک تصمیم؛ §26 می‌گوید تراکنش‌های تجاری را به ادغام آخرین‌نویسنده-برنده نسپارید.",
  },
  {
    key: "transmittals",
    label: "ابلاغ رسمی اسناد و نقشه‌ها",
    class: "financial_or_high_risk",
    tables: ["aec_transmittals", "aec_transmittal_items", "aec_transmittal_recipients"],
    surface: "تب اسناد — ابلاغ‌ها",
    writeModel: "signed_record",
    offlineBoundary: null,
    requirement:
      "ابلاغ، تصویر یک بازنگری مشخص را در لحظهٔ صدور قفل می‌کند و به طرف بیرونی می‌رود؛ صدور باید رویداد صریح با هویت صادرکننده باشد تا «چه نسخه‌ای به چه کسی رفت» در دو نقطه دو روایت نداشته باشد.",
    conflictRule: "فقط سرور: یک صدور، یک رکورد؛ ادغام فقط برای بازگشت رسید تأییدکننده.",
    reason: "§12: ابلاغ یک مدرک رسمی است؛ §26 آن را در همگام‌سازی عمومی آخرین‌نویسنده-برنده نمی‌خواهد.",
  },
  {
    key: "project_profile_and_participants",
    label: "شناسنامهٔ پروژه و طرف‌های بیرونی",
    class: "cloud_reference",
    tables: [
      "aec_project_profiles",
      "aec_project_participants",
      "aec_business_profiles",
      "workspace_project_phases",
      "aec_commercial_events",
    ],
    surface: "نمای کلی پروژه، اعضا و رویدادهای تجاری",
    writeModel: "derived_by_register",
    offlineBoundary: null,
    requirement:
      "این‌ها دادهٔ مرجع یا تاریخِ رویدادند: پروفایل و طرف‌ها با مدل master-sync امروز (کاتالوگ `parties`) سرو می‌شوند و در دیتابیس سرور می‌مانند. فازها اگر لازم شد باید مثل `ai_project_tasks` رفتار کنند: شناسه، ترتیب و بازه — نه جمع‌های مشتق.",
    conflictRule: "دادهٔ مرجع: نسخهٔ سرور برنده است (همان قاعدهٔ کاتالوگ replication).",
    reason:
      "§22 و §33: پروفایل، طرف‌ها، فازها و تاریخ رویداد باید در یک نسخه معتبر بمانند؛ رویداد تجاری ثبتِ رخداد است، نه یک رکورد قابل‌ادغام.",
  },
] as const;

/** Every table any entry claims — the set the guard compares with the schema. */
export function aecClassifiedTables(): string[] {
  return [...new Set(AEC_SYNC_CLASSIFICATION.flatMap((entry) => [...entry.tables]))].sort();
}

/** The tables whose class allows a future field-capture protocol (§26's first list). */
export function aecOfflineCandidateTables(): string[] {
  return [
    ...new Set(
      AEC_SYNC_CLASSIFICATION.filter((entry) => entry.class === "offline_candidate").flatMap((entry) => [
        ...entry.tables,
      ]),
    ),
  ].sort();
}

/** The tables §26 forbids putting into last-write-wins master-data sync. */
export function aecFinancialTables(): string[] {
  return [
    ...new Set(
      AEC_SYNC_CLASSIFICATION.filter((entry) => entry.class === "financial_or_high_risk").flatMap(
        (entry) => [...entry.tables],
      ),
    ),
  ].sort();
}

/**
 * §26's own list of good offline candidates, mapped onto this catalogue. The
 * keys are §26's words; the values are the entries above. Asserted in the unit
 * test, so an entity named by the issue cannot quietly lose its entry — which is
 * the audit §26 asked for and the reason this map exists at all.
 */
export const AEC_SYNC_ISSUE_OFFLINE_CANDIDATES: Readonly<Record<string, string>> = {
  tasks: "tasks",
  checklists: "checklists",
  "site logs": "site_logs",
  "site photos metadata": "site_photos",
  inspections: "inspection_and_snags",
  "snag lists": "inspection_and_snags",
  "daily progress": "site_logs",
  "document metadata": "document_and_drawing_metadata",
  "drawing metadata": "document_and_drawing_metadata",
  "RFI drafts": "rfi_drafts",
  "submittal review drafts": "submittal_review_drafts",
};

/**
 * The CI half of §26: given the schema's real AEC table list, report the tables
 * no entry claims and the tables an entry claims that do not exist. Both halves
 * matter — the first catches a new register that arrived without a
 * classification, the second catches a rename or a drop that left the
 * classification describing a table nobody has.
 */
export function aecSyncClassificationProblems(schemaTables: readonly string[]): {
  uncovered: string[];
  unknown: string[];
} {
  const classified = new Set(aecClassifiedTables());
  const schema = new Set(schemaTables);
  return {
    uncovered: schemaTables.filter((table) => !classified.has(table)).sort(),
    unknown: [...classified].filter((table) => !schema.has(table)).sort(),
  };
}
