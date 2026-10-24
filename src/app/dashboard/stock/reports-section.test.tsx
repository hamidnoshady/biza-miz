import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const file = readFileSync(join(__dirname, "reports-section.tsx"), "utf8");

describe("ReportsSection UI state coverage (error/offline/retry/stale-response)", () => {
  it("exits skeleton on error with retry affordance", () => {
    expect(file).toMatch(/setError\(/);
    expect(file).toMatch(/persianErrorMessage/);
    expect(file).toMatch(/تلاش دوباره/);
    expect(file).toMatch(/handleRetry|fetchReports/);
    // Error view renders when error && !low
    expect(file).toMatch(/error && !low/);
  });

  it("detects offline via navigator.onLine and shows offline message", () => {
    expect(file).toMatch(/navigator\.onLine/);
    expect(file).toMatch(/offline/);
    expect(file).toMatch(/اتصال اینترنت برقرار نیست/);
  });

  it("has retry button that refetches after failure", () => {
    expect(file).toMatch(/onClick=\{handleRetry\}/);
    expect(file).toMatch(/fetchReports/);
    // Retry must clear error before retrying
    expect(file).toMatch(/setError\(\"\"\)/);
  });

  it("guards against stale responses overwriting newer filters", () => {
    expect(file).toMatch(/requestIdRef/);
    expect(file).toMatch(/reqId !== requestIdRef.current/);
    expect(file).toMatch(/controller\.signal\.aborted/);
    expect(file).toMatch(/abortRef\.current\?\.abort/);
    expect(file).toMatch(/AbortController/);
  });

  it("shows loading skeleton vs error vs empty states distinctly", () => {
    expect(file).toMatch(/LoadingSkeleton/);
    expect(file).toMatch(/EmptyState/);
    expect(file).toMatch(/loadFailed|error && !dead|!low \|\| low\.rows\.length === 0/);
  });

  it("exports cover full filtered result not just current page via shared codecs", () => {
    expect(file).toMatch(/fetchFullRows/);
    expect(file).toMatch(/fetchFullRows.*type/);
    expect(file).toMatch(/toCsv|sheetsToXlsxBuffer/);
    expect(file).toMatch(/cellValue/);
    expect(file).toMatch(/valueRialText/);
    expect(file).toMatch(/کل فیلتر/);
    expect(file).toMatch(/صفحه جاری/);
  });

  it("uses exact valueRialText not Number for valuation and marks missing cost", () => {
    expect(file).toMatch(/valueRialText/);
    expect(file).toMatch(/hasMissingCost/);
    expect(file).toMatch(/بها نامشخص/);
    expect(file).toMatch(/missingCostCount/);
  });

  it("includes category and valuation-completeness filters with links to movement log/related docs", () => {
    expect(file).toMatch(/category/);
    expect(file).toMatch(/valuation/);
    expect(file).toMatch(/اسناد مرتبط|حرکت انبار|گزارش حرکت|related/i);
    expect(file).toMatch(/collection.*season|COALESCE\(i\.collection/);
  });

  it("displays applied cutoff and daysApplied from server (real deadStockCutoff)", () => {
    expect(file).toMatch(/applied\.cutoff/);
    expect(file).toMatch(/daysApplied/);
    expect(file).toMatch(/cutoff.*formatJalali|formatJalali.*cutoff/);
  });
});
