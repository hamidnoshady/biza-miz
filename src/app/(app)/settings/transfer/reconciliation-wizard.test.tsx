// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReconciliationWizard } from "./reconciliation-wizard";

const runId = "11111111-1111-4111-8111-111111111111";

function runFixture(status = "in_review") {
  return {
    id: runId,
    domain: "product",
    sourceKind: "provider",
    provider: "woocommerce",
    sourceKey: "woo-1",
    connectionId: "22222222-2222-4222-8222-222222222222",
    importMode: "live_link",
    status,
    cutoverAuthority: "books",
    cutoverAt: "2026-11-01T00:00:00Z",
    createdByName: "مدیر آزمون",
    createdAt: "2026-11-01T00:00:00Z",
    appliedAt: status === "applied" ? "2026-11-01T01:00:00Z" : null,
  };
}

function countsFixture(pending = 1) {
  return {
    read: 2,
    alreadyMapped: 0,
    proposedLinks: 1,
    newRecords: 0,
    conflicts: pending,
    invalid: 0,
    historical: 0,
    pending,
    approved: pending === 0 ? 2 : 0,
    skipped: 0,
    applied: 0,
    failed: 0,
  };
}

function itemsFixture(conflictPending = true) {
  return [
    {
      id: 1,
      runId,
      externalType: "product",
      externalKey: "w-10",
      rowNumber: 1,
      snapshot: { name: "ساعت مچی کلاسیک", sku: "W-10" },
      outcome: "field_conflict",
      reasons: ["unique_sku"],
      canonicalId: "33333333-3333-4333-8333-333333333333",
      candidates: [{ id: "33333333-3333-4333-8333-333333333333", label: "ساعت مچی کلاسیک" }],
      conflicts: [
        {
          field: "stock_quantity",
          fieldClass: "stock",
          canonical: 10,
          incoming: 4,
          action: "review",
          needsReview: true,
        },
      ],
      notes: [],
      historical: false,
      status: conflictPending ? "proposed" : "approved",
      effect: conflictPending ? null : "link",
      resolvedCanonicalId: null,
      error: null,
    },
    {
      id: 2,
      runId,
      externalType: "product",
      externalKey: "w-11",
      rowNumber: 2,
      snapshot: { name: "بند چرمی", sku: "B-11" },
      outcome: "safe_match",
      reasons: ["unique_sku"],
      canonicalId: "44444444-4444-4444-8444-444444444444",
      candidates: [],
      conflicts: [],
      notes: [],
      historical: false,
      status: conflictPending ? "proposed" : "approved",
      effect: conflictPending ? null : "link",
      resolvedCanonicalId: null,
      error: null,
    },
  ];
}

describe("ReconciliationWizard UI (#1118)", () => {
  let pendingCount = 1;
  let runStatus = "in_review";
  let postedActions: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    pendingCount = 1;
    runStatus = "in_review";
    postedActions = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/data/reconciliation?")) {
          return new Response(JSON.stringify({ runs: [runFixture(runStatus)] }), { status: 200 });
        }
        if (url === "/api/data/reconciliation") {
          return new Response(JSON.stringify({ runs: [runFixture(runStatus)] }), { status: 200 });
        }
        if (url === `/api/data/reconciliation/${runId}` && (!init?.method || init.method === "GET")) {
          return new Response(
            JSON.stringify({
              run: runFixture(runStatus),
              counts: countsFixture(pendingCount),
              progress: { stage: runStatus, label: "آماده", fullyReconciled: runStatus === "applied", remaining: pendingCount },
              items: itemsFixture(pendingCount > 0),
            }),
            { status: 200 },
          );
        }
        if (url === `/api/data/reconciliation/${runId}` && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          postedActions.push(body);
          if (body.action === "decide" || body.action === "approve_safe") {
            pendingCount = 0;
          } else if (body.action === "apply") {
            runStatus = "applied";
          }
          return new Response(
            JSON.stringify({
              ok: true,
              summary: {
                run: runFixture(runStatus),
                counts: countsFixture(pendingCount),
                progress: { stage: runStatus, label: "تکمیل", fullyReconciled: runStatus === "applied", remaining: pendingCount },
              },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders summary, filters rows, posts authority & batch approvals, applies, and fires onCompleted", async () => {
    const onCompleted = vi.fn();
    render(<ReconciliationWizard initialRunId={runId} onCompleted={onCompleted} />);

    await waitFor(() => {
      expect(screen.getAllByText("ساعت مچی کلاسیک").length).toBeGreaterThan(0);
      expect(screen.getByText("بند چرمی")).toBeTruthy();
    });

    // Report download links exist with safe non-PII routes
    const csvLink = screen.getByRole("link", { name: /خروجی CSV/ }) as HTMLAnchorElement;
    expect(csvLink.getAttribute("href")).toBe(`/api/data/reconciliation/${runId}?report=csv`);

    // Apply button is disabled while pending items remain
    const applyBtn = screen.getByRole("button", { name: "اعمال نهایی تصمیم‌ها" }) as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true);

    // Choose authority on conflict item (auto-populates default canonical overrides)
    const chooseBtns = screen.getAllByRole("button", { name: "انتخاب مرجع فیلد" });
    fireEvent.click(chooseBtns[0]);
    await waitFor(() => {
      expect(
        postedActions.some(
          (a) =>
            a.action === "decide" &&
            a.decision === "choose_authority" &&
            (a.authorityOverrides as Record<string, string>)?.stock_quantity === "canonical",
        ),
      ).toBe(true);
    });

    // Apply button enables once pending === 0, triggers apply & onCompleted
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "اعمال نهایی تصمیم‌ها" }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "اعمال نهایی تصمیم‌ها" }));
    await waitFor(() => {
      expect(onCompleted).toHaveBeenCalledTimes(1);
    });

    // Filter chip filters items cleanly
    fireEvent.click(screen.getByRole("button", { name: "تطبیق امن" }));
    expect(screen.queryByText("ساعت مچی کلاسیک")).toBeNull();
    expect(screen.getByText("بند چرمی")).toBeTruthy();
  });

  it("loads additional cursor pages when hasMore is true", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/data/reconciliation") {
        return new Response(JSON.stringify({ runs: [runFixture("in_review")] }), { status: 200 });
      }
      if (url === `/api/data/reconciliation/${runId}`) {
        return new Response(
          JSON.stringify({
            run: runFixture("in_review"),
            counts: { ...countsFixture(1), read: 101 },
            progress: { stage: "in_review", label: "آماده", fullyReconciled: false, remaining: 1 },
            items: itemsFixture(true),
            nextCursor: 2,
            hasMore: true,
          }),
          { status: 200 },
        );
      }
      if (url === `/api/data/reconciliation/${runId}?afterId=2&limit=100`) {
        return new Response(
          JSON.stringify({
            items: [
              {
                ...itemsFixture(false)[1],
                id: 3,
                externalKey: "w-101",
                snapshot: { name: "کالای صفحهٔ دوم", sku: "W-101" },
              },
            ],
            nextCursor: null,
            hasMore: false,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ReconciliationWizard initialRunId={runId} />);

    const loadMoreBtn = await screen.findByRole("button", { name: "بارگذاری ردیف‌های بیشتر" });
    fireEvent.click(loadMoreBtn);

    await waitFor(() => {
      expect(screen.getByText("کالای صفحهٔ دوم")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "بارگذاری ردیف‌های بیشتر" })).toBeNull();
    });
  });
});
