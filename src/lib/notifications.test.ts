import { describe, expect, it } from "vitest";
import type { Role } from "./auth";
import {
  cashVarianceText,
  defaultRuleFor,
  isWithinQuietHours,
  localMinutesOfDay,
  NOTIFICATION_EVENT_KEYS,
  NOTIFICATION_EVENTS,
  notificationDedupeKey,
  pushPayloadFor,
  resolveRecipients,
  ruleFor,
  severityAtLeast,
  validateRuleInput,
  type NotificationChannel,
  type NotificationEventKey,
  type NotificationRule,
  type NotificationSeverity,
} from "./notifications";

const BRANCH_A = "11111111-1111-1111-1111-111111111111";
const BRANCH_B = "22222222-2222-2222-2222-222222222222";

function rule(overrides: Partial<NotificationRule> & Pick<NotificationRule, "userId">): NotificationRule {
  return {
    id: `rule-${overrides.userId}-${overrides.eventKey ?? "x"}-${overrides.locationId ?? "all"}`,
    eventKey: "shift.cash_variance",
    locationId: null,
    enabled: true,
    channels: ["push", "inapp"],
    minSeverity: "info",
    minAmountRial: null,
    quietFromMinutes: null,
    quietToMinutes: null,
    ...overrides,
  };
}

/** `locationIds` is what Phase 14's `accessibleLocationIds` would have returned. */
function member(userId: string, role: Role, locationIds: string[] = [BRANCH_A, BRANCH_B]) {
  return { userId, role, locationIds };
}

const CASH_VARIANCE = {
  eventKey: "shift.cash_variance" as NotificationEventKey,
  severity: "important" as NotificationSeverity,
  locationId: BRANCH_A,
  amountRial: -4_000_000,
};

describe("the catalogue", () => {
  it("lists every key exactly once, keyed by itself", () => {
    for (const key of NOTIFICATION_EVENT_KEYS) {
      expect(NOTIFICATION_EVENTS[key].key).toBe(key);
    }
    expect(new Set(NOTIFICATION_EVENT_KEYS).size).toBe(NOTIFICATION_EVENT_KEYS.length);
  });

  it("only offers an amount threshold where the event carries an amount", () => {
    // The settings form renders the threshold from this flag, and
    // validateRuleInput refuses one elsewhere; the two must agree.
    for (const key of NOTIFICATION_EVENT_KEYS) {
      const meta = NOTIFICATION_EVENTS[key];
      const errors = validateRuleInput({
        eventKey: key,
        channels: ["push"],
        minSeverity: "info",
        minAmountRial: 1_000,
        quietFromMinutes: null,
        quietToMinutes: null,
      });
      expect(errors.includes("notification_amount_unsupported")).toBe(!meta.hasAmount);
    }
  });

  it("never defaults a cashier into a back-office alert", () => {
    // An app that buzzes every till phone about the backup log gets its
    // notification permission revoked within a week.
    for (const key of NOTIFICATION_EVENT_KEYS) {
      expect(NOTIFICATION_EVENTS[key].defaultRoles).not.toContain("cashier");
      expect(NOTIFICATION_EVENTS[key].defaultRoles).not.toContain("kitchen");
    }
  });
});

describe("severityAtLeast", () => {
  it("orders info < important < critical", () => {
    expect(severityAtLeast("critical", "important")).toBe(true);
    expect(severityAtLeast("important", "important")).toBe(true);
    expect(severityAtLeast("info", "important")).toBe(false);
    expect(severityAtLeast("important", "critical")).toBe(false);
  });
});

describe("defaultRuleFor", () => {
  it("enables an event for the roles the catalogue names and nobody else", () => {
    expect(defaultRuleFor("backup.failed", "owner").enabled).toBe(true);
    expect(defaultRuleFor("backup.failed", "manager").enabled).toBe(false);
    expect(defaultRuleFor("shift.cash_variance", "manager").enabled).toBe(true);
    expect(defaultRuleFor("shift.cash_variance", "cashier").enabled).toBe(false);
  });

  it("carries no quiet window and no amount floor", () => {
    const fallback = defaultRuleFor("shift.cash_variance", "owner");
    expect(fallback.quietFromMinutes).toBeNull();
    expect(fallback.minAmountRial).toBeNull();
    expect(fallback.channels).toEqual(["push", "inapp"]);
  });
});

describe("validateRuleInput", () => {
  const base = {
    eventKey: "shift.cash_variance" as NotificationEventKey,
    channels: ["push"] as NotificationChannel[],
    minSeverity: "info" as NotificationSeverity,
    minAmountRial: null,
    quietFromMinutes: null,
    quietToMinutes: null,
  };

  it("accepts a well-formed rule", () => {
    expect(validateRuleInput(base)).toEqual([]);
    expect(
      validateRuleInput({ ...base, minAmountRial: 5_000_000, quietFromMinutes: 1320, quietToMinutes: 420 }),
    ).toEqual([]);
  });

  it("refuses an unknown event and says nothing else about it", () => {
    expect(validateRuleInput({ ...base, eventKey: "nope" as NotificationEventKey })).toEqual([
      "notification_event_unknown",
    ]);
  });

  it("refuses a rule with no channel", () => {
    expect(validateRuleInput({ ...base, channels: [] })).toContain("notification_channels_required");
    expect(validateRuleInput({ ...base, channels: ["sms" as NotificationChannel] })).toContain(
      "notification_channel_invalid",
    );
  });

  it("refuses half a quiet window", () => {
    expect(validateRuleInput({ ...base, quietFromMinutes: 1320 })).toContain(
      "notification_quiet_incomplete",
    );
    expect(validateRuleInput({ ...base, quietToMinutes: 420 })).toContain("notification_quiet_incomplete");
  });

  it("refuses an out-of-range quiet window and a negative amount", () => {
    expect(validateRuleInput({ ...base, quietFromMinutes: 1440, quietToMinutes: 60 })).toContain(
      "notification_quiet_invalid",
    );
    expect(validateRuleInput({ ...base, minAmountRial: -1 })).toContain("notification_amount_invalid");
  });
});

describe("isWithinQuietHours", () => {
  it("handles a window that wraps midnight — the one people configure", () => {
    const night = { quietFromMinutes: 22 * 60, quietToMinutes: 7 * 60 };
    expect(isWithinQuietHours(night, 23 * 60)).toBe(true);
    expect(isWithinQuietHours(night, 2 * 60)).toBe(true);
    expect(isWithinQuietHours(night, 6 * 60 + 59)).toBe(true);
    expect(isWithinQuietHours(night, 7 * 60)).toBe(false);
    expect(isWithinQuietHours(night, 15 * 60)).toBe(false);
  });

  it("handles a same-day window", () => {
    const siesta = { quietFromMinutes: 13 * 60, quietToMinutes: 16 * 60 };
    expect(isWithinQuietHours(siesta, 14 * 60)).toBe(true);
    expect(isWithinQuietHours(siesta, 16 * 60)).toBe(false);
    expect(isWithinQuietHours(siesta, 12 * 60)).toBe(false);
  });

  it("treats an absent or zero-width window as no quiet hours", () => {
    expect(isWithinQuietHours({ quietFromMinutes: null, quietToMinutes: null }, 3 * 60)).toBe(false);
    // "Quiet from 8 to 8" is far more likely a slip than a request never to be
    // notified again, so it means nothing rather than everything.
    expect(isWithinQuietHours({ quietFromMinutes: 480, quietToMinutes: 480 }, 480)).toBe(false);
  });
});

describe("localMinutesOfDay", () => {
  it("reads the branch's wall clock, not the process timezone", () => {
    // Tehran is UTC+03:30, so 20:30Z is midnight there — and midnight is 0,
    // not 1440, which is what the quiet-hours comparison depends on.
    const midnightInTehran = new Date("2026-03-01T20:30:00.000Z");
    expect(localMinutesOfDay(midnightInTehran, "Asia/Tehran")).toBe(0);
    expect(localMinutesOfDay(midnightInTehran, "UTC")).toBe(20 * 60 + 30);

    const lateEvening = new Date("2026-03-01T19:45:00.000Z");
    expect(localMinutesOfDay(lateEvening, "Asia/Tehran")).toBe(23 * 60 + 15);
  });
});

describe("ruleFor", () => {
  const rules = [
    rule({ userId: "u1", locationId: null }),
    rule({ userId: "u1", locationId: BRANCH_A, minSeverity: "critical" }),
    rule({ userId: "u2", locationId: null, eventKey: "backup.failed" }),
  ];

  it("prefers the branch-scoped rule — the more specific thing the person said", () => {
    expect(ruleFor(rules, "u1", "shift.cash_variance", BRANCH_A)?.minSeverity).toBe("critical");
  });

  it("falls back to the all-branch rule for another branch", () => {
    expect(ruleFor(rules, "u1", "shift.cash_variance", BRANCH_B)?.minSeverity).toBe("info");
  });

  it("ignores another user's and another event's rules", () => {
    expect(ruleFor(rules, "u1", "backup.failed", null)).toBeNull();
    expect(ruleFor(rules, "u3", "shift.cash_variance", BRANCH_A)).toBeNull();
  });
});

describe("resolveRecipients", () => {
  it("falls back to the role default for anyone who never configured anything", () => {
    const recipients = resolveRecipients({
      event: CASH_VARIANCE,
      members: [member("owner", "owner"), member("mgr", "manager"), member("cash", "cashier")],
      rules: [],
      minutesOfDay: 600,
    });
    expect(recipients.map((r) => r.userId).sort()).toEqual(["mgr", "owner"]);
    expect(recipients.every((r) => r.quiet === false)).toBe(true);
  });

  it("lets an explicit rule switch an event off for one person", () => {
    const recipients = resolveRecipients({
      event: CASH_VARIANCE,
      members: [member("owner", "owner"), member("mgr", "manager")],
      rules: [rule({ userId: "mgr", enabled: false })],
      minutesOfDay: 600,
    });
    expect(recipients.map((r) => r.userId)).toEqual(["owner"]);
  });

  it("lets an explicit rule switch an event on for someone the default excluded", () => {
    const recipients = resolveRecipients({
      event: CASH_VARIANCE,
      members: [member("cash", "cashier")],
      rules: [rule({ userId: "cash", channels: ["inapp"] })],
      minutesOfDay: 600,
    });
    expect(recipients).toEqual([{ userId: "cash", channels: ["inapp"], quiet: false }]);
  });

  it("drops an event below the person's severity floor", () => {
    const recipients = resolveRecipients({
      event: CASH_VARIANCE,
      members: [member("owner", "owner")],
      rules: [rule({ userId: "owner", minSeverity: "critical" })],
      minutesOfDay: 600,
    });
    expect(recipients).toEqual([]);
  });

  it("compares the amount floor against the magnitude, so a shortfall counts", () => {
    const under = resolveRecipients({
      event: CASH_VARIANCE,
      members: [member("owner", "owner")],
      rules: [rule({ userId: "owner", minAmountRial: 10_000_000 })],
      minutesOfDay: 600,
    });
    expect(under).toEqual([]);

    // −4,000,000 ﷼ is a 4,000,000 ﷼ problem, not a number below every floor.
    const over = resolveRecipients({
      event: CASH_VARIANCE,
      members: [member("owner", "owner")],
      rules: [rule({ userId: "owner", minAmountRial: 1_000_000 })],
      minutesOfDay: 600,
    });
    expect(over.map((r) => r.userId)).toEqual(["owner"]);
  });

  it("drops an amount-floored rule when the event carries no amount at all", () => {
    const recipients = resolveRecipients({
      event: { ...CASH_VARIANCE, amountRial: null },
      members: [member("owner", "owner")],
      rules: [rule({ userId: "owner", minAmountRial: 1 })],
      minutesOfDay: 600,
    });
    expect(recipients).toEqual([]);
  });

  it("marks quiet rather than dropping — the bell row is still written", () => {
    const recipients = resolveRecipients({
      event: CASH_VARIANCE,
      members: [member("owner", "owner")],
      rules: [rule({ userId: "owner", quietFromMinutes: 22 * 60, quietToMinutes: 7 * 60 })],
      minutesOfDay: 2 * 60,
    });
    expect(recipients).toEqual([{ userId: "owner", channels: ["push", "inapp"], quiet: true }]);
  });

  it("ignores quiet hours for a critical event", () => {
    const recipients = resolveRecipients({
      event: {
        eventKey: "backup.failed",
        severity: "critical",
        locationId: null,
        amountRial: null,
      },
      members: [member("owner", "owner")],
      rules: [
        rule({
          userId: "owner",
          eventKey: "backup.failed",
          quietFromMinutes: 22 * 60,
          quietToMinutes: 7 * 60,
        }),
      ],
      minutesOfDay: 3 * 60,
    });
    expect(recipients[0].quiet).toBe(false);
  });

  it("never tells a branch-pinned member about another branch", () => {
    const recipients = resolveRecipients({
      event: CASH_VARIANCE,
      members: [member("mgrA", "manager", [BRANCH_A]), member("mgrB", "manager", [BRANCH_B])],
      rules: [],
      minutesOfDay: 600,
    });
    expect(recipients.map((r) => r.userId)).toEqual(["mgrA"]);
  });

  it("still reaches a roaming member who may act in every branch", () => {
    const recipients = resolveRecipients({
      event: CASH_VARIANCE,
      members: [member("owner", "owner", [BRANCH_A, BRANCH_B])],
      rules: [],
      minutesOfDay: 600,
    });
    expect(recipients.map((r) => r.userId)).toEqual(["owner"]);
  });

  it("does not branch-filter an event that belongs to the whole business", () => {
    const recipients = resolveRecipients({
      event: { eventKey: "backup.failed", severity: "critical", locationId: null, amountRial: null },
      members: [member("owner", "owner", [BRANCH_B])],
      rules: [],
      minutesOfDay: 600,
    });
    expect(recipients.map((r) => r.userId)).toEqual(["owner"]);
  });
});

describe("cashVarianceText", () => {
  it("reads as a shortfall or a surplus, never as a minus sign", () => {
    expect(cashVarianceText(-4_000_000)).toBe("کسری صندوق: ۴۰۰٬۰۰۰ تومان");
    expect(cashVarianceText(4_000_000)).toBe("اضافهٔ صندوق: ۴۰۰٬۰۰۰ تومان");
    expect(cashVarianceText(0)).toBe("صندوق بدون اختلاف بسته شد.");
  });

  it("speaks the business's own display unit (#933)", () => {
    // Storage is integer Rial; a business that chose «ریال» must not be told
    // «تومان» on a lock screen.
    expect(cashVarianceText(-4_000_000, "rial")).toBe("کسری صندوق: ۴٬۰۰۰٬۰۰۰ ریال");
    expect(cashVarianceText(4_000_000, "rial")).toContain("ریال");
  });
});

describe("notificationDedupeKey", () => {
  it("is built from the fact's identity, not the moment it was noticed", () => {
    expect(notificationDedupeKey("shift.closed", "abc")).toBe("shift.closed:abc");
    expect(notificationDedupeKey("shift.closed", "abc")).toBe(notificationDedupeKey("shift.closed", "abc"));
    expect(notificationDedupeKey("shift.closed", "abc")).not.toBe(
      notificationDedupeKey("shift.closed", "def"),
    );
  });
});

describe("pushPayloadFor", () => {
  it("tags on the dedupe key so a re-fired fact replaces rather than stacks", () => {
    const payload = pushPayloadFor({
      eventKey: "shift.cash_variance",
      severity: "important",
      title: "کسری صندوق",
      body: "۴۰۰٬۰۰۰ تومان",
      url: "/settings/shifts",
      notificationId: "n1",
      dedupeKey: "shift.cash_variance:s1",
    });
    expect(payload.tag).toBe("shift.cash_variance:s1");
    expect(payload.url).toBe("/settings/shifts");
    expect(payload.notificationId).toBe("n1");
  });
});
