/**
 * Pure decisions behind the support ticketing platform — statuses, priorities,
 * categories and the membership rules the tenant page and the platform console
 * both lean on. DB-touching parts live in support-service.ts / platform-service.ts.
 */
import { describe, expect, it } from "vitest";
import {
  TICKET_STATUSES,
  TICKET_PRIORITIES,
  TICKET_CATEGORIES,
  TICKET_STATUS_LABELS,
  TICKET_PRIORITY_LABELS,
  TICKET_CATEGORY_LABELS,
  ticketStatusLabel,
  isTicketOpen,
  isMemberSettableStatus,
  isTicketStatus,
  isTicketPriority,
  isTicketCategory,
  canSeeAllBusinessTickets,
  statusAfterMemberReply,
  statusAfterAdminReply,
} from "./support-tickets";

describe("support ticket vocabulary", () => {
  it("every status/priority/category has a Persian label", () => {
    for (const status of TICKET_STATUSES) {
      expect(TICKET_STATUS_LABELS[status].length).toBeGreaterThan(0);
    }
    for (const priority of TICKET_PRIORITIES) {
      expect(TICKET_PRIORITY_LABELS[priority].length).toBeGreaterThan(0);
    }
    for (const category of TICKET_CATEGORIES) {
      expect(TICKET_CATEGORY_LABELS[category].length).toBeGreaterThan(0);
    }
  });

  it("isTicketOpen treats the three active statuses as open", () => {
    expect(isTicketOpen("open")).toBe(true);
    expect(isTicketOpen("in_progress")).toBe(true);
    expect(isTicketOpen("waiting_customer")).toBe(true);
    expect(isTicketOpen("resolved")).toBe(false);
    expect(isTicketOpen("closed")).toBe(false);
  });

  it("member-settable statuses are only close and reopen", () => {
    expect(isMemberSettableStatus("closed")).toBe(true);
    expect(isMemberSettableStatus("open")).toBe(true);
    expect(isMemberSettableStatus("in_progress")).toBe(false);
    expect(isMemberSettableStatus("resolved")).toBe(false);
    expect(isMemberSettableStatus("urgent")).toBe(false);
  });

  it("type guards accept only the enumerated values", () => {
    expect(isTicketStatus("open")).toBe(true);
    expect(isTicketStatus("closed")).toBe(true);
    expect(isTicketStatus("banana")).toBe(false);
    expect(isTicketPriority("urgent")).toBe(true);
    expect(isTicketPriority("high")).toBe(true);
    expect(isTicketPriority("banana")).toBe(false);
    expect(isTicketCategory("billing")).toBe(true);
    expect(isTicketCategory("other")).toBe(true);
    expect(isTicketCategory("banana")).toBe(false);
  });
});

describe("support ticket membership rules", () => {
  it("owners and managers see the whole business queue", () => {
    expect(canSeeAllBusinessTickets("owner")).toBe(true);
    expect(canSeeAllBusinessTickets("manager")).toBe(true);
    expect(canSeeAllBusinessTickets("cashier")).toBe(false);
    expect(canSeeAllBusinessTickets("waiter")).toBe(false);
    expect(canSeeAllBusinessTickets("kitchen")).toBe(false);
    expect(canSeeAllBusinessTickets("accountant")).toBe(false);
  });

  it("a member's reply reopens a resolved ticket and keeps the queue moving", () => {
    expect(statusAfterMemberReply("open")).toBe("in_progress");
    expect(statusAfterMemberReply("in_progress")).toBe("in_progress");
    expect(statusAfterMemberReply("waiting_customer")).toBe("in_progress");
    expect(statusAfterMemberReply("resolved")).toBe("open");
    expect(statusAfterMemberReply("closed")).toBe("open");
  });

  it("an admin's reply hands the ticket back to the member", () => {
    expect(statusAfterAdminReply("open")).toBe("waiting_customer");
    expect(statusAfterAdminReply("in_progress")).toBe("waiting_customer");
    expect(statusAfterAdminReply("waiting_customer")).toBe("waiting_customer");
    expect(statusAfterAdminReply("resolved")).toBe("waiting_customer");
    // A closed ticket stays closed: the member must reopen it themselves.
    expect(statusAfterAdminReply("closed")).toBe("closed");
  });
});

describe("contextual support status labels (audit F10)", () => {
  it("tells the operator desk that waiting_customer means the customer owes the reply", () => {
    expect(ticketStatusLabel("waiting_customer", "operator")).toBe("در انتظار پاسخ مشتری");
    expect(ticketStatusLabel("waiting_customer", "operator")).not.toMatch(/شما/);
  });

  it("keeps the member's own wording for the member side", () => {
    expect(ticketStatusLabel("waiting_customer", "member")).toBe("در انتظار پاسخ شما");
    expect(ticketStatusLabel("waiting_customer")).toBe("در انتظار پاسخ شما");
  });

  it("does not change canonical wire identifiers, and passes unknown values through", () => {
    expect(ticketStatusLabel("open", "operator")).not.toBe("open");
    expect(ticketStatusLabel("mystery_state", "operator")).toBe("mystery_state");
  });
});
