/**
 * Phase 35 — the pure core of notifications.
 *
 * Framework-free and side-effect-free: the event catalogue, who a given event
 * is *for*, whether a person's rule admits it, and what the phone should say.
 * Database access lives in notifications-service.ts; the encryption and VAPID
 * signing live in web-push.ts.
 *
 * Two decisions this file encodes, and everything else follows from them:
 *
 *   * **A missing rule is a default, not a silence.** `resolveRecipients` falls
 *     back to the catalogue's per-role defaults for anybody who has never
 *     opened the settings tab. A notification system that only works after
 *     configuration is a notification system nobody has switched on, and the
 *     failure is invisible — the owner just never hears about the shortfall.
 *   * **Quiet hours suppress the *push*, never the record.** «ساکت» means "do
 *     not wake me", not "do not tell me": the bell row is written either way,
 *     and a `critical` event ignores the window outright, because a business
 *     whose backups have been failing for three nights needs to be told at
 *     03:00 rather than at 09:00 on the fourth day.
 */

import type { Role } from "./auth";
import { tomanText } from "./ai-labels";

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

export const NOTIFICATION_SEVERITIES = ["info", "important", "critical"] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export const NOTIFICATION_SEVERITY_LABELS: Record<NotificationSeverity, string> = {
  info: "اطلاع‌رسانی",
  important: "مهم",
  critical: "بحرانی",
};

const SEVERITY_RANK: Record<NotificationSeverity, number> = { info: 0, important: 1, critical: 2 };

export function severityAtLeast(actual: NotificationSeverity, floor: NotificationSeverity): boolean {
  return SEVERITY_RANK[actual] >= SEVERITY_RANK[floor];
}

export function isNotificationSeverity(value: unknown): value is NotificationSeverity {
  return typeof value === "string" && (NOTIFICATION_SEVERITIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * `push` is the phone/desktop OS notification, delivered by the push service
 * even when the app is closed. `inapp` is the bell inside the dashboard, which
 * is the only one that survives a device the user never granted permission on.
 */
export const NOTIFICATION_CHANNELS = ["push", "inapp"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_CHANNEL_LABELS: Record<NotificationChannel, string> = {
  push: "اعلان روی گوشی و رایانه",
  inapp: "زنگولهٔ داخل برنامه",
};

export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return typeof value === "string" && (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export const NOTIFICATION_EVENT_KEYS = [
  "shift.opened",
  "shift.closed",
  "shift.cash_variance",
  "business_day.closed",
  "order.voided",
  "payment.refunded",
  "inventory.low_stock",
  "backup.failed",
  "ai.coworker.pending",
  "ai.coworker.reported",
  "ai.coworker.failed",
  "ai.automation.pending",
  "ai.automation.failed",
  // Issue #799 §29 (Wave 6). The issue asks for two reminders — «RFI overdue»
  // and «submittal overdue» — through *this* engine rather than a second one,
  // which is why they are two keys and a scan here instead of a scheduler of
  // their own.
  "aec.rfi_overdue",
  "aec.submittal_overdue",
  "system.test",
] as const;
export type NotificationEventKey = (typeof NOTIFICATION_EVENT_KEYS)[number];

export function isNotificationEventKey(value: unknown): value is NotificationEventKey {
  return typeof value === "string" && (NOTIFICATION_EVENT_KEYS as readonly string[]).includes(value);
}

/** Grouping for the settings screen only — it has no effect on delivery. */
export type NotificationGroup = "operations" | "money" | "inventory" | "projects" | "system" | "ai";

export const NOTIFICATION_GROUP_LABELS: Record<NotificationGroup, string> = {
  operations: "شیفت و روز کاری",
  money: "فروش و صندوق",
  inventory: "انبار",
  // «میز کار من» — the project registers. Its own group because the settings
  // screen groups by trading area, and «نقشه و سابمیتال» is not inventory.
  projects: "پروژه‌ها و میز کار",
  system: "سلامت سامانه",
  ai: "همکار هوشمند",
};

export interface NotificationEventMeta {
  key: NotificationEventKey;
  group: NotificationGroup;
  label: string;
  description: string;
  /** The severity a producer uses unless the facts justify raising it. */
  defaultSeverity: NotificationSeverity;
  /**
   * Whose business this is, out of the box. A member whose role is here and who
   * has never touched the settings tab still gets told; everyone else stays
   * quiet until they ask. Deliberately narrow — a cashier does not need the
   * backup log, and an app that buzzes for everything gets its permission
   * revoked within a week.
   */
  defaultRoles: Role[];
  /** True when the event belongs to one branch, so a branch-scoped rule can narrow it. */
  perLocation: boolean;
  /**
   * Whether this event carries a money figure, which is what makes
   * `min_amount_rial` meaningful on a rule. The settings form only offers the
   * threshold for these.
   */
  hasAmount: boolean;
}

/**
 * Every event this app can notify about.
 *
 * Kept small on purpose. Each key here is *emitted* by real code (see the
 * "Producers" section of docs/phases/Phase-35-Notifications.md); a key with no
 * producer would be a switch in the settings screen that does nothing, which is
 * worse than an absent one.
 */
export const NOTIFICATION_EVENTS: Record<NotificationEventKey, NotificationEventMeta> = {
  "shift.opened": {
    key: "shift.opened",
    group: "operations",
    label: "شروع شیفت",
    description: "وقتی کارمندی شیفت خود را در شعبه باز می‌کند.",
    defaultSeverity: "info",
    // Nobody by default: this is the event an owner turns on when they want to
    // know the morning shift actually started, not something to push at anyone.
    defaultRoles: [],
    perLocation: true,
    hasAmount: false,
  },
  "shift.closed": {
    key: "shift.closed",
    group: "operations",
    label: "پایان شیفت",
    description: "وقتی شیفتی بسته می‌شود، همراه با خلاصهٔ فروش نقدی آن.",
    defaultSeverity: "info",
    defaultRoles: [],
    perLocation: true,
    hasAmount: true,
  },
  "shift.cash_variance": {
    key: "shift.cash_variance",
    group: "money",
    label: "کسری یا اضافهٔ صندوق",
    description:
      "وقتی شمارش پایان شیفت با مبلغ مورد انتظار نمی‌خواند. مبلغ اختلاف در اعلان می‌آید تا بدون باز کردن داشبورد بدانید چقدر است.",
    defaultSeverity: "important",
    defaultRoles: ["owner", "manager"],
    perLocation: true,
    hasAmount: true,
  },
  "business_day.closed": {
    key: "business_day.closed",
    group: "operations",
    label: "بسته‌شدن روز کاری",
    description: "وقتی روز کاری شعبه بسته می‌شود.",
    defaultSeverity: "info",
    defaultRoles: ["owner"],
    perLocation: true,
    hasAmount: false,
  },
  "order.voided": {
    key: "order.voided",
    group: "money",
    label: "ابطال سفارش",
    description: "وقتی سفارشی باطل می‌شود. با تعیین حداقل مبلغ، فقط ابطال‌های بزرگ به شما اطلاع داده می‌شود.",
    defaultSeverity: "important",
    defaultRoles: ["owner"],
    perLocation: true,
    hasAmount: true,
  },
  "payment.refunded": {
    key: "payment.refunded",
    group: "money",
    label: "برگشت وجه",
    description: "وقتی مبلغی به مشتری برگردانده می‌شود.",
    defaultSeverity: "important",
    defaultRoles: ["owner"],
    perLocation: true,
    hasAmount: true,
  },
  "inventory.low_stock": {
    key: "inventory.low_stock",
    group: "inventory",
    label: "رسیدن کالا به نقطهٔ سفارش",
    description: "وقتی موجودی کالایی به نقطهٔ سفارش یا پایین‌تر می‌رسد.",
    defaultSeverity: "important",
    defaultRoles: ["owner", "manager"],
    perLocation: true,
    hasAmount: false,
  },
  "backup.failed": {
    key: "backup.failed",
    group: "system",
    label: "ناموفق‌بودن پشتیبان‌گیری",
    description:
      "وقتی پشتیبان‌گیری زمان‌بندی‌شده انجام نمی‌شود. بحرانی است، پس ساعت سکوت را هم نادیده می‌گیرد.",
    // The one thing whose whole value is arriving at the wrong hour: a backup
    // that has silently failed for a week is discovered at exactly the moment
    // it is too late to matter.
    defaultSeverity: "critical",
    defaultRoles: ["owner"],
    perLocation: false,
    hasAmount: false,
  },
  "ai.coworker.pending": {
    key: "ai.coworker.pending",
    group: "ai",
    label: "کار همکار هوشمند در انتظار تأیید",
    description:
      "وقتی کاری که برای همکار هوشمند تعریف کرده‌اید اجرا می‌شود و منتظر تأیید شماست — مثلاً ثبت ضایعات پایان شب.",
    defaultSeverity: "important",
    defaultRoles: ["owner"],
    perLocation: true,
    hasAmount: false,
  },
  "ai.coworker.reported": {
    key: "ai.coworker.reported",
    group: "ai",
    label: "گزارش همکار هوشمند",
    description: "وقتی کاری مثل «بازبینی حساب‌ها» گزارشی آماده می‌کند.",
    defaultSeverity: "info",
    defaultRoles: ["owner"],
    perLocation: false,
    hasAmount: false,
  },
  "ai.coworker.failed": {
    key: "ai.coworker.failed",
    group: "ai",
    label: "اجرای ناموفق کار همکار هوشمند",
    description: "وقتی یکی از کارهای تعریف‌شده اجرا می‌شود ولی به خطا می‌خورد.",
    defaultSeverity: "important",
    defaultRoles: ["owner"],
    perLocation: true,
    hasAmount: false,
  },
  "ai.automation.pending": {
    key: "ai.automation.pending",
    group: "ai",
    label: "اتوماسیون در انتظار تأیید",
    description:
      "وقتی یک اتوماسیون (اگر… آنگاه…) اجرا می‌شود و اقدامش برای ثبت به تأیید شما نیاز دارد.",
    defaultSeverity: "important",
    defaultRoles: ["owner"],
    perLocation: true,
    hasAmount: false,
  },
  "ai.automation.failed": {
    key: "ai.automation.failed",
    group: "ai",
    label: "اجرای ناموفق اتوماسیون",
    description: "وقتی یک اتوماسیون اجرا می‌شود ولی به خطا می‌خورد.",
    defaultSeverity: "important",
    defaultRoles: ["owner"],
    perLocation: true,
    hasAmount: false,
  },
  "aec.rfi_overdue": {
    key: "aec.rfi_overdue",
    group: "projects",
    label: "استعلام بی‌پاسخ از مهلت گذشته (RFI)",
    description:
      "وقتی استعلامی هنوز پاسخ نگرفته و مهلت پاسخش گذشته است. روزی یک بار برای هر استعلام، در روز کاری همان شعبه.",
    defaultSeverity: "important",
    // The two roles that chase answers: a project manager and the owner. An
    // engineer or a document controller is not told by default — they are
    // looking at the RFI tab anyway — and anyone can turn it on for themselves.
    defaultRoles: ["owner", "manager"],
    // An RFI belongs to a project, not to a branch: a construction business's
    // registers have no location to scope by.
    perLocation: false,
    hasAmount: false,
  },
  "aec.submittal_overdue": {
    key: "aec.submittal_overdue",
    group: "projects",
    label: "سابمیتال معطل‌مانده از مهلت گذشته",
    description:
      "وقتی بازنگری‌ای ارسال شده و بازبین هنوز پاسخش را نداده و مهلت گذشته است. روزی یک بار برای هر بازنگری.",
    defaultSeverity: "important",
    defaultRoles: ["owner", "manager"],
    perLocation: false,
    hasAmount: false,
  },
  "system.test": {
    key: "system.test",
    group: "system",
    label: "اعلان آزمایشی",
    description: "اعلانی که خودتان از تنظیمات می‌فرستید تا مطمئن شوید دستگاه درست تنظیم شده است.",
    defaultSeverity: "info",
    // Sent only to the person who pressed the button; `resolveRecipients` is
    // bypassed for it (see deliverTestNotification), so no role default applies.
    defaultRoles: [],
    perLocation: false,
    hasAmount: false,
  },
};

export const NOTIFICATION_EVENT_LIST: NotificationEventMeta[] = NOTIFICATION_EVENT_KEYS.map(
  (key) => NOTIFICATION_EVENTS[key],
);

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface NotificationRule {
  id: string;
  userId: string;
  eventKey: NotificationEventKey;
  /** null = every branch. */
  locationId: string | null;
  enabled: boolean;
  channels: NotificationChannel[];
  minSeverity: NotificationSeverity;
  minAmountRial: number | null;
  quietFromMinutes: number | null;
  quietToMinutes: number | null;
}

export type NotificationRuleInput = Omit<NotificationRule, "id" | "userId">;

/**
 * What a person gets when they have never written a rule for an event.
 *
 * Note the asymmetry with an explicit rule: a default carries no quiet window
 * and no amount floor, because inventing one would be this file guessing at
 * something the owner never said.
 */
export function defaultRuleFor(
  eventKey: NotificationEventKey,
  role: Role,
): Omit<NotificationRule, "id" | "userId" | "locationId"> {
  const meta = NOTIFICATION_EVENTS[eventKey];
  return {
    eventKey,
    enabled: meta.defaultRoles.includes(role),
    channels: ["push", "inapp"],
    minSeverity: "info",
    minAmountRial: null,
    quietFromMinutes: null,
    quietToMinutes: null,
  };
}

export const NOTIFICATION_ERROR_MESSAGES: Record<string, string> = {
  notification_event_unknown: "این نوع اعلان وجود ندارد.",
  notification_channels_required: "دست‌کم یک راه دریافت اعلان را انتخاب کنید.",
  notification_channel_invalid: "راه دریافت اعلان معتبر نیست.",
  notification_severity_invalid: "درجهٔ اهمیت معتبر نیست.",
  notification_amount_invalid: "حداقل مبلغ باید عددی صحیح و مثبت باشد.",
  notification_quiet_invalid: "ساعت سکوت باید بین ۰۰:۰۰ تا ۲۳:۵۹ باشد.",
  notification_quiet_incomplete: "برای ساعت سکوت هم زمان شروع و هم زمان پایان لازم است.",
  notification_amount_unsupported: "این نوع اعلان مبلغ ندارد، پس حداقل مبلغ برای آن معنا ندارد.",
  notification_device_invalid: "اطلاعات دستگاه برای دریافت اعلان کامل نیست.",
  notification_push_unconfigured: "ارسال اعلان روی این سرور هنوز آماده نیست.",
  notification_rule_not_found: "این تنظیم اعلان پیدا نشد.",
};

export function notificationErrorMessage(code: string): string {
  return NOTIFICATION_ERROR_MESSAGES[code] ?? "درخواست معتبر نیست.";
}

/** Validates the shape of a rule the settings form (or the public API) sends. */
export function validateRuleInput(input: Partial<NotificationRuleInput>): string[] {
  const errors: string[] = [];

  if (!isNotificationEventKey(input.eventKey)) {
    errors.push("notification_event_unknown");
    // Everything below reads the catalogue entry, so there is nothing further
    // to say about a rule whose event does not exist.
    return errors;
  }
  const meta = NOTIFICATION_EVENTS[input.eventKey];

  const channels = input.channels;
  if (!Array.isArray(channels) || channels.length === 0) {
    errors.push("notification_channels_required");
  } else if (!channels.every(isNotificationChannel)) {
    errors.push("notification_channel_invalid");
  }

  if (input.minSeverity !== undefined && !isNotificationSeverity(input.minSeverity)) {
    errors.push("notification_severity_invalid");
  }

  const amount = input.minAmountRial;
  if (amount !== null && amount !== undefined) {
    if (!Number.isInteger(amount) || amount < 0) errors.push("notification_amount_invalid");
    else if (!meta.hasAmount) errors.push("notification_amount_unsupported");
  }

  const from = input.quietFromMinutes ?? null;
  const to = input.quietToMinutes ?? null;
  if ((from === null) !== (to === null)) {
    errors.push("notification_quiet_incomplete");
  } else if (from !== null && to !== null) {
    const valid = (value: number) => Number.isInteger(value) && value >= 0 && value <= 1439;
    if (!valid(from) || !valid(to)) errors.push("notification_quiet_invalid");
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------

/**
 * Whether `minutesOfDay` (local to the branch) falls inside the rule's quiet
 * window.
 *
 * A window that wraps midnight — 22:00 → 07:00, which is the one people
 * actually configure — is the normal case rather than the special one, so
 * `from > to` is legal and means "through midnight". A window whose ends are
 * equal is treated as empty rather than as all day: "quiet from 8 to 8" is much
 * more likely to be a slip than a request never to be notified again.
 */
export function isWithinQuietHours(
  rule: Pick<NotificationRule, "quietFromMinutes" | "quietToMinutes">,
  minutesOfDay: number,
): boolean {
  const { quietFromMinutes: from, quietToMinutes: to } = rule;
  if (from === null || to === null || from === to) return false;
  return from < to ? minutesOfDay >= from && minutesOfDay < to : minutesOfDay >= from || minutesOfDay < to;
}

/** Minutes past local midnight, without depending on the process timezone. */
export function localMinutesOfDay(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const hour = value("hour");
  const minute = value("minute");
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`invalid local time in ${timezone}`);
  }
  return hour * 60 + minute;
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

export interface NotificationEventFacts {
  eventKey: NotificationEventKey;
  severity: NotificationSeverity;
  locationId: string | null;
  amountRial: number | null;
}

export interface NotificationMember {
  userId: string;
  role: Role;
  /**
   * The branches this member may act in, already resolved through Phase 14's
   * `accessibleLocationIds` — so "who may hear about branch X" is the same
   * question, answered by the same function, as "who may act in branch X".
   * Re-deriving it here from `users.location_id` would quietly disagree with
   * every other screen the moment a member is assigned two of five branches.
   */
  locationIds: readonly string[];
}

export interface ResolvedRecipient {
  userId: string;
  channels: NotificationChannel[];
  /** True when the person's own quiet window covers this moment and the event is not critical. */
  quiet: boolean;
}

/**
 * Picks the rule that governs this member for this event.
 *
 * A branch-scoped rule wins over an all-branch one, because it is the more
 * specific thing the person said. Only rules for *this* event and *this* branch
 * (or every branch) are considered at all.
 */
export function ruleFor(
  rules: readonly NotificationRule[],
  userId: string,
  eventKey: NotificationEventKey,
  locationId: string | null,
): NotificationRule | null {
  let allBranch: NotificationRule | null = null;
  for (const rule of rules) {
    if (rule.userId !== userId || rule.eventKey !== eventKey) continue;
    if (rule.locationId !== null) {
      if (rule.locationId === locationId) return rule;
      continue;
    }
    allBranch = rule;
  }
  return allBranch;
}

/**
 * Everyone who should hear about `event`, and how.
 *
 * The quiet decision is returned rather than applied: the caller writes the
 * bell row regardless and consults `quiet` only when deciding whether to push,
 * which is what keeps "do not wake me" from becoming "do not tell me".
 *
 * A `critical` event ignores quiet hours entirely — see `backup.failed` in the
 * catalogue for why that exception exists.
 */
export function resolveRecipients(input: {
  event: NotificationEventFacts;
  members: readonly NotificationMember[];
  rules: readonly NotificationRule[];
  /** Minutes past local midnight at the branch this event belongs to. */
  minutesOfDay: number;
}): ResolvedRecipient[] {
  const { event, members, rules, minutesOfDay } = input;
  const meta = NOTIFICATION_EVENTS[event.eventKey];
  const recipients: ResolvedRecipient[] = [];

  for (const member of members) {
    // A member never hears about a branch they cannot act in, whatever their
    // rule says — a rule narrows what someone sees, it never widens it past
    // their own branch assignment.
    if (meta.perLocation && event.locationId !== null && !member.locationIds.includes(event.locationId)) {
      continue;
    }

    const rule = ruleFor(rules, member.userId, event.eventKey, event.locationId);
    const effective = rule ?? {
      ...defaultRuleFor(event.eventKey, member.role),
      id: "",
      userId: member.userId,
      locationId: null,
    };

    if (!effective.enabled) continue;
    if (!severityAtLeast(event.severity, effective.minSeverity)) continue;
    if (
      effective.minAmountRial !== null &&
      (event.amountRial === null || Math.abs(event.amountRial) < effective.minAmountRial)
    ) {
      continue;
    }

    recipients.push({
      userId: member.userId,
      channels: effective.channels,
      quiet: event.severity !== "critical" && isWithinQuietHours(effective, minutesOfDay),
    });
  }

  return recipients;
}

// ---------------------------------------------------------------------------
// What the phone says
// ---------------------------------------------------------------------------

export interface NotificationDraft {
  eventKey: NotificationEventKey;
  severity: NotificationSeverity;
  title: string;
  body: string;
  /** Relative — the notification opens on whichever origin the business is served from. */
  url: string;
  amountRial: number | null;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

/**
 * The JSON the service worker receives. Deliberately flat and small: a push
 * service may cap the encrypted payload at 4 KB, and everything the
 * notification needs to render has to survive the app being closed.
 */
export interface PushPayload {
  eventKey: NotificationEventKey;
  severity: NotificationSeverity;
  title: string;
  body: string;
  url: string;
  /** Collapses same-subject notifications in the OS tray instead of stacking them. */
  tag: string;
  notificationId: string;
}

export function pushPayloadFor(input: {
  eventKey: NotificationEventKey;
  severity: NotificationSeverity;
  title: string;
  body: string;
  url: string;
  notificationId: string;
  /** Same value the outbox row carries; two firings of one fact replace rather than stack. */
  dedupeKey: string;
}): PushPayload {
  return {
    eventKey: input.eventKey,
    severity: input.severity,
    title: input.title,
    body: input.body,
    url: input.url,
    tag: input.dedupeKey,
    notificationId: input.notificationId,
  };
}

/** A cash shortfall reads as a shortfall, not as a negative number on a lock screen. */
export function cashVarianceText(varianceRial: number): string {
  if (varianceRial === 0) return "صندوق بدون اختلاف بسته شد.";
  const amount = tomanText(Math.abs(varianceRial));
  return varianceRial < 0 ? `کسری صندوق: ${amount}` : `اضافهٔ صندوق: ${amount}`;
}

/**
 * Every producer builds its dedupe key through here, so the "one fact, one
 * notification" property is a function of the fact's own identity rather than
 * of when the producer happened to run.
 */
export function notificationDedupeKey(eventKey: NotificationEventKey, ...parts: (string | number)[]): string {
  return [eventKey, ...parts.map((part) => String(part))].join(":");
}
