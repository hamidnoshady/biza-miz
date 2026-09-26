import { describe, expect, it } from "vitest";
import {
  assertTendersExhausted,
  buildTenderQueue,
  drawTenders,
  groupTendersByCode,
  RetailTenderError,
  resolveLineTenders,
  resolveTenderAmounts,
  type RetailTenderInput,
} from "./retail-tenders";
import type { RialText } from "./inventory-exact";

const r = (n: number): RialText => String(n) as RialText;

describe("buildTenderQueue", () => {
  it("refuses an empty tender list", () => {
    expect(() => buildTenderQueue([])).toThrow(RetailTenderError);
  });

  it("refuses more than one open (amountless) tender", () => {
    const tenders: RetailTenderInput[] = [{ method: "cash" }, { method: "bank" }];
    expect(() => buildTenderQueue(tenders)).toThrow(RetailTenderError);
  });

  it("refuses a non-positive bounded amount", () => {
    expect(() => buildTenderQueue([{ method: "cash", amount: r(0) }])).toThrow(RetailTenderError);
    expect(() => buildTenderQueue([{ method: "cash", amount: r(-5) }])).toThrow(RetailTenderError);
  });

  it("refuses more than the tender cap", () => {
    const tenders: RetailTenderInput[] = Array.from({ length: 11 }, () => ({ method: "cash", amount: r(1) }));
    expect(() => buildTenderQueue(tenders)).toThrow(RetailTenderError);
  });

  it("sorts the open tender last regardless of input order", () => {
    const queue = buildTenderQueue([{ method: "cash" }, { method: "bank", amount: r(100) }]);
    expect(queue.map((e) => e.method)).toEqual(["bank", "cash"]);
    expect(queue[1].remaining).toBeNull();
  });
});

describe("drawTenders", () => {
  it("draws a single-method open tender for whatever the line needs, every time", () => {
    const queue = buildTenderQueue([{ method: "cash" }]);
    expect(drawTenders(queue, r(1000))).toEqual([{ method: "cash", amount: r(1000) }]);
    expect(drawTenders(queue, r(2500))).toEqual([{ method: "cash", amount: r(2500) }]);
    // The open entry is never exhausted, so it's still there for a third line.
    expect(queue).toHaveLength(1);
  });

  it("splits one line across two bounded tenders when the first runs out mid-line", () => {
    const queue = buildTenderQueue([
      { method: "cash", amount: r(300) },
      { method: "bank", amount: r(700) },
    ]);
    expect(drawTenders(queue, r(1000))).toEqual([
      { method: "cash", amount: r(300) },
      { method: "bank", amount: r(700) },
    ]);
    expect(remainingAfter(queue)).toBe(0n);
  });

  it("carries a queue across multiple lines without double-spending", () => {
    const queue = buildTenderQueue([
      { method: "cash", amount: r(600) },
      { method: "bank", amount: r(400) },
    ]);
    // Line 1 needs 500 — comes entirely from cash, 100 of it left for line 2.
    expect(drawTenders(queue, r(500))).toEqual([{ method: "cash", amount: r(500) }]);
    // Line 2 needs 500 — 100 remaining cash, then 400 bank.
    expect(drawTenders(queue, r(500))).toEqual([
      { method: "cash", amount: r(100) },
      { method: "bank", amount: r(400) },
    ]);
    expect(queue).toHaveLength(0);
  });

  it("merges two draws of the same method within one line into one slice", () => {
    // Same method twice in the queue (e.g. two named ways both settling as
    // 'bank') should still come back as a single grouped entry.
    const queue = [
      { method: "bank" as const, remaining: 300n },
      { method: "bank" as const, remaining: 200n },
    ];
    expect(drawTenders(queue, r(500))).toEqual([{ method: "bank", amount: r(500) }]);
  });

  it("throws when the bounded tenders run out before the line is covered", () => {
    const queue = buildTenderQueue([{ method: "cash", amount: r(100) }]);
    expect(() => drawTenders(queue, r(500))).toThrow(RetailTenderError);
  });

  it("draws nothing for a zero-total line and leaves the queue untouched", () => {
    const queue = buildTenderQueue([{ method: "cash", amount: r(100) }]);
    expect(drawTenders(queue, r(0))).toEqual([]);
    expect(remainingAfter(queue)).toBe(100n);
  });
});

function remainingAfter(queue: { remaining: bigint | null }[]): bigint {
  return queue.reduce((sum, e) => sum + (e.remaining ?? 0n), 0n);
}

describe("assertTendersExhausted", () => {
  it("passes once every bounded tender has been fully drawn", () => {
    const queue = buildTenderQueue([{ method: "cash", amount: r(1000) }]);
    drawTenders(queue, r(1000));
    expect(() => assertTendersExhausted(queue)).not.toThrow();
  });

  it("refuses a split that left bounded money on the table (overpayment)", () => {
    const queue = buildTenderQueue([
      { method: "cash", amount: r(1000) },
      { method: "bank", amount: r(500) },
    ]);
    drawTenders(queue, r(1000)); // only one line's worth drawn; 500 of bank never touched
    expect(() => assertTendersExhausted(queue)).toThrow(RetailTenderError);
  });

  it("never fails on an all-open queue, however much was drawn", () => {
    const queue = buildTenderQueue([{ method: "cash" }]);
    drawTenders(queue, r(999_999));
    expect(() => assertTendersExhausted(queue)).not.toThrow();
  });
});

describe("resolveTenderAmounts", () => {
  it("keeps every bounded amount and resolves the open one to the exact remainder", () => {
    const tenders: RetailTenderInput[] = [
      { method: "cash", amount: r(300_000) },
      { method: "bank" },
    ];
    expect(resolveTenderAmounts(tenders, r(1_000_000))).toEqual([
      { method: "cash", amount: r(300_000) },
      { method: "bank", amount: r(700_000) },
    ]);
  });

  it("resolves a single open tender to the whole invoice total", () => {
    expect(resolveTenderAmounts([{ method: "cash" }], r(470_000))).toEqual([
      { method: "cash", amount: r(470_000) },
    ]);
  });

  it("resolves to zero when the bounded tenders already covered everything", () => {
    const tenders: RetailTenderInput[] = [{ method: "cash", amount: r(1000) }, { method: "bank" }];
    expect(resolveTenderAmounts(tenders, r(1000))).toEqual([
      { method: "cash", amount: r(1000) },
      { method: "bank", amount: r(0) },
    ]);
  });

  it("preserves input order, not sorted order", () => {
    const tenders: RetailTenderInput[] = [{ method: "bank" }, { method: "cash", amount: r(400) }];
    expect(resolveTenderAmounts(tenders, r(1000)).map((t) => t.method)).toEqual(["bank", "cash"]);
  });
});

describe("groupTendersByCode", () => {
  it("sums two tenders that resolve to the same account", () => {
    const grouped = groupTendersByCode(
      [
        { method: "cash", amount: r(100) },
        { method: "bank", amount: r(200) },
      ],
      (m) => (m === "cash" ? "1000" : "1010"),
    );
    expect(grouped).toEqual([
      { code: "1000", amount: r(100) },
      { code: "1010", amount: r(200) },
    ]);
  });

  it("merges when two different methods map to the same account code", () => {
    const grouped = groupTendersByCode(
      [
        { method: "bank", amount: r(100) },
        { method: "credit", amount: r(50) },
      ],
      () => "1010", // contrived: both settle the same account
    );
    expect(grouped).toEqual([{ code: "1010", amount: r(150) }]);
  });
});

describe("resolveLineTenders", () => {
  it("uses the legacy single paymentMethod when no queue is given", () => {
    expect(resolveLineTenders({ paymentMethod: "cash" }, r(1000))).toEqual([
      { method: "cash", amount: r(1000) },
    ]);
  });

  it("draws from the shared queue when given one", () => {
    const queue = buildTenderQueue([{ method: "cash", amount: r(1000) }]);
    expect(resolveLineTenders({ tenders: queue }, r(400))).toEqual([{ method: "cash", amount: r(400) }]);
  });

  it("throws when neither is given", () => {
    expect(() => resolveLineTenders({}, r(1000))).toThrow(RetailTenderError);
  });
});
