/**
 * The support ticketing platform (migration 0130) — the pure vocabulary.
 *
 * Ticket statuses, priorities and categories, their Persian labels, and the
 * small membership rules the two surfaces (the member's «پشتیبانی» section
 * and the platform console) must agree on. Framework-free like
 * `platform-admin.ts` so both the server services and the client pages import
 * the same words, and so the decisions can be unit-tested directly.
 */
import type { Role } from "./auth-edge";

/** The lifecycle of a ticket. `resolved`/`closed` are terminal; a member may
 * reopen a closed (or resolved) ticket, which returns it to `open`. */
export const TICKET_STATUSES = [
  "open",
  "in_progress",
  "waiting_customer",
  "resolved",
  "closed",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_CATEGORIES = ["technical", "billing", "account", "feature", "other"] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/** Persian labels — the only place the English wire values meet their UI words. */
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  open: "باز",
  in_progress: "در حال بررسی",
  waiting_customer: "در انتظار پاسخ شما",
  resolved: "حل‌شده",
  closed: "بسته‌شده",
};

/**
 * The same canonical status, read from the viewer's side (audit F10). The wire
 * value `waiting_customer` means the CUSTOMER owes the next reply; the member
 * page says «در انتظار پاسخ شما» (awaiting your reply) while the operator desk
 * must say the opposite. Identifiers never change; only the words do.
 */
export type TicketViewer = "member" | "operator";

export const TICKET_STATUS_LABELS_BY_VIEWER: Record<TicketViewer, Record<TicketStatus, string>> = {
  member: TICKET_STATUS_LABELS,
  operator: {
    open: "باز — منتظر بررسی پشتیبانی",
    in_progress: "در حال بررسی پشتیبانی",
    waiting_customer: "در انتظار پاسخ مشتری",
    resolved: "حل‌شده",
    closed: "بسته‌شده",
  },
};

/** Persian label for a status as seen by `viewer`; unknown values pass through. */
export function ticketStatusLabel(status: string, viewer: TicketViewer = "member"): string {
  const labels = TICKET_STATUS_LABELS_BY_VIEWER[viewer];
  return (labels as Record<string, string>)[status] ?? status;
}

export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: "کم",
  normal: "عادی",
  high: "زیاد",
  urgent: "فوری",
};

export const TICKET_CATEGORY_LABELS: Record<TicketCategory, string> = {
  technical: "مشکل فنی",
  billing: "صورتحساب و اشتراک",
  account: "حساب کاربری و دسترسی",
  feature: "پیشنهاد و درخواست ویژگی",
  other: "سایر",
};

/** A status that still expects action on one side of the conversation. */
export function isTicketOpen(status: TicketStatus | string): boolean {
  return status === "open" || status === "in_progress" || status === "waiting_customer";
}

/** Statuses the member may set themselves: closing and reopening their own ticket. */
export const MEMBER_SETTABLE_STATUSES = ["closed", "open"] as const;
export type MemberSettableStatus = (typeof MEMBER_SETTABLE_STATUSES)[number];

/**
 * May this member see every ticket of the business (not just their own)?
 * Owners and managers run the business, so they see the whole queue; cashiers,
 * waiters and kitchen staff only ever see tickets they opened themselves.
 */
export function canSeeAllBusinessTickets(role: Role | string): boolean {
  return role === "owner" || role === "manager";
}

/** A member's reply moves a non-terminal ticket back to the live queue. */
export function statusAfterMemberReply(status: TicketStatus | string): TicketStatus {
  if (status === "closed" || status === "resolved") return "open";
  return "in_progress";
}

/** An admin's reply puts the ball in the member's court. */
export function statusAfterAdminReply(status: TicketStatus | string): TicketStatus {
  if (status === "closed") return "closed";
  return "waiting_customer";
}

/** Is `value` a member-settable status (used to reject anything else)? */
export function isMemberSettableStatus(value: string): value is MemberSettableStatus {
  return (MEMBER_SETTABLE_STATUSES as readonly string[]).includes(value);
}

/** Is `value` one of the ticket statuses? */
export function isTicketStatus(value: string): value is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(value);
}

/** Is `value` one of the ticket priorities? */
export function isTicketPriority(value: string): value is TicketPriority {
  return (TICKET_PRIORITIES as readonly string[]).includes(value);
}

/** Is `value` one of the ticket categories? */
export function isTicketCategory(value: string): value is TicketCategory {
  return (TICKET_CATEGORIES as readonly string[]).includes(value);
}
