import { describe, expect, it } from "vitest";
import {
  canDecideOnDraft,
  isDraftAuthor,
  MANUAL_IDEMPOTENCY_KEY_MAX,
  MANUAL_LINES_MAX,
  MANUAL_MEMO_MAX,
  MANUAL_REJECTION_REASON_MAX,
  manualDocumentProblem,
  manualJournalTotals,
  manualMemoProblem,
  manualRejectionReasonProblem,
  nonZeroLines,
  parseManualDraftPayload,
  type ManualJournalLine,
} from "./manual-journal";

/** Rent paid in cash — the two-line document the screen exists to write. */
function balanced(): ManualJournalLine[] {
  return [
    { accountId: "expense", debit: 100_000, credit: 0 },
    { accountId: "cash", debit: 0, credit: 100_000 },
  ];
}

describe("nonZeroLines", () => {
  it("drops the rows carrying no amount", () => {
    expect(
      nonZeroLines([...balanced(), { accountId: "bank", debit: 0, credit: 0 }]),
    ).toEqual(balanced());
  });
});

describe("manualJournalTotals", () => {
  it("sums each side and reports debit − credit", () => {
    expect(manualJournalTotals(balanced())).toEqual({
      totalDebit: 100_000n,
      totalCredit: 100_000n,
      difference: 0n,
    });
  });

  it("stays exact past Number.MAX_SAFE_INTEGER in aggregate", () => {
    // Ten rows just under the safe-integer ceiling: each is a legal amount,
    // their sum is not a safe Number. BigInt totals keep the comparison honest
    // instead of silently rounding two unequal sides into equality.
    const big = Number.MAX_SAFE_INTEGER - 1;
    const lines: ManualJournalLine[] = Array.from({ length: 10 }, (_, i) => ({
      accountId: `a${i}`,
      debit: big,
      credit: 0,
    }));
    expect(manualJournalTotals(lines).totalDebit).toBe(BigInt(big) * 10n);
  });
});

describe("manualDocumentProblem", () => {
  it("accepts a balanced two-account document", () => {
    expect(manualDocumentProblem(balanced())).toBeNull();
  });

  it("rejects a document with no amounts at all", () => {
    expect(manualDocumentProblem([{ accountId: "cash", debit: 0, credit: 0 }])).toBe("no_lines");
    expect(manualDocumentProblem([])).toBe("no_lines");
  });

  it("rejects a single row, which can never be a double entry", () => {
    expect(
      manualDocumentProblem([{ accountId: "cash", debit: 100_000, credit: 0 }]),
    ).toBe("too_few_lines");
  });

  it("rejects a balanced document that only touches one account", () => {
    // «صندوق بدهکار ۱۰٬۰۰۰ / صندوق بستانکار ۱۰٬۰۰۰» — arithmetically balanced,
    // financially meaningless, and permanent once posted. The screen used to
    // call this «متوازن».
    expect(
      manualDocumentProblem([
        { accountId: "cash", debit: 100_000, credit: 0 },
        { accountId: "cash", debit: 0, credit: 100_000 },
      ]),
    ).toBe("single_account_entry");
  });

  it("allows one account to repeat as long as two are named", () => {
    expect(
      manualDocumentProblem([
        { accountId: "expense", debit: 60_000, credit: 0 },
        { accountId: "expense", debit: 40_000, credit: 0 },
        { accountId: "cash", debit: 0, credit: 100_000 },
      ]),
    ).toBeNull();
  });

  it("rejects an unbalanced document", () => {
    expect(
      manualDocumentProblem([
        { accountId: "expense", debit: 100_000, credit: 0 },
        { accountId: "cash", debit: 0, credit: 90_000 },
      ]),
    ).toBe("not_balanced");
  });

  it("rejects a row that is both debit and credit, or has no account", () => {
    expect(
      manualDocumentProblem([
        { accountId: "expense", debit: 100_000, credit: 100_000 },
        { accountId: "cash", debit: 0, credit: 100_000 },
      ]),
    ).toBe("invalid_line");
    expect(
      manualDocumentProblem([
        { accountId: "", debit: 100_000, credit: 0 },
        { accountId: "cash", debit: 0, credit: 100_000 },
      ]),
    ).toBe("invalid_line");
  });

  it("rejects negative and fractional amounts", () => {
    expect(
      manualDocumentProblem([
        { accountId: "expense", debit: -100_000, credit: 0 },
        { accountId: "cash", debit: 0, credit: -100_000 },
      ]),
    ).toBe("invalid_line");
    expect(
      manualDocumentProblem([
        { accountId: "expense", debit: 100_000.5, credit: 0 },
        { accountId: "cash", debit: 0, credit: 100_000.5 },
      ]),
    ).toBe("invalid_line");
  });

  it("caps the number of rows in one document", () => {
    const rows = (n: number): ManualJournalLine[] => [
      ...Array.from({ length: n }, (_, i) => ({ accountId: `a${i}`, debit: 10, credit: 0 })),
      { accountId: "cash", debit: 0, credit: 10 * n },
    ];
    expect(manualDocumentProblem(rows(MANUAL_LINES_MAX - 1))).toBeNull();
    expect(manualDocumentProblem(rows(MANUAL_LINES_MAX))).toBe("too_many_lines");
  });

  it("checks the row shape before the balance, so a bad row is named as one", () => {
    // Both wrong at once: the actionable message is "fix this row", not
    // "the totals differ".
    expect(
      manualDocumentProblem([
        { accountId: "expense", debit: 1.5, credit: 0 },
        { accountId: "cash", debit: 0, credit: 999 },
      ]),
    ).toBe("invalid_line");
  });
});

describe("manualMemoProblem", () => {
  it("requires a memo that is more than whitespace", () => {
    expect(manualMemoProblem("")).toBe("memo_required");
    expect(manualMemoProblem("   ")).toBe("memo_required");
  });

  it("accepts a normal memo", () => {
    expect(manualMemoProblem("تسویه مالیات بر ارزش افزوده")).toBeNull();
  });

  it("caps the memo length, measuring the trimmed text", () => {
    expect(manualMemoProblem("x".repeat(MANUAL_MEMO_MAX))).toBeNull();
    expect(manualMemoProblem("x".repeat(MANUAL_MEMO_MAX + 1))).toBe("memo_too_long");
    // Trailing whitespace is trimmed before storage, so it must not push an
    // otherwise-legal memo over the cap.
    expect(manualMemoProblem(`${"x".repeat(MANUAL_MEMO_MAX)}    `)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The API boundary: parseManualDraftPayload
//
// This is the function that stands between an untrusted request body and a
// `::uuid[]` cast inside PostgreSQL, so what it refuses is as much the
// contract as what it accepts. Every case below is a real shape a broken or
// hostile client sends, not a hypothetical one.
// ---------------------------------------------------------------------------

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function body(lines: unknown[], extra: Record<string, unknown> = {}) {
  return { memo: "Rent", lines, ...extra };
}

describe("parseManualDraftPayload", () => {
  it("reads the shape the screen sends", () => {
    const result = parseManualDraftPayload(
      body([
        { accountId: UUID_A, debit: 100_000, credit: 0 },
        { accountId: UUID_B, debit: 0, credit: 100_000 },
      ]),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        memo: "Rent",
        entryDate: null,
        lines: [
          { accountId: UUID_A, debit: 100_000, credit: 0 },
          { accountId: UUID_B, debit: 0, credit: 100_000 },
        ],
        idempotencyKey: null,
      },
    });
  });

  it("treats a missing, empty or null date as «امروز» for the service to resolve", () => {
    for (const entryDate of [undefined, null, "", "   "]) {
      const result = parseManualDraftPayload(body([], { entryDate }));
      expect(result.ok ? result.value.entryDate : result.problem).toBe(
        // An all-whitespace string is still a string the service must validate
        // (and reject) as a date; only genuinely empty values mean "today".
        entryDate === "   " ? "   " : null,
      );
    }
  });

  it("rejects a non-object body, an array, and a non-array lines", () => {
    for (const bad of [null, 42, "x", [], undefined]) {
      expect(parseManualDraftPayload(bad)).toEqual({ ok: false, problem: "bad_request" });
    }
    expect(parseManualDraftPayload({ memo: "x", lines: "nope" })).toEqual({
      ok: false,
      problem: "bad_request",
    });
  });

  it("refuses an oversized raw array before mapping a single row of it", () => {
    // The cap used to be applied *after* `rawLines.map(...)`, so a client could
    // make the server build ten thousand objects in order to be told there are
    // too many. Counting the raw array first means a hostile body costs one
    // comparison. (The `map` is what is proven avoided here: the rows are not
    // even well-formed, so if they were being coerced the first failure would
    // be `invalid_account_id`, not `too_many_lines`.)
    const huge = Array.from({ length: MANUAL_LINES_MAX + 1 }, () => ({ notEvenClose: true }));
    expect(parseManualDraftPayload(body(huge))).toEqual({ ok: false, problem: "too_many_lines" });
  });

  it("refuses a non-UUID account id instead of letting PostgreSQL raise on the cast", () => {
    for (const accountId of ["unknown", 7, null, "", `${UUID_A} `, UUID_A.toUpperCase().replace(/-/g, "")]) {
      const result = parseManualDraftPayload(body([{ accountId, debit: 1, credit: 0 }]));
      expect(result).toEqual({ ok: false, problem: "invalid_account_id" });
    }
  });

  it("accepts an upper- and lower-case UUID, the form Postgres accepts", () => {
    const mixed = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
    const result = parseManualDraftPayload(body([{ accountId: mixed, debit: 1, credit: 0 }]));
    expect(result.ok).toBe(true);
  });

  it("refuses coerced amounts: booleans, numeric strings, NaN, Infinity and fractions", () => {
    // `Number(l.debit) || 0` turned every one of these into a real-looking
    // number — a boolean into 1, a Persian string into NaN-then-0, a float into
    // a fractional Rial the ledger column cannot hold.
    for (const debit of [true, false, "1000", "۱۰۰۰", NaN, Infinity, -Infinity, 1.5, -5, {}, [], null]) {
      const result = parseManualDraftPayload(
        body([
          { accountId: UUID_A, debit, credit: 0 },
          { accountId: UUID_B, debit: 0, credit: 100 },
        ]),
      );
      expect(result).toEqual({ ok: false, problem: "invalid_amount" });
    }
  });

  it("treats an absent side as zero rather than as a malformed amount", () => {
    const result = parseManualDraftPayload(body([{ accountId: UUID_A, debit: 10 }]));
    expect(result.ok && result.value.lines[0]).toEqual({ accountId: UUID_A, debit: 10, credit: 0 });
  });

  it("carries a trimmed idempotency key and refuses an unusable one", () => {
    const ok = parseManualDraftPayload(body([], { idempotencyKey: "  retry-1  " }));
    expect(ok.ok && ok.value.idempotencyKey).toBe("retry-1");
    // An empty key would dedupe every draft a caller ever sends into one.
    for (const idempotencyKey of ["", "   ", 12, {}, "x".repeat(MANUAL_IDEMPOTENCY_KEY_MAX + 1)]) {
      expect(parseManualDraftPayload(body([], { idempotencyKey }))).toEqual({
        ok: false,
        problem: "invalid_idempotency_key",
      });
    }
  });

  it("refuses a row that is not an object", () => {
    for (const row of [null, 5, "row", []]) {
      expect(parseManualDraftPayload(body([row]))).toEqual({ ok: false, problem: "invalid_line" });
    }
  });
});

describe("manualRejectionReasonProblem", () => {
  it("requires a reason, so a rejection is never a bare deletion", () => {
    expect(manualRejectionReasonProblem(null)).toBe("rejection_reason_required");
    expect(manualRejectionReasonProblem("")).toBe("rejection_reason_required");
    expect(manualRejectionReasonProblem("   ")).toBe("rejection_reason_required");
  });

  it("accepts a sentence and caps it, measuring the trimmed text", () => {
    expect(manualRejectionReasonProblem("مبلغ با فاکتور مطابقت ندارد")).toBeNull();
    expect(manualRejectionReasonProblem("x".repeat(MANUAL_REJECTION_REASON_MAX))).toBeNull();
    expect(manualRejectionReasonProblem("x".repeat(MANUAL_REJECTION_REASON_MAX + 1))).toBe(
      "rejection_reason_too_long",
    );
  });
});

// ---------------------------------------------------------------------------
// Who may decide a draft — the rule the two routes and the screen share
// ---------------------------------------------------------------------------

describe("canDecideOnDraft", () => {
  it("lets an approve-only role reject somebody else's draft", () => {
    // The documented workflow, which the old `ledger.propose` gate on DELETE
    // refused: the reviewer's capability is `ledger.approve`, full stop.
    expect(
      canDecideOnDraft({
        actorId: "reviewer",
        draftAuthorId: "proposer",
        canApprove: true,
      }).mayDecide,
    ).toBe(true);
  });

  it("lets the drafter withdraw their own draft with no approval permission at all", () => {
    expect(
      canDecideOnDraft({
        actorId: "proposer",
        draftAuthorId: "proposer",
        canApprove: false,
      }).mayDecide,
    ).toBe(true);
  });

  it("lets the drafter withdraw their own draft even after propose is revoked", () => {
    // The rule never consults `ledger.propose`, so a permission change cannot
    // strand a draft its author can no longer touch. `canApprove: false` is
    // the whole state after the revocation.
    expect(
      canDecideOnDraft({ actorId: "proposer", draftAuthorId: "proposer", canApprove: false }),
    ).toEqual({ mayDecide: true, isAuthor: true });
  });

  it("refuses a member who is neither the author nor an approver", () => {
    expect(
      canDecideOnDraft({ actorId: "someone-else", draftAuthorId: "proposer", canApprove: false })
        .mayDecide,
    ).toBe(false);
  });

  it("does not treat an unknown viewer as the author", () => {
    // A missing identity must not match a draft authored by nobody: an
    // authorless row is nobody's to withdraw.
    expect(isDraftAuthor({ actorId: undefined, draftAuthorId: null })).toBe(false);
    expect(isDraftAuthor({ actorId: "", draftAuthorId: "" })).toBe(false);
  });
});
