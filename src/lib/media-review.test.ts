import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENCY_MEDIA_APPROVABLE_FORMATS,
  AGENCY_MEDIA_FORMATS,
  AGENCY_MEDIA_FORMAT_LABELS,
  MEDIA_REVIEW_DECIDABLE_STATUSES,
  MEDIA_REVIEW_ITEM_STATUS_LABELS,
  MEDIA_REVIEW_ITEM_STATUSES,
  MEDIA_REVIEW_LINK_PURPOSES,
  MEDIA_REVIEW_LINK_PURPOSE_LABELS,
  MEDIA_REVIEW_LINK_TTL_DAYS,
  MEDIA_REVIEW_NOTE_MAX_LENGTH,
  MEDIA_REVIEW_ROUND_ACTIONS,
  MEDIA_REVIEW_ROUND_ACTION_LABELS,
  MEDIA_REVIEW_ROUND_STATUSES,
  MEDIA_REVIEW_ROUND_STATUS_LABELS,
  MEDIA_REVIEW_SETTLED_STATUSES,
  MEDIA_REVIEW_TOKEN_DISPLAY_LENGTH,
  MEDIA_REVIEW_TOKEN_PREFIX,
  canTransitionReviewRound,
  clampReviewLinkTtlDays,
  clientReviewActionsFrom,
  formatReviewProgress,
  isAgencyMediaFormat,
  isClientReviewAction,
  isReviewItemStatus,
  isReviewLinkLive,
  isReviewLinkPurpose,
  isReviewRoundAction,
  isReviewRoundFullyDecided,
  isReviewRoundFrozen,
  isReviewRoundOpenForItems,
  isReviewRoundStatus,
  looksLikeMediaReviewToken,
  mediaReviewTokenDisplayPrefix,
  reviewDecisionNoteRequired,
  reviewLinkExpiresAt,
  reviewLinkPurposeAllowsDownload,
  reviewLinkRefusal,
  reviewRoundActionTarget,
  agencyReviewActionsFrom,
  isReviewRoundIdentityFrozen,
  reviewRoundActionsFrom,
  reviewRoundStateFromItems,
  reviewRoundTargetsFrom,
  trimReviewNote,
  type MediaReviewItemStatus,
  type MediaReviewRoundAction,
  type MediaReviewRoundStatus,
} from "./media-review";

const MODULE_SOURCE = readFileSync(new URL("./media-review.ts", import.meta.url), "utf8");

/**
 * The module's code with its prose stripped.
 *
 * The docblock explains *why* `node:crypto` must not be reachable from here and
 * why no permission is named — and an assertion about what the code does must
 * not be tripped by a comment describing what the code deliberately avoids.
 * Scanning the raw file would make the honest explanation a failure.
 */
const MODULE_CODE = MODULE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("§E's review round chain", () => {
  it("holds the six states, each with its own Persian label", () => {
    expect(MEDIA_REVIEW_ROUND_STATUSES).toEqual([
      "draft",
      "sent",
      "approved",
      "changes_requested",
      "rejected",
      "withdrawn",
    ]);
    const labels = MEDIA_REVIEW_ROUND_STATUSES.map((s) => MEDIA_REVIEW_ROUND_STATUS_LABELS[s]);
    expect(labels.every((label) => label.trim().length > 0)).toBe(true);
    // Two states sharing a label is how a screen ends up showing the same word
    // for "the client refused" and "the agency pulled it back".
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("keeps draft → sent → a decision, and refuses to skip the sending", () => {
    expect(canTransitionReviewRound("draft", "sent")).toBe(true);
    expect(canTransitionReviewRound("sent", "approved")).toBe(true);
    expect(canTransitionReviewRound("sent", "changes_requested")).toBe(true);
    expect(canTransitionReviewRound("sent", "rejected")).toBe(true);
    // A draft the client has never seen cannot be approved behind their back.
    expect(canTransitionReviewRound("draft", "approved")).toBe(false);
    expect(canTransitionReviewRound("draft", "rejected")).toBe(false);
    expect(canTransitionReviewRound("draft", "withdrawn")).toBe(false);
  });

  it("makes an approval terminal, so a changed mind is a new round rather than an overwrite", () => {
    expect(reviewRoundTargetsFrom("approved")).toEqual([]);
    for (const to of MEDIA_REVIEW_ROUND_STATUSES) {
      expect(canTransitionReviewRound("approved", to)).toBe(false);
    }
    // Settled states are the history states: nothing is added to or decided on them.
    expect(MEDIA_REVIEW_SETTLED_STATUSES).toEqual(["approved", "rejected"]);
  });

  it("lets a refusal and a pull-back both return to sent, because either is feedback rather than an ending", () => {
    expect(canTransitionReviewRound("changes_requested", "sent")).toBe(true);
    expect(canTransitionReviewRound("rejected", "sent")).toBe(true);
    expect(canTransitionReviewRound("withdrawn", "sent")).toBe(true);
    // But none of them may jump straight to a decision without being re-sent.
    expect(canTransitionReviewRound("changes_requested", "approved")).toBe(false);
    expect(canTransitionReviewRound("rejected", "approved")).toBe(false);
    expect(canTransitionReviewRound("withdrawn", "approved")).toBe(false);
  });

  it("lets the agency withdraw a sent round, which is what makes revocation a state and not only a timestamp", () => {
    expect(canTransitionReviewRound("sent", "withdrawn")).toBe(true);
  });

  it("answers the same question the same way from either direction", () => {
    for (const from of MEDIA_REVIEW_ROUND_STATUSES) {
      for (const to of MEDIA_REVIEW_ROUND_STATUSES) {
        expect(canTransitionReviewRound(from, to)).toBe(reviewRoundTargetsFrom(from).includes(to));
      }
    }
  });

  it("only lets a client decide a round that was actually sent", () => {
    expect(MEDIA_REVIEW_DECIDABLE_STATUSES).toEqual(["sent"]);
  });

  it("recognises a status and refuses a lookalike", () => {
    expect(isReviewRoundStatus("sent")).toBe(true);
    expect(isReviewRoundStatus("approved")).toBe(true);
    expect(isReviewRoundStatus("submitted")).toBe(false);
    expect(isReviewRoundStatus("")).toBe(false);
    expect(isReviewRoundStatus(null)).toBe(false);
    expect(isReviewRoundStatus(7)).toBe(false);
  });

  it("freezes a round's contents once it is with the client", () => {
    // Assembling a round is what draft, and a round sent back for changes, are for.
    expect(isReviewRoundOpenForItems("draft")).toBe(true);
    expect(isReviewRoundOpenForItems("changes_requested")).toBe(true);
    expect(isReviewRoundOpenForItems("rejected")).toBe(true);
    expect(isReviewRoundOpenForItems("sent")).toBe(false);
    expect(isReviewRoundOpenForItems("approved")).toBe(false);
    expect(isReviewRoundOpenForItems("withdrawn")).toBe(false);
    // The two predicates must stay complements, or a state is neither frozen nor editable.
    for (const status of MEDIA_REVIEW_ROUND_STATUSES) {
      expect(isReviewRoundFrozen(status)).toBe(!isReviewRoundOpenForItems(status));
    }
  });
});

describe("§E's per-item states and the round they imply", () => {
  it("holds four item states with distinct Persian labels", () => {
    expect(MEDIA_REVIEW_ITEM_STATUSES).toEqual([
      "pending",
      "approved",
      "changes_requested",
      "rejected",
    ]);
    const labels = MEDIA_REVIEW_ITEM_STATUSES.map((s) => MEDIA_REVIEW_ITEM_STATUS_LABELS[s]);
    expect(new Set(labels).size).toBe(labels.length);
    expect(isReviewItemStatus("pending")).toBe(true);
    expect(isReviewItemStatus("sent")).toBe(false);
  });

  it("answers null rather than guessing when nothing has been decided", () => {
    // "No decisions yet" and "everything approved" must not be the same answer.
    expect(reviewRoundStateFromItems([])).toBeNull();
    expect(reviewRoundStateFromItems(["pending", "pending"])).toBeNull();
    expect(reviewRoundStateFromItems(["approved", "pending"])).toBeNull();
  });

  it("lets one refusal decide the batch, so a round is never approved over an objection", () => {
    expect(reviewRoundStateFromItems(["approved", "approved", "rejected"])).toBe("rejected");
    expect(reviewRoundStateFromItems(["approved", "changes_requested"])).toBe("changes_requested");
    expect(reviewRoundStateFromItems(["changes_requested", "rejected"])).toBe("rejected");
    expect(reviewRoundStateFromItems(["approved", "approved"])).toBe("approved");
  });

  it("knows when a client has finished", () => {
    expect(isReviewRoundFullyDecided([])).toBe(false);
    expect(isReviewRoundFullyDecided(["pending"])).toBe(false);
    expect(isReviewRoundFullyDecided(["approved", "rejected"])).toBe(true);
  });

  it("reports progress in Persian digits", () => {
    expect(formatReviewProgress(3, 5)).toBe("۳ از ۵");
    expect(formatReviewProgress(0, 0)).toBe("۰ از ۰");
    // A negative count is a bug upstream, not a reason to print "-1 از 5".
    expect(formatReviewProgress(-2, 5)).toBe("۰ از ۵");
  });
});

describe("§E's link purposes", () => {
  it("offers review and download, labelled separately", () => {
    expect(MEDIA_REVIEW_LINK_PURPOSES).toEqual(["review", "download"]);
    expect(MEDIA_REVIEW_LINK_PURPOSE_LABELS.review).not.toBe(MEDIA_REVIEW_LINK_PURPOSE_LABELS.download);
    expect(isReviewLinkPurpose("review")).toBe(true);
    expect(isReviewLinkPurpose("admin")).toBe(false);
  });

  it("does not hand over bytes to a review-only link", () => {
    // A print-ready file is often the deliverable the agency is still owed
    // money for, so approving it is not the same as being given it.
    expect(reviewLinkPurposeAllowsDownload("download")).toBe(true);
    expect(reviewLinkPurposeAllowsDownload("review")).toBe(false);
  });
});

describe("§E's format vocabulary", () => {
  it("names exactly the nine formats the issue lists", () => {
    expect(AGENCY_MEDIA_FORMATS).toEqual([
      "copy",
      "static_creative",
      "logo",
      "video",
      "print_ready",
      "ad_variant",
      "brief",
      "contract",
      "report",
    ]);
    const labels = AGENCY_MEDIA_FORMATS.map((f) => AGENCY_MEDIA_FORMAT_LABELS[f]);
    expect(labels.every((label) => label.trim().length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
    expect(isAgencyMediaFormat("print_ready")).toBe(true);
    expect(isAgencyMediaFormat("image")).toBe(false);
  });

  it("asks a client to approve creatives, not their own contract", () => {
    expect(AGENCY_MEDIA_APPROVABLE_FORMATS).toEqual([
      "copy",
      "static_creative",
      "logo",
      "video",
      "print_ready",
      "ad_variant",
    ]);
    // The three filed-for-information formats are deliberately not approvable.
    for (const format of ["brief", "contract", "report"] as const) {
      expect(AGENCY_MEDIA_APPROVABLE_FORMATS).not.toContain(format);
    }
    // And the subset really is a subset — a typo here would silently drop a format.
    for (const format of AGENCY_MEDIA_APPROVABLE_FORMATS) {
      expect(AGENCY_MEDIA_FORMATS).toContain(format);
    }
  });
});

describe("§E's link lifetime", () => {
  it("defaults to a week and refuses to go beyond a month", () => {
    expect(MEDIA_REVIEW_LINK_TTL_DAYS).toEqual({ default: 7, min: 1, max: 30 });
    expect(clampReviewLinkTtlDays(7)).toBe(7);
    expect(clampReviewLinkTtlDays(0)).toBe(1);
    expect(clampReviewLinkTtlDays(-5)).toBe(1);
    // A caller asking for a year gets a month: §E requires short-lived access.
    expect(clampReviewLinkTtlDays(365)).toBe(30);
    expect(clampReviewLinkTtlDays("nonsense")).toBe(7);
    expect(clampReviewLinkTtlDays(undefined)).toBe(7);
    expect(clampReviewLinkTtlDays(NaN)).toBe(7);
    expect(clampReviewLinkTtlDays(2.9)).toBe(2);
  });

  it("computes an expiry from the clamped days, never from the requested ones", () => {
    const now = new Date("2026-10-28T12:00:00.000Z");
    expect(reviewLinkExpiresAt(now, 7)).toBe("2026-11-04T12:00:00.000Z");
    expect(reviewLinkExpiresAt(now, 365)).toBe("2026-11-27T12:00:00.000Z");
    expect(reviewLinkExpiresAt(now, 0)).toBe("2026-10-29T12:00:00.000Z");
  });

  it("treats a revoked link as dead even while it is unexpired", () => {
    const now = new Date("2026-10-28T12:00:00.000Z");
    const live = { expiresAt: "2026-11-04T12:00:00.000Z", revokedAt: null };
    expect(isReviewLinkLive(live, now)).toBe(true);
    // The point of revocation: cutting a client off must not wait for expiry.
    expect(isReviewLinkLive({ ...live, revokedAt: "2026-10-28T11:00:00.000Z" }, now)).toBe(false);
    expect(isReviewLinkLive({ expiresAt: "2026-10-01T12:00:00.000Z", revokedAt: null }, now)).toBe(false);
  });

  it("refuses a link whose expiry cannot be read, rather than treating garbage as forever", () => {
    const now = new Date("2026-10-28T12:00:00.000Z");
    expect(isReviewLinkLive({ expiresAt: "not-a-date", revokedAt: null }, now)).toBe(false);
    expect(isReviewLinkLive({ expiresAt: new Date("nonsense"), revokedAt: null }, now)).toBe(false);
    // A Date instance is accepted too, because that is what the driver returns.
    expect(
      isReviewLinkLive({ expiresAt: new Date("2026-11-04T12:00:00.000Z"), revokedAt: null }, now),
    ).toBe(true);
  });

  it("says why a link was refused, so the client knows whom to ask", () => {
    const now = new Date("2026-10-28T12:00:00.000Z");
    expect(reviewLinkRefusal({ expiresAt: "2026-11-04T12:00:00.000Z", revokedAt: null }, now)).toBeNull();
    // Expired: ask for a new link. Revoked: ask the agency.
    expect(reviewLinkRefusal({ expiresAt: "2026-10-01T12:00:00.000Z", revokedAt: null }, now)).toBe(
      "expired",
    );
    expect(
      reviewLinkRefusal(
        { expiresAt: "2026-11-04T12:00:00.000Z", revokedAt: "2026-10-28T11:00:00.000Z" },
        now,
      ),
    ).toBe("revoked");
    // Revocation wins over expiry: the agency's act is the more specific fact.
    expect(
      reviewLinkRefusal(
        { expiresAt: "2026-10-01T12:00:00.000Z", revokedAt: "2026-09-01T11:00:00.000Z" },
        now,
      ),
    ).toBe("revoked");
  });
});

describe("§E's token shape", () => {
  it("namespaces a review link so a pasted API key is rejected before any lookup", () => {
    expect(MEDIA_REVIEW_TOKEN_PREFIX).toBe("bmrl_");
    expect(looksLikeMediaReviewToken("bmrl_abcdef")).toBe(true);
    expect(looksLikeMediaReviewToken("  bmrl_abcdef")).toBe(true);
    expect(looksLikeMediaReviewToken("posk_live_abcdef")).toBe(false);
    expect(looksLikeMediaReviewToken("")).toBe(false);
  });

  it("shows less of a token than it would take to authenticate with one", () => {
    expect(MEDIA_REVIEW_TOKEN_DISPLAY_LENGTH).toBe(16);
    const token = `${MEDIA_REVIEW_TOKEN_PREFIX}${"A".repeat(64)}`;
    const display = mediaReviewTokenDisplayPrefix(token);
    expect(display).toBe(token.slice(0, 16));
    expect(display.length).toBeLessThan(token.length);
    // The persisted prefix must not be the token: 16 of 69 characters is a label.
    expect(display.length).toBeLessThanOrEqual(token.length - 32);
  });
});

describe("§E's acts, and whose they are", () => {
  it("labels all five acts", () => {
    expect(MEDIA_REVIEW_ROUND_ACTIONS).toEqual([
      "send",
      "withdraw",
      "approve",
      "request_changes",
      "reject",
    ]);
    const labels = MEDIA_REVIEW_ROUND_ACTIONS.map((a) => MEDIA_REVIEW_ROUND_ACTION_LABELS[a]);
    expect(labels.every((label) => label.trim().length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
    expect(isReviewRoundAction("send")).toBe(true);
    expect(isReviewRoundAction("invoice")).toBe(false);
  });

  it("keeps sending and withdrawing out of a client's hands", () => {
    // The split is what stops a link from being a management console: a client
    // may decide, and only the agency may send or pull back.
    expect(isClientReviewAction("approve")).toBe(true);
    expect(isClientReviewAction("request_changes")).toBe(true);
    expect(isClientReviewAction("reject")).toBe(true);
    expect(isClientReviewAction("send")).toBe(false);
    expect(isClientReviewAction("withdraw")).toBe(false);
  });

  it("aims every act at a state the chain actually allows", () => {
    for (const action of MEDIA_REVIEW_ROUND_ACTIONS) {
      const target = reviewRoundActionTarget(action);
      expect(isReviewRoundStatus(target)).toBe(true);
      // The act's target must be reachable from somewhere, or it is a dead act.
      const reachable = MEDIA_REVIEW_ROUND_STATUSES.some((from) =>
        canTransitionReviewRound(from, target),
      );
      expect(reachable, `${action} targets an unreachable state`).toBe(true);
    }
    expect(reviewRoundActionTarget("send")).toBe("sent");
    expect(reviewRoundActionTarget("withdraw")).toBe("withdrawn");
    expect(reviewRoundActionTarget("approve")).toBe("approved");
    expect(reviewRoundActionTarget("request_changes")).toBe("changes_requested");
    expect(reviewRoundActionTarget("reject")).toBe("rejected");
  });

  it("offers only legal acts from each state", () => {
    expect(reviewRoundActionsFrom("draft")).toEqual(["send"]);
    expect(reviewRoundActionsFrom("sent")).toEqual([
      "approve",
      "request_changes",
      "reject",
      "withdraw",
    ]);
    expect(reviewRoundActionsFrom("approved")).toEqual([]);
    for (const status of ["changes_requested", "rejected", "withdrawn"] as const) {
      expect(reviewRoundActionsFrom(status)).toEqual(["send"]);
    }
    // Every offered act must land on a state the chain permits from here.
    for (const status of MEDIA_REVIEW_ROUND_STATUSES) {
      for (const action of reviewRoundActionsFrom(status)) {
        expect(
          canTransitionReviewRound(status, reviewRoundActionTarget(action)),
          `${action} offered from ${status} is not a legal transition`,
        ).toBe(true);
      }
    }
  });

  it("gives a client only decisions, and only on a sent round", () => {
    expect(clientReviewActionsFrom("sent")).toEqual(["approve", "request_changes", "reject"]);
    for (const status of MEDIA_REVIEW_ROUND_STATUSES) {
      if (status === "sent") continue;
      expect(clientReviewActionsFrom(status)).toEqual([]);
    }
    // And never an agency act, whatever the round's state.
    for (const status of MEDIA_REVIEW_ROUND_STATUSES) {
      for (const action of clientReviewActionsFrom(status)) {
        expect(isClientReviewAction(action)).toBe(true);
      }
    }
  });

  it("demands a reason for a refusal but not for an approval", () => {
    // "Changes requested" with nothing written is not actionable; an approval
    // has nothing to do next.
    expect(reviewDecisionNoteRequired("request_changes")).toBe(true);
    expect(reviewDecisionNoteRequired("reject")).toBe(true);
    expect(reviewDecisionNoteRequired("approve")).toBe(false);
    expect(reviewDecisionNoteRequired("send")).toBe(false);
    expect(reviewDecisionNoteRequired("withdraw")).toBe(false);
  });

  it("caps a client's note instead of letting it become a document", () => {
    expect(MEDIA_REVIEW_NOTE_MAX_LENGTH).toBe(2000);
    expect(trimReviewNote("  همه‌چیز خوب است  ")).toBe("همه‌چیز خوب است");
    expect(trimReviewNote("x".repeat(5000))).toHaveLength(2000);
    expect(trimReviewNote(null)).toBe("");
    expect(trimReviewNote(42)).toBe("");
    expect(trimReviewNote(undefined)).toBe("");
  });
});

describe("the module's own shape", () => {
  it("imports nothing but the digit formatter", () => {
    // A pure module that reaches for the database, the auth layer or node:crypto
    // stops being testable without them — and this one is on a browser bundle's
    // import path, so `node:crypto` in particular must stay in the service.
    const imports = [...MODULE_CODE.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports).toEqual(["./digits"]);
  });

  it("contains no permission, role or capability string", () => {
    // Authorization belongs to the service and the routes. A vocabulary module
    // that starts naming permissions is on its way to becoming a gate.
    expect(MODULE_CODE).not.toMatch(/media\.(view|manage)/);
    expect(MODULE_CODE).not.toMatch(/requirePermission|requireMember|withTenantScope/);
    expect(MODULE_CODE).not.toMatch(/createHash|randomBytes|node:crypto/);
  });

  it("never derives an act from a status name shared with another chain", () => {
    // §D's lesson: two registers shared four status names, so a chain could not
    // be inferred from a status. Every predicate here takes the status it is
    // given and nothing else — assert none of them reads a second vocabulary.
    expect(isReviewRoundStatus("pending")).toBe(false);
    expect(isReviewItemStatus("sent")).toBe(false);
    expect(isReviewRoundStatus("invoiced")).toBe(false);
    expect(isReviewItemStatus("draft")).toBe(false);
    const roundOnly: MediaReviewRoundStatus[] = ["draft", "sent", "withdrawn"];
    const itemOnly: MediaReviewItemStatus[] = ["pending"];
    for (const status of roundOnly) expect(isReviewItemStatus(status)).toBe(false);
    for (const status of itemOnly) expect(isReviewRoundStatus(status)).toBe(false);
    // The three names both vocabularies do share must still be told apart by
    // which predicate is asked, not by the string.
    for (const shared of ["approved", "changes_requested", "rejected"] as const) {
      expect(isReviewRoundStatus(shared)).toBe(true);
      expect(isReviewItemStatus(shared)).toBe(true);
    }
  });

  it("offers no act that is not labelled", () => {
    const actions: MediaReviewRoundAction[] = [...MEDIA_REVIEW_ROUND_ACTIONS];
    for (const action of actions) {
      expect(MEDIA_REVIEW_ROUND_ACTION_LABELS[action]).toBeTruthy();
    }
    expect(Object.keys(MEDIA_REVIEW_ROUND_ACTION_LABELS)).toEqual(actions);
  });
});

/* ---------------------------------------------------------------------------
 * Two doors over one act table, and the identity freeze
 * ------------------------------------------------------------------------- */

describe("who may act on a round (issue #1128 §E)", () => {
  it("splits the act catalogue into two doors that never overlap", () => {
    for (const status of MEDIA_REVIEW_ROUND_STATUSES) {
      const all = reviewRoundActionsFrom(status);
      const agency = agencyReviewActionsFrom(status);
      const client = clientReviewActionsFrom(status);
      // Every act the state machine allows belongs to exactly one door, and the
      // two doors together are the whole catalogue. A screen rendering either list
      // can therefore never offer a move the API would refuse.
      expect([...agency, ...client].sort(), status + ": doors do not cover the catalogue").toEqual(
        [...all].sort(),
      );
      expect(agency.filter((a) => client.includes(a)), status + ": doors overlap").toEqual([]);
    }
  });

  it("never offers a member the client's decision", () => {
    // Approving on a client's behalf is exactly what makes the approval worth
    // having, so the agency's door on a sent round is withdraw and nothing else.
    expect(agencyReviewActionsFrom("sent")).toEqual(["withdraw"]);
    expect(clientReviewActionsFrom("sent")).toEqual(["approve", "request_changes", "reject"]);
  });

  it("gives the client nothing to do until the round is sent", () => {
    expect(agencyReviewActionsFrom("draft")).toEqual(["send"]);
    expect(clientReviewActionsFrom("draft")).toEqual([]);
    expect(clientReviewActionsFrom("approved")).toEqual([]);
    // A withdrawn round's link must stop working even before it expires.
    expect(clientReviewActionsFrom("withdrawn")).toEqual([]);
    expect(agencyReviewActionsFrom("withdrawn")).toEqual(["send"]);
  });

  it("closes both doors on an approved round", () => {
    expect(agencyReviewActionsFrom("approved")).toEqual([]);
    expect(clientReviewActionsFrom("approved")).toEqual([]);
  });
});

describe("the identity freeze (issue #1128 §E)", () => {
  it("matches migration 0265's title-and-scope freeze exactly", () => {
    // 0265 freezes title and scope for sent/withdrawn, and freezes the whole row
    // for approved/rejected. draft and changes_requested stay editable.
    expect(isReviewRoundIdentityFrozen("draft")).toBe(false);
    expect(isReviewRoundIdentityFrozen("changes_requested")).toBe(false);
    for (const status of ["sent", "withdrawn", "approved", "rejected"] as const) {
      expect(isReviewRoundIdentityFrozen(status), status).toBe(true);
    }
  });

  it("is not the same set as the item freeze", () => {
    // The distinction is the point: a rejected round may still take assets, so it
    // is not "frozen" for items — yet its title and its client are fixed, because
    // those are what the client was shown.
    expect(isReviewRoundOpenForItems("rejected")).toBe(true);
    expect(isReviewRoundIdentityFrozen("rejected")).toBe(true);
    expect(isReviewRoundFrozen("rejected")).toBe(false);
  });
});

