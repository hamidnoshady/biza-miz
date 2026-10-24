// @vitest-environment jsdom

/**
 * Issue #909 §4 — behavioral coverage for the route-shaped skeletons, as a
 * companion to `loading-coverage.test.ts`'s static file/string checks: each
 * one must actually render the structure its name promises (a status region,
 * the right primitive composition for a report/table/form), so an edit that
 * keeps the import but guts the JSX cannot pass silently.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DashboardPageSkeleton, FormPageSkeleton, TablePageSkeleton } from "@/app/dashboard/page-chrome";

afterEach(() => {
  cleanup();
});

describe("route-level skeleton shapes", () => {
  it("DashboardPageSkeleton (the report shape) reserves a KPI row above its section", () => {
    const { container } = render(<DashboardPageSkeleton />);
    expect(container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
    // Four KPI placeholder cards, then the section below them.
    expect(container.querySelectorAll(".grid > [aria-hidden]").length).toBeGreaterThanOrEqual(4);
    expect(container.querySelector('[role="status"][aria-label="در حال بارگذاری محتوای صفحه"]')).not.toBeNull();
  });

  it("TablePageSkeleton (the table/list shape) has no KPI grid", () => {
    const { container } = render(<TablePageSkeleton />);
    expect(container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
    // No KPI stat grid — a table-only/catalogue screen has no numbers to promise.
    expect(container.querySelector(".grid")).toBeNull();
    expect(container.querySelector('[role="status"][aria-label="در حال بارگذاری فهرست"]')).not.toBeNull();
  });

  it("FormPageSkeleton (the form shape) reserves labelled field rows, not table rows or a KPI grid", () => {
    const { container } = render(<FormPageSkeleton />);
    const status = container.querySelector('[role="status"][aria-busy="true"]');
    expect(status).not.toBeNull();
    expect(container.querySelector(".grid")).toBeNull();
    // Five label-then-control pairs: a `.space-y-1.5` wrapper holding exactly
    // two skeleton bars (the label, then the control).
    const fieldRows = status?.querySelectorAll('[aria-hidden="true"] > .space-y-1\\.5');
    expect(fieldRows?.length).toBe(5);
  });
});
