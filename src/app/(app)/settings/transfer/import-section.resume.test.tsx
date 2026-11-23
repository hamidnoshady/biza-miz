// @vitest-environment jsdom

/**
 * Issue #1535 / ESH-218 — resuming a saved import session.
 *
 * The wizard's «ادامهٔ بازبینی» must reopen the SAME job through the same
 * mapping/preview UI: one GET to read the stored job, one PATCH to re-validate
 * it against today's data, and no POST (nothing is applied on resume). A job
 * that already moved past approval is reported, not reopened.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportSection } from "./import-section";
import type { CatalogueEntity } from "./data-transfer-ui";

const ENTITY: CatalogueEntity = {
  key: "crm.customers",
  module: "crm",
  moduleLabel: "ارتباط با مشتری",
  label: "مشتریان",
  description: "مشتریان و پرونده‌های ارتباطی",
  locationScoped: false,
  canExport: true,
  canImport: true,
  defaultExportFields: ["name"],
  duplicateRules: [{ key: "phone", label: "تلفن", fields: ["phone"] }],
  fields: [
    {
      key: "name",
      label: "نام",
      type: "text",
      required: true,
      readOnly: false,
      exportDefault: true,
      hint: null,
      options: null,
      relation: null,
    },
  ],
};

function job(status: "ready" | "completed") {
  return {
    id: "job-1",
    entityKey: "crm.customers",
    entityLabel: "مشتریان",
    status,
    fileName: "customers.xlsx",
    fileFormat: "xlsx",
    totalRows: 12,
    validRows: 12,
    warningRows: 0,
    errorRows: 0,
    createdRows: 0,
    updatedRows: 0,
    skippedRows: 0,
    failedRows: 0,
    error: null,
    createdByName: "مالک",
    createdAt: "2026-11-20T10:00:00.000Z",
    finishedAt: null,
    sourceColumns: ["نام", "تلفن"],
    mapping: { columns: [{ field: "name", column: 0, transform: "none" }] },
    options: { duplicateStrategy: "skip", moneyUnit: "toman", validOnly: true },
  };
}

const preview = {
  totalRows: 12,
  validRows: 12,
  warningRows: 0,
  errorRows: 0,
  unmappedColumns: ["تلفن"],
  missingRequired: [],
  rows: [],
};

let fetchMock: ReturnType<typeof vi.fn>;

function install(status: "ready" | "completed") {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/data/imports/job-1" && method === "GET") {
      return new Response(JSON.stringify({ job: job(status), rows: [], total: 0 }), {
        status: 200,
      });
    }
    if (url === "/api/data/imports/job-1" && method === "PATCH") {
      return new Response(JSON.stringify({ job: job(status), preview }), { status: 200 });
    }
    if (url.startsWith("/api/data/templates")) {
      return new Response(JSON.stringify({ templates: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
}

function calledWithUrl(url: string) {
  return fetchMock.mock.calls.some(([input]) => String(input) === url);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ImportSection resume", () => {
  it("reopens a staged job and re-validates it without applying", async () => {
    install("ready");
    render(<ImportSection entities={[ENTITY]} resumeJobId="job-1" onJobQueued={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/پیش‌نویس ذخیره‌شدهٔ این ورود اطلاعات بازیابی شد/)).toBeTruthy();
    });

    expect(calledWithUrl("/api/data/imports/job-1")).toBe(true);
    // Re-validated against today's data; nothing was queued or run.
    const patch = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === "/api/data/imports/job-1" &&
        (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patch).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === "/api/data/imports/job-1" &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(false);
    // The stored mapping is shown in the mapping step.
    expect(screen.getByText("۲. نگاشت ستون‌ها")).toBeTruthy();
    // And the dry run produced the preview confirm step.
    expect(screen.getByText("۴. پیش‌نمایش و تأیید")).toBeTruthy();
  });

  it("does not reopen a job that already finished; it reports the state instead", async () => {
    install("completed");
    render(<ImportSection entities={[ENTITY]} resumeJobId="job-1" onJobQueued={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/دیگر در انتظار تأیید نیست/)).toBeTruthy();
    });
    const patch = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === "/api/data/imports/job-1" &&
        (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patch).toBeFalsy();
  });
});
