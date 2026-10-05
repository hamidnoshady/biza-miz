/**
 * Issue #799 §30 — the report catalogue.
 *
 * The catalogue is data, so what is worth asserting is what a reader is
 * promised: every §30 entry this build claims is here, every gate names a real
 * capability, the state those gates produce matches §21's rule (a capability
 * off means the report is *absent*), and every column is a kind the UI knows
 * how to render — a `money` column that the panel treated as text would print
 * raw rials beside a formatted figure.
 */
import { describe, expect, it } from "vitest";
import { AEC_CAPABILITY_KEYS, AEC_AI_TOOL_NAMES } from "./aec";
import {
  AEC_AGING_BUCKET_LABELS,
  AEC_REPORTS,
  AEC_REPORT_AI_TOOL,
  AEC_REPORT_CELL_KINDS,
  AEC_REPORT_KEYS,
  aecReportDefinition,
  aecReportKeysFor,
  agingBucket,
  isAecReportKey,
  reportAgeDays,
  reportPercent,
  reportsForCapabilities,
} from "./aec-reports";

describe("the §30 report catalogue", () => {
  it("answers every report the issue names that this build has data for", () => {
    // §30's list, minus the ones that are Accounting's own reports (payroll,
    // tax, bank reconciliation) — those are not AEC reports and the issue says
    // the posted financial facts stay in Accounting.
    for (const key of [
      "project_health",
      "schedule_variance",
      "budget_vs_actual",
      "committed_vs_budget",
      "forecast_final_cost",
      "project_margin",
      "boq_variance",
      "change_order_exposure",
      "procurement_delay",
      "rfi_aging",
      "submittal_aging",
      "document_status",
      "contractor_performance",
      "site_productivity",
      "snag_aging",
      "inspection_status",
      "certificate_status",
    ]) {
      expect(isAecReportKey(key), key).toBe(true);
      expect(() => aecReportDefinition(key as (typeof AEC_REPORT_KEYS)[number])).not.toThrow();
    }
    expect(AEC_REPORTS.length).toBe(AEC_REPORT_KEYS.length);
  });

  it("names each report once, with a label, a description and a readable row shape", () => {
    const keys = new Set<string>();
    for (const report of AEC_REPORTS) {
      expect(keys.has(report.key), report.key).toBe(false);
      keys.add(report.key);
      expect(report.label.trim().length, report.key).toBeGreaterThan(0);
      expect(report.description.trim().length, report.key).toBeGreaterThan(0);
      expect(report.columns.length, report.key).toBeGreaterThan(0);
      expect(report.emptyMessage.trim().length, report.key).toBeGreaterThan(0);
      for (const column of report.columns) {
        expect(AEC_REPORT_CELL_KINDS, `${report.key}.${column.key}`).toContain(column.kind);
        expect(column.label.trim().length, `${report.key}.${column.key}`).toBeGreaterThan(0);
      }
    }
    expect(aecReportKeysFor(["project_margin", "project_health"]).map((r) => r.key)).toEqual([
      "project_health",
      "project_margin",
    ]);
  });

  it("gates only on capabilities that exist", () => {
    for (const report of AEC_REPORTS) {
      if (report.capability) {
        expect(AEC_CAPABILITY_KEYS, `${report.key} → ${report.capability}`).toContain(report.capability);
      }
    }
  });

  it("removes a report whose capability is off, rather than emptying it", () => {
    const all = reportsForCapabilities([...AEC_CAPABILITY_KEYS]).map((report) => report.key);
    expect(all.length).toBe(AEC_REPORTS.length);

    // An architecture office's preset: no procurement, no site, no claims.
    const office = reportsForCapabilities([
      "projects",
      "participants",
      "boq",
      "document_control",
      "financials",
    ]).map((report) => report.key);
    expect(office).toContain("project_health");
    expect(office).toContain("rfi_aging");
    expect(office).toContain("document_status");
    expect(office).toContain("boq_variance");
    expect(office).not.toContain("procurement_delay");
    expect(office).not.toContain("contractor_performance");
    expect(office).not.toContain("site_productivity");
    expect(office).not.toContain("certificate_status");
    expect(office).not.toContain("snag_aging");
  });

  it("names the assistant read behind each figure, and only real tools", () => {
    for (const [key, tool] of Object.entries(AEC_REPORT_AI_TOOL)) {
      expect(isAecReportKey(key), key).toBe(true);
      expect(AEC_AI_TOOL_NAMES, `${key} → ${tool}`).toContain(tool);
    }
    // The registers that a report reads are exactly the ones with a tool; a
    // report with no tool is an aggregate no §23 read answers.
    expect(AEC_REPORT_AI_TOOL.procurement_delay).toBe("list_procurement_delays");
    expect(AEC_REPORT_AI_TOOL.rfi_aging).toBe("list_pending_rfis");
  });

  it("shares one aging definition across the registers", () => {
    expect(agingBucket(0)).toBe("on_time");
    expect(agingBucket(1)).toBe("waiting");
    expect(agingBucket(14)).toBe("waiting");
    expect(agingBucket(15)).toBe("late");
    expect(agingBucket(30)).toBe("late");
    expect(agingBucket(31)).toBe("stale");
    expect(Object.keys(AEC_AGING_BUCKET_LABELS).sort()).toEqual([
      "late",
      "on_time",
      "stale",
      "waiting",
    ]);
  });

  it("counts days and percents without inventing values", () => {
    expect(reportAgeDays("2026-01-01", "2026-01-11")).toBe(10);
    expect(reportAgeDays(null, "2026-01-11")).toBe(0);
    expect(reportAgeDays("not-a-date", "2026-01-11")).toBe(0);
    // A future date is not negative age.
    expect(reportAgeDays("2026-02-01", "2026-01-11")).toBe(0);
    expect(reportPercent(25, 100)).toBe(25);
    // No denominator means no answer, never a zero that reads as "none".
    expect(reportPercent(25, null)).toBeNull();
    expect(reportPercent(25, 0)).toBeNull();
    expect(reportPercent(null, 100)).toBeNull();
  });

  it("keeps the two reports that the margin needs honest about being forecasts", () => {
    const margin = aecReportDefinition("project_margin");
    expect(margin.capability).toBe("financials");
    expect(margin.note).toContain("پیش‌بینی");
    // …and the cost forecast says a missing half is a dash, never a zero.
    const forecast = aecReportDefinition("forecast_final_cost");
    expect(forecast.note).toContain("صفر");
  });
});
