/**
 * The CRM app's shared, framework-free vocabulary.
 *
 * `crm-service.ts` and friends read the database; the app's screens are client
 * components. Anything both halves need — the pipeline stages, the activity
 * and ticket taxonomies, the timeline's event kinds, the consent rules, the
 * money/label conventions the assistant's tools also follow — lives here, so a
 * client import never drags `pg` into the browser. Same posture as
 * `growth-shared.ts` beside `growth-overview.ts`, and `promotions.ts` beside
 * `promotions-service.ts`.
 *
 * Every enum in this file carries its own Persian label. That is Phase 33's
 * rule and it is load-bearing for the assistant: a tool that returns
 * `status: "in_progress"` gives the model nothing but an English token to
 * guess at, and a guess about what a status *means* is the kind of confident
 * wrongness that makes an owner stop trusting the feature. The label is a fact
 * the tool returns, not a translation the model performs.
 */

// ---------------------------------------------------------------------------
// Deals — the pipeline
// ---------------------------------------------------------------------------

/**
 * Why a POS has a pipeline at all.
 *
 * The CRM issue (#367) ruled a deal pipeline out of scope with a good
 * argument: «مشتری خرید می‌کند، نه اینکه در قیف پیش برود» — a walk-in buys a
 * coffee, they do not progress through stages. That is exactly right for the
 * counter, and it is why nothing in the sales path touches this model.
 *
 * It stops being right the moment the sale is not a walk-in: a jeweller
 * quoting a custom ring, a café bidding for an office's weekly catering, a
 * watch shop holding a piece for a customer who is deciding. Those are
 * multi-day, multi-conversation sales with a real probability of not
 * happening, and today they live in a WhatsApp thread and the owner's memory.
 *
 * So the pipeline is here, but it is deliberately **not** wired into the
 * ledger: winning a deal records *no* revenue and posts *no* journal entry.
 * Revenue exists when an order or invoice is settled through the existing
 * sales path, which already posts correctly. A pipeline that also booked
 * revenue would be a second, unreconciled source of truth for the same money —
 * the one thing this codebase's accounting rules never permit. Won deals
 * therefore link *to* an order rather than replacing one.
 */
export const DEAL_STAGES = [
  "lead",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export interface DealStageMeta {
  key: DealStage;
  label: string;
  description: string;
  /** Default win probability (percent) when the user has not overridden it. */
  probability: number;
  /** A stage the deal cannot leave — the pipeline's terminal states. */
  terminal: boolean;
  tone: "active" | "positive" | "neutral" | "danger";
}

export const DEAL_STAGE_META: Record<DealStage, DealStageMeta> = {
  lead: {
    key: "lead",
    label: "سرنخ",
    description: "تماس اولیه گرفته شده؛ هنوز نیاز و بودجه روشن نیست.",
    probability: 10,
    terminal: false,
    tone: "neutral",
  },
  qualified: {
    key: "qualified",
    label: "واجد شرایط",
    description: "نیاز و بودجه مشخص است و خرید محتمل است.",
    probability: 30,
    terminal: false,
    tone: "active",
  },
  proposal: {
    key: "proposal",
    label: "پیش‌فاکتور",
    description: "قیمت و شرایط ارائه شده و منتظر پاسخ است.",
    probability: 55,
    terminal: false,
    tone: "active",
  },
  negotiation: {
    key: "negotiation",
    label: "مذاکره",
    description: "سر قیمت یا شرایط در حال توافق است.",
    probability: 75,
    terminal: false,
    tone: "active",
  },
  won: {
    key: "won",
    label: "برنده",
    description: "به فروش رسید. درآمد از مسیر فاکتور/سفارش ثبت می‌شود، نه از اینجا.",
    probability: 100,
    terminal: true,
    tone: "positive",
  },
  lost: {
    key: "lost",
    label: "از دست رفته",
    description: "به فروش نرسید؛ دلیلش برای گزارش ثبت می‌شود.",
    probability: 0,
    terminal: true,
    tone: "danger",
  },
};

/** The stages a deal is still live in — what «قیف فروش» actually shows. */
export const OPEN_DEAL_STAGES: readonly DealStage[] = DEAL_STAGES.filter(
  (stage) => !DEAL_STAGE_META[stage].terminal,
);

export function isDealStage(value: unknown): value is DealStage {
  return typeof value === "string" && (DEAL_STAGES as readonly string[]).includes(value);
}

/**
 * The weighted value of a pipeline: each open deal's value times its
 * probability. The honest version of "how much is in the pipeline" — the raw
 * sum counts a first-contact lead the same as a signed-tomorrow deal.
 *
 * Terminal deals are excluded entirely rather than counted at 100%/0%: a won
 * deal's money belongs to the ledger, and repeating it here would double-count
 * it against a forecast.
 */
export function weightedPipelineValue(
  deals: { stage: DealStage; valueRial: number; probability: number | null }[],
): number {
  return deals
    .filter((deal) => !DEAL_STAGE_META[deal.stage].terminal)
    .reduce((sum, deal) => {
      const probability = deal.probability ?? DEAL_STAGE_META[deal.stage].probability;
      return sum + Math.round((deal.valueRial * probability) / 100);
    }, 0);
}

/** Win rate over *decided* deals only — open deals are not yet losses. */
export function winRate(deals: { stage: DealStage }[]): number {
  const decided = deals.filter((deal) => DEAL_STAGE_META[deal.stage].terminal);
  if (decided.length === 0) return 0;
  const won = decided.filter((deal) => deal.stage === "won").length;
  return Math.round((won / decided.length) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// Activities — calls, visits, notes, tasks
// ---------------------------------------------------------------------------

export const ACTIVITY_KINDS = ["call", "meeting", "message", "note", "task", "visit"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  call: "تماس",
  meeting: "جلسه",
  message: "پیام",
  note: "یادداشت",
  task: "کار",
  visit: "مراجعه حضوری",
};

export function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === "string" && (ACTIVITY_KINDS as readonly string[]).includes(value);
}

/**
 * An activity is either a record of something that happened or a commitment to
 * do something. `dueAt` in the future with no `completedAt` is the second —
 * that is the whole of the task model, deliberately, rather than a separate
 * table that would need its own list, its own permissions and its own
 * notifications.
 */
export const ACTIVITY_STATES = ["done", "due", "overdue", "planned"] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];

export function isActivityState(value: unknown): value is ActivityState {
  return typeof value === "string" && (ACTIVITY_STATES as readonly string[]).includes(value);
}

/**
 * Field ceilings for an activity. The `subject`/`body` columns are unbounded
 * `text`, which is not the same as "any length is sensible": a paste of a whole
 * chat transcript into the title makes a list nobody can scan, and there is no
 * way to shorten it from the screen. Enforced on the server (the client only
 * mirrors it as a `maxLength` hint), because a limit only the browser knows is
 * not a limit.
 */
export const ACTIVITY_SUBJECT_MAX = 200;
export const ACTIVITY_BODY_MAX = 2000;
export const ACTIVITY_ASSIGNEE_MAX = 120;

export const ACTIVITY_STATE_LABELS: Record<ActivityState, string> = {
  done: "انجام‌شده",
  due: "امروز",
  overdue: "عقب‌افتاده",
  planned: "برنامه‌ریزی‌شده",
};

export const ACTIVITY_STATE_TONES: Record<ActivityState, "active" | "positive" | "neutral" | "danger"> = {
  done: "positive",
  due: "active",
  overdue: "danger",
  planned: "neutral",
};

/**
 * Where an activity stands, relative to a date the caller resolves (the
 * branch's business date — same rule as everywhere else in this app).
 *
 * Inclusive on "today": a task due today is «امروز», not overdue. An owner
 * looking at their morning list should not see the day's own work already
 * marked red.
 */
export function activityState(
  activity: { dueAt: string | null; completedAt: string | null },
  today: string,
): ActivityState {
  if (activity.completedAt) return "done";
  if (!activity.dueAt) return "planned";
  const due = activity.dueAt.slice(0, 10);
  if (due < today) return "overdue";
  if (due === today) return "due";
  return "planned";
}

// ---------------------------------------------------------------------------
// Cases — the service desk
// ---------------------------------------------------------------------------

export const CASE_STATUSES = ["open", "in_progress", "waiting", "resolved", "closed"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  open: "باز",
  in_progress: "در حال بررسی",
  waiting: "منتظر مشتری",
  resolved: "حل‌شده",
  closed: "بسته‌شده",
};

export const CASE_STATUS_TONES: Record<CaseStatus, "active" | "positive" | "neutral" | "danger"> = {
  open: "danger",
  in_progress: "active",
  waiting: "neutral",
  resolved: "positive",
  closed: "neutral",
};

export const CASE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type CasePriority = (typeof CASE_PRIORITIES)[number];

export const CASE_PRIORITY_LABELS: Record<CasePriority, string> = {
  low: "کم",
  normal: "عادی",
  high: "زیاد",
  urgent: "فوری",
};

/**
 * Target response time per priority, in hours. Not an SLA contract — a café
 * signs none — but the thing that makes «کدام شکایت معطل مانده؟» answerable
 * without the owner reading every ticket.
 */
export const CASE_PRIORITY_TARGET_HOURS: Record<CasePriority, number> = {
  urgent: 4,
  high: 24,
  normal: 72,
  low: 168,
};

export function isCaseStatus(value: unknown): value is CaseStatus {
  return typeof value === "string" && (CASE_STATUSES as readonly string[]).includes(value);
}

export function isCasePriority(value: unknown): value is CasePriority {
  return typeof value === "string" && (CASE_PRIORITIES as readonly string[]).includes(value);
}

/** A case still needing someone's attention. */
export function isOpenCase(status: CaseStatus): boolean {
  return status === "open" || status === "in_progress" || status === "waiting";
}

/**
 * Whether a case has missed its priority's target, given how long it has been
 * open. `waiting` deliberately does not breach: the clock belongs to the
 * customer at that point, and marking the shop late for the customer's own
 * silence would make the whole indicator meaningless.
 */
export function caseBreached(
  input: { status: CaseStatus; priority: CasePriority; openedAt: string; resolvedAt: string | null },
  now: Date,
): boolean {
  if (!isOpenCase(input.status) || input.status === "waiting") return false;
  const opened = Date.parse(input.openedAt);
  if (Number.isNaN(opened)) return false;
  const elapsedHours = (now.getTime() - opened) / 3_600_000;
  return elapsedHours > CASE_PRIORITY_TARGET_HOURS[input.priority];
}

// ---------------------------------------------------------------------------
// The customer timeline
// ---------------------------------------------------------------------------

/**
 * Every kind of thing that can appear on a customer's timeline.
 *
 * **A mapping, never a copy.** There is no timeline table: each kind is read
 * from the table that already owns it and merged in the service. A parallel
 * event table would be a second source of truth that can fall behind the first
 * — and it would be *silently* behind, because nothing would ever compare
 * them.
 */
export const TIMELINE_KINDS = [
  "order",
  "payment",
  "points",
  "store_credit",
  "reservation",
  "repair",
  "service_reminder",
  "note",
  "activity",
  "deal",
  "case",
  "consent",
  "merge",
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/**
 * The kinds worth offering in *one customer's* filter chip.
 *
 * `service_reminder` is a shop-facing nudge with no `customer_id` at all
 * (migration 0087 made the column nullable precisely because these rows
 * point at a serial, not a person) — `customerTimeline` can never return one,
 * so a per-customer filter that lists it anyway is an option that always
 * yields an empty page. Every other kind is genuinely one customer's history.
 */
export const CUSTOMER_TIMELINE_KINDS: readonly TimelineKind[] = TIMELINE_KINDS.filter(
  (kind) => kind !== "service_reminder",
);

export const TIMELINE_KIND_LABELS: Record<TimelineKind, string> = {
  order: "خرید",
  payment: "پرداخت",
  points: "امتیاز",
  store_credit: "اعتبار فروشگاهی",
  reservation: "رزرو",
  repair: "تعمیر",
  service_reminder: "یادآوری سرویس",
  note: "یادداشت",
  activity: "فعالیت",
  deal: "معامله",
  case: "پرونده پشتیبانی",
  consent: "تغییر رضایت",
  merge: "ادغام پرونده",
};

/** Money in the three shapes every AI tool returns it in (Phase 33's rule). */
export interface TimelineMoney {
  rial: number;
  toman: number;
  text: string;
}

export interface TimelineEvent {
  /** ISO timestamp — Gregorian in storage and on the wire, Shamsi only at render. */
  at: string;
  kind: TimelineKind;
  kindLabel: string;
  summary: string;
  amount?: TimelineMoney;
  /** Where to go to see the underlying document, when there is one. */
  href?: string;
  /** Extra Persian detail line, when the source has one worth showing. */
  detail?: string;
}

/** Newest first — the order a person reads a history in. */
export function sortTimeline(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

// ---------------------------------------------------------------------------
// Smart queues — the attention feed's vocabulary
// ---------------------------------------------------------------------------
/**
 * The queues, their keys and their words.
 *
 * This vocabulary lives here — beside the pipeline stages and the timeline
 * kinds — because **two halves need it**: the server rules in
 * `crm-queues.ts` that produce a queue, and the command field / section headers
 * that must name it without importing a module that reaches the database. The
 * Persian label of a queue is product copy with exactly one home; before this
 * it was written inline in thirteen SQL builders, which is a copy the client
 * could not read and could silently drift from.
 *
 * `crm-queues.test.ts` pins the agreement in both directions: every key here
 * has a rule, and every rule returns one of these labels.
 */
export const CRM_QUEUE_KEYS = [
  "overdue_follow_ups",
  "due_today",
  "sla_risk",
  "waiting_on_customer",
  "stalled_deals",
  "high_value_open",
  "unassigned_cases",
  "departed_owner",
  "vip_follow_up",
  "at_risk_customers",
  "new_leads",
  "new_identities",
  "possible_duplicates",
] as const;

export type CrmQueueKey = (typeof CRM_QUEUE_KEYS)[number];

/** Days without activity after which an open deal counts as stalled. */
export const STALLED_DEAL_DAYS = 7;
/** Days since the last interaction after which a VIP counts as needing a call. */
export const VIP_SILENCE_DAYS = 30;
/** A new lead is "new" for this long before it becomes a stale enquiry. */
export const NEW_LEAD_DAYS = 7;

export interface CrmQueuePresentation {
  label: string;
  /** Why a row is in this queue. Shown under the heading, always. */
  why: string;
  /** What to do about it, when there is more to it than the list. */
  action: string;
  /** The sections that own this queue — `queueKeysForSection` reads it. */
  sections: readonly string[];
}

export const CRM_QUEUE_PRESENTATION: Record<CrmQueueKey, CrmQueuePresentation> = {
  overdue_follow_ups: {
    label: "پیگیری‌های عقب‌افتاده",
    why: "کارهایی که موعدشان گذشته و هنوز انجام نشده‌اند.",
    action: "هر کدام را انجام دهید یا موعدش را جابه‌جا کنید.",
    sections: ["activities"],
  },
  due_today: {
    label: "کارهای امروز",
    why: "کارهایی که موعدشان امروز است.",
    action: "امروز تمامشان کنید تا فردا عقب‌افتاده نشوند.",
    sections: ["activities"],
  },
  sla_risk: {
    label: "خطر از دست رفتن مهلت",
    why: "تیکت‌های بازی که از مهلت پاسخ‌گویی خودشان گذشته‌اند (زمان انتظار مشتری حساب نمی‌شود).",
    action: "پاسخ بدهید یا به عضو دیگری بسپارید.",
    sections: ["cases"],
  },
  waiting_on_customer: {
    label: "منتظر مشتری",
    why: "کار از سمت ما تمام است و منتظر پاسخ مشتری هستیم.",
    action: "یک یادآوری بفرستید؛ یا اگر پاسخ نیامد تیکت را ببندید.",
    sections: ["cases"],
  },
  stalled_deals: {
    label: "فرصت‌های راکد",
    why: `معامله‌های بازی که ${STALLED_DEAL_DAYS} روز است هیچ فعالیتی نداشته‌اند.`,
    action: "تماس بگیرید، یا اگر دیگر واقعی نیست ببندیدش.",
    sections: ["deals"],
  },
  high_value_open: {
    label: "فرصت‌های پرارزش باز",
    why: "بیست درصد بالای معامله‌های باز از نظر مبلغ — همیشه ارزش یک نگاه دارند.",
    action: "قدم بعدی هر کدام را مشخص کنید؛ این‌ها بیشترین اثر را دارند.",
    sections: ["deals"],
  },
  unassigned_cases: {
    label: "تیکت‌های بی‌مسئول",
    why: "تیکت‌های بازی که مالکی ندارند، پس کسی خودش را مسئولشان نمی‌داند.",
    action: "به یک عضو تیم واگذار کنید.",
    sections: ["cases"],
  },
  departed_owner: {
    label: "کارهای عضو غیرفعال",
    why: "معامله‌ها و تیکت‌هایی که مسئولشان دیگر نمی‌تواند وارد شود، پس کسی پیگیری نمی‌کند.",
    action: "به یک عضو فعال واگذار کنید یا مسئول را بردارید تا در صف بی‌مسئول‌ها بیاید.",
    sections: ["deals", "cases"],
  },
  vip_follow_up: {
    label: "مشتریان طلایی و وفادار",
    why: "`${VIP_SILENCE_DAYS} روز است با بهترین مشتریان تماس نگرفته‌ایم.`",
    action: "یک تماس کوتاه؛ نگه‌داشتن این‌ها ارزان‌تر از جذب تازه است.",
    sections: ["directory"],
  },
  at_risk_customers: {
    label: "مشتریان در معرض ریزش",
    why: "امتیاز رفتاری می‌گوید این‌ها ارزششان را داشته‌اند و حالا دور شده‌اند.",
    action: "تماس شخصی یا پیشنهاد بازگشت؛ پیش از آن‌که فراموش کنند.",
    sections: ["directory"],
  },
  new_leads: {
    label: "سرنخ‌های تازه",
    why: `پرس‌وجوهایی که در ${NEW_LEAD_DAYS} روز گذشته آمده‌اند و هنوز کسی سراغشان نرفته است.`,
    action: "زود تماس بگیرید؛ سرنخ تازه سرد می‌شود.",
    sections: ["leads"],
  },
  new_identities: {
    label: "هویت‌های تازهٔ سایت و فروشگاه",
    why: "خریداران آنلاینی که هنوز به پرونده‌ای وصل نشده‌اند یا تطبیقشان قطعی نیست.",
    action: "تطبیق را تأیید کنید تا خریدشان روی پروندهٔ درست بنشیند.",
    sections: ["reconciliation"],
  },
  possible_duplicates: {
    label: "پرونده‌های مشکوک به تکرار",
    why: "دو پرونده با شمارهٔ تماس یکسان — شاید یک نفر باشند.",
    action: "پیش از ادغام، پیش‌نمایش را ببینید؛ ادغام برگشت‌پذیر نیست.",
    sections: ["duplicates"],
  },
};

/**
 * The queues a section owns, in `CRM_QUEUE_KEYS` order.
 *
 * Derived from the presentation table rather than written as a second switch:
 * a queue added without a section would otherwise be invisible on every screen
 * that should show it, and the section it belongs to would have to be written
 * in two places.
 */
export function queueKeysForSection(section: string): CrmQueueKey[] {
  return CRM_QUEUE_KEYS.filter((key) =>
    CRM_QUEUE_PRESENTATION[key].sections.includes(section),
  );
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

export const CONSENT_CHANNELS = ["sms", "email"] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

export const CONSENT_CHANNEL_LABELS: Record<ConsentChannel, string> = {
  sms: "پیامک",
  email: "ایمیل",
};

/**
 * How consent was obtained or withdrawn. Recorded because «مشتری گفت دیگر
 * نفرستید» has to be *provable* later, not merely acted on — that is the
 * difference between a consent record and a checkbox.
 */
export const CONSENT_SOURCES = ["staff", "customer_request", "import", "merge", "signup"] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export const CONSENT_SOURCE_LABELS: Record<ConsentSource, string> = {
  staff: "ثبت توسط کارکنان",
  customer_request: "درخواست خود مشتری",
  import: "ورود داده",
  merge: "ادغام پرونده",
  signup: "ثبت‌نام",
};

/**
 * Merging two customers' consent: **intersection, never union.**
 *
 * If either record says no, the merged record says no. The alternative — a
 * union — would let a merge silently *grant* a permission neither the customer
 * nor the shop ever gave, which is precisely the failure a consent audit is
 * meant to make impossible. Losing a real consent is recoverable by asking
 * again; inventing one is not.
 */
export function mergeConsent(left: boolean, right: boolean): boolean {
  return left && right;
}

/** Merging tags is a union — a tag is a description, and neither record's is wrong. */
export function mergeTags(left: string[] | null, right: string[] | null): string[] {
  return [...new Set([...(left ?? []), ...(right ?? [])])].filter((tag) => tag.trim() !== "");
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export type DuplicateReason = "phone" | "email" | "name";

export const DUPLICATE_REASON_LABELS: Record<DuplicateReason, string> = {
  phone: "شمارهٔ یکسان",
  email: "ایمیل یکسان",
  name: "نام بسیار نزدیک",
};

/**
 * How much to trust a duplicate suggestion, 0-100.
 *
 * A shared normalised phone is near-certain; a shared email is strong; an
 * identical name alone is weak — «محمد محمدی» is not one person. The score
 * exists so the UI can sort and so a low-confidence pair is presented as a
 * question rather than a recommendation. **Nothing merges automatically at any
 * score**: merge is irreversible, so a human sees the preview and presses the
 * button. That rule is enforced in the service, not here.
 */
export function duplicateConfidence(reason: DuplicateReason): number {
  switch (reason) {
    case "phone":
      return 95;
    case "email":
      return 80;
    case "name":
      return 40;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

// The window maths is `date-window.ts`'s — neither this app nor Growth owns
// "the last 30 days", and the two apps used to keep identical copies of it.
// Re-exported here so every existing CRM caller keeps its one import.
export { previousWindow, rollingWindow } from "./date-window";

// ---------------------------------------------------------------------------
// Party relationships
// ---------------------------------------------------------------------------

/**
 * How one party can be connected to another.
 *
 * Here rather than in `crm-relationship-service.ts` because the customer
 * file's relationships card is a client component: importing the service for
 * its labels would drag `pg` into the browser bundle, which is the exact
 * failure this file exists to prevent.
 *
 * The list mirrors the CHECK constraint on `crm_party_relationships.kind` in
 * migration 0157. Adding a kind means changing both, in a new migration.
 */
export const RELATIONSHIP_KINDS = [
  "contact_of",
  "decision_maker",
  "billing_contact",
  "purchasing_contact",
  "owner_of",
  "household",
  "referred_by",
  "parent_organization",
  "branch_of",
] as const;
export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];

export const RELATIONSHIP_LABELS: Record<RelationshipKind, string> = {
  contact_of: "رابط",
  decision_maker: "تصمیم‌گیرنده",
  billing_contact: "رابط مالی",
  purchasing_contact: "رابط خرید",
  owner_of: "مالک",
  household: "هم‌خانواده",
  referred_by: "معرفی‌شده توسط",
  parent_organization: "سازمان مادر",
  branch_of: "شعبهٔ",
};

/** The inverse label, for rendering an edge from the other end. */
export const RELATIONSHIP_INVERSE_LABELS: Record<RelationshipKind, string> = {
  contact_of: "رابط دارد",
  decision_maker: "تصمیم‌گیرنده دارد",
  billing_contact: "رابط مالی دارد",
  purchasing_contact: "رابط خرید دارد",
  owner_of: "متعلق به",
  household: "هم‌خانواده",
  referred_by: "معرفی کرده",
  parent_organization: "زیرمجموعه دارد",
  branch_of: "شعبه دارد",
};

export interface PartyRelationship extends Record<string, unknown> {
  id: string;
  fromPartyId: string;
  fromName: string;
  toPartyId: string;
  toName: string;
  kind: RelationshipKind;
  roleTitle: string;
  isPrimary: boolean;
  note: string;
  /** True when this row was read from the `to` party's point of view. */
  inverse: boolean;
  createdAt: string;
}

export function isRelationshipKind(value: unknown): value is RelationshipKind {
  return typeof value === "string" && (RELATIONSHIP_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The decision log's vocabulary
// ---------------------------------------------------------------------------

/**
 * The audit kinds, labelled.
 *
 * The *keys* are owned by `crm-audit-service.ts` (the write half). This is the
 * display vocabulary beside them, and it lives in `crm-shared.ts` for the usual
 * reason: the audit screen is a client component, and a client component may
 * not value-import a module that reaches `./db` — `crm-app-boundaries.test.ts`
 * fails the build on exactly that.
 *
 * An unknown kind still renders (the screen falls back to the raw key). A
 * deployment where the write half knows a kind the read half has not been
 * taught must show *something* rather than an empty row, and the fallback is
 * also what makes adding a kind a one-file change instead of two.
 */
export const CRM_AUDIT_KIND_LABELS: Record<string, string> = {
  "lead.created": "ایجاد سرنخ",
  "lead.status_changed": "تغییر وضعیت سرنخ",
  "lead.converted": "تبدیل سرنخ به مشتری",
  "deal.created": "ایجاد فرصت",
  "deal.stage_changed": "جابه‌جایی در قیف",
  "deal.owner_changed": "تغییر مالک فرصت",
  "deal.sales_document_linked": "اتصال سند فروش به فرصت",
  "case.created": "ایجاد تیکت",
  "case.status_changed": "تغییر وضعیت تیکت",
  "case.assigned": "واگذاری تیکت",
  "case.reopened": "بازگشایی تیکت",
  "consent.changed": "تغییر رضایت ارتباط",
  "party.merged": "ادغام پرونده‌ها",
  "party.owner_changed": "تغییر مالک پرونده",
  "external.reconciled": "تطبیق هویت بیرونی",
  "external.conflict_resolved": "رفع تعارض هویت بیرونی",
  "segment.changed": "تغییر بخش‌بندی",
  "import.committed": "ورود داده",
  "export.generated": "خروجی داده",
  "custom_field.created": "تعریف فیلد کسب‌وکار",
  "custom_field.archived": "بایگانی فیلد کسب‌وکار",
  "pipeline.created": "ایجاد قیف فروش",
  "pipeline.updated": "ویرایش قیف فروش",
  "pipeline.stages_changed": "تغییر مراحل قیف فروش",
  "relationship.linked": "ایجاد نسبت بین اشخاص",
  "relationship.unlinked": "حذف نسبت بین اشخاص",
  // Automations. Two kinds, and deliberately not one per run: a *rule* is a
  // decision about how the CRM behaves and belongs in this log beside the other
  // configuration decisions, while the runs themselves have their own
  // append-only table (`crm_automation_runs`) where every firing is visible. A
  // growth signal is the exception — it is the moment the CRM asks another app
  // to do something, and somebody will want to know when and why.
  "automation.config_changed": "تغییر اتوماسیون",
  "automation.signal_growth": "اطلاع به رشد و بازاریابی",
};

/** The entity a decision was about, labelled. */
export const CRM_AUDIT_ENTITY_LABELS: Record<string, string> = {
  lead: "سرنخ",
  deal: "فرصت",
  case: "تیکت",
  party: "مشتری",
  segment: "بخش‌بندی",
  external_profile: "هویت بیرونی",
  import: "ورود داده",
  export: "خروجی داده",
  custom_field: "فیلد کسب‌وکار",
  automation: "اتوماسیون",
  pipeline: "قیف فروش",
  relationship: "نسبت",
};

/** The entities the log's filter offers, in menu order. */
export const CRM_AUDIT_ENTITY_TYPES = [
  "lead",
  "deal",
  "case",
  "party",
  "segment",
  "external_profile",
  "custom_field",
  "pipeline",
  "relationship",
  "import",
  "export",
  "automation",
] as const;

/** Human-readable kind, falling back to the raw key for a kind this build has not learned. */
export function crmAuditKindLabel(kind: string): string {
  return CRM_AUDIT_KIND_LABELS[kind] ?? kind;
}

/** Human-readable entity, falling back to the raw value. */
export function crmAuditEntityLabel(entityType: string): string {
  return CRM_AUDIT_ENTITY_LABELS[entityType] ?? entityType;
}
