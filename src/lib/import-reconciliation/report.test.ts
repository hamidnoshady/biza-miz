import { describe, expect, it } from "vitest";
import { buildReconciliationReportCsv, buildReconciliationRunReport, sanitizeReportText } from "./report";
import type { RunSummary, StagedItem } from "./service";

describe("reconciliation non-sensitive report (#1118)", () => {
  const summary: RunSummary = {
    run: {
      id: "run-1",
      businessId: "biz-1",
      locationId: "loc-1",
      domain: "product",
      sourceKind: "provider",
      provider: "woocommerce",
      sourceKey: "https://user:supersecret@shop.example?token=abc123",
      connectionId: "conn-1",
      importMode: "live_link",
      status: "applied",
      sourceFingerprint: "fp-1",
      profileKey: null,
      profileVersion: null,
      policyVersion: 1,
      canonicalToken: "tok-1",
      cutoverAuthority: "books",
      cutoverAt: "2026-11-10T10:00:00Z",
      policySnapshot: {},
      scope: {},
      cursor: {},
      evidence: { secretToken: "never-expose" },
      crossChecked: true,
      createdByName: "مدیر",
      createdAt: "2026-11-10T10:00:00Z",
      stagedAt: "2026-11-10T10:01:00Z",
      appliedAt: "2026-11-10T10:02:00Z",
    },
    counts: {
      read: 1,
      alreadyMapped: 0,
      proposedLinks: 1,
      newRecords: 0,
      conflicts: 0,
      invalid: 0,
      historical: 0,
      pending: 0,
      approved: 0,
      skipped: 0,
      applied: 1,
      failed: 0,
    },
    progress: {
      stage: "reconciled",
      label: "تطبیق کامل",
      fullyReconciled: true,
      remaining: 0,
    },
  };

  const items: StagedItem[] = [
    {
      id: 1,
      runId: "run-1",
      externalType: "product",
      externalKey: "w1",
      rowNumber: 2,
      snapshot: { name: "=HYPERLINK(\"http://evil\")", sku: "SKU-1" },
      outcome: "field_conflict",
      reasons: ["unique_sku"],
      canonicalId: "item-1",
      candidates: [],
      evidence: [],
      conflicts: [{ field: "price", fieldClass: "financial", canonical: "100", incoming: "200", action: "review", needsReview: true }],
      notes: [],
      historical: false,
      status: "applied",
      effect: "link",
      resolvedCanonicalId: "item-1",
      error: "failed at https://ck_123:cs_456@shop.example?consumer_secret=xyz",
      attempts: 1,
    },
  ];

  it("redacts URL credentials and query secrets from run and item fields", () => {
    expect(sanitizeReportText("https://ck:cs@example.com/wc?token=secret123")).toBe(
      "https://[redacted]@example.com/wc?token=[redacted]",
    );
    const report = buildReconciliationRunReport(summary, items);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("supersecret");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("never-expose");
    expect(serialized).not.toContain("cs_456");
    expect(serialized).not.toContain("consumer_secret=xyz");
    expect(report.run.cutoverAuthority).toBe("books");
  });

  it("neutralises CSV formula prefixes in labels and outputs safe columns", () => {
    const csv = buildReconciliationReportCsv(summary, items);
    expect(csv).toContain("row_number,external_type,external_key");
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toContain("cs_456");
  });
});
