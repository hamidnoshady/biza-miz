// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLogSettings } from "./audit-log-settings";

const fiscalEvents = [
  ["fiscal_year.created", "fiscal_year", "تعریف سال مالی"],
  ["fiscal_period.soft_closed", "fiscal_period", "بستن موقت دورهٔ مالی"],
  ["fiscal_period.locked", "fiscal_period", "قفل‌کردن دورهٔ مالی"],
  ["fiscal_period.reopened", "fiscal_period", "بازگشایی دورهٔ مالی"],
  ["fiscal_year.closed", "fiscal_year", "بستن نهایی سال مالی"],
] as const;

const entries = fiscalEvents.map(([action, entity], index) => ({
  id: index + 1,
  actorName: "حسابدار",
  action,
  entity,
  entityId: null,
  entityName: null,
  locationName: null,
  createdAt: "2026-10-12T10:00:00.000Z",
  credentialType: null,
  deviceLabel: null,
}));

const requestedUrls: string[] = [];

beforeEach(() => {
  requestedUrls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({ entries }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AuditLogSettings fiscal audit rows", () => {
  it("renders Persian lifecycle/entity labels and offers fiscal entity filters", async () => {
    render(<AuditLogSettings />);

    for (const [, , label] of fiscalEvents) {
      expect(await screen.findByText(label)).toBeTruthy();
    }
    expect(screen.getAllByText("سال مالی").length).toBeGreaterThan(1);
    expect(screen.getAllByText("دورهٔ مالی").length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole("button", { name: "سال مالی" }));
    await waitFor(() => {
      expect(
        requestedUrls.some((url) => new URL(url, "http://localhost").searchParams.get("entity") === "fiscal_year"),
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "دورهٔ مالی" }));
    await waitFor(() => {
      expect(
        requestedUrls.some((url) => new URL(url, "http://localhost").searchParams.get("entity") === "fiscal_period"),
      ).toBe(true);
    });
  });
});
