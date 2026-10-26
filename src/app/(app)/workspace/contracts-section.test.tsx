// @vitest-environment jsdom

/**
 * Issue #907 F02, UI half — a contract form must not offer, or send, a status
 * the approval engine and the lifecycle commands own.
 *
 * The service refuses `pending_approval`/`active` in a create or edit payload.
 * A form that still offered them would turn every save of an active contract
 * into a 409 the person cannot act on, and a form that *sent* them would be the
 * bypass this issue exists to close. So the picker offers only the statuses an
 * ordinary edit may set, and an already-decided contract shows its state as a
 * read-only badge instead.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContractsSection, type ContractRow } from "./contracts-section";
import { EMPTY_LOOKUPS } from "./use-workspace-lookups";

afterEach(cleanup);

function contractRow(overrides: Partial<ContractRow> = {}): ContractRow {
  return {
    id: "contract-1",
    title: "پیمان نما",
    contractType: "contractor",
    projectId: null,
    projectName: null,
    partyId: null,
    partyName: null,
    valueRial: 900_000_000,
    startDate: "2026-01-01",
    endDate: "2026-08-01",
    status: "draft",
    reminderDays: 30,
    notes: "",
    approvalStatus: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as ContractRow;
}

function renderSection(contracts: ContractRow[]) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/workspace/contracts/") && init?.method === "PATCH") {
      return { ok: true, status: 200, json: async () => ({ contract: contracts[0] }) };
    }
    if (url.startsWith("/api/workspace/contracts")) {
      return { ok: true, status: 200, json: async () => ({ contracts }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <ContractsSection lookups={EMPTY_LOOKUPS} canManageContracts canRequestApproval={false} />,
  );
  return fetchMock;
}

describe("ContractDialog — workflow-owned statuses (#907 F02)", () => {
  it("offers only the statuses an ordinary edit may set", async () => {
    renderSection([contractRow()]);
    fireEvent.click(await screen.findByText("پیمان نما"));

    const select = await screen.findByLabelText("وضعیت");
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.getAttribute("value"));
    expect(options).toEqual(["draft", "expired", "terminated", "completed"]);
    expect(options).not.toContain("pending_approval");
    expect(options).not.toContain("active");
  });

  it("shows an active contract's state as a badge and sends no status", async () => {
    const fetchMock = renderSection([contractRow({ status: "active" })]);
    fireEvent.click(await screen.findByText("پیمان نما"));

    // The badge replaced the picker: there is no status control to operate.
    expect(screen.queryByLabelText("وضعیت")).toBeNull();
    await waitFor(() => expect(screen.getAllByText("جاری").length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: "ذخیره" }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([url, init]) => String(url) === "/api/workspace/contracts/contract-1" && (init as RequestInit)?.method === "PATCH",
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse(String((patch![1] as RequestInit).body)) as Record<string, unknown>;
      // No `status` key at all — the PATCH leaves the decided state alone.
      expect("status" in body).toBe(false);
    });
  });

  it("still sends a status when the contract is in a state an edit owns", async () => {
    const fetchMock = renderSection([contractRow({ status: "terminated" })]);
    fireEvent.click(await screen.findByText("پیمان نما"));

    const select = await screen.findByLabelText("وضعیت");
    fireEvent.change(select, { target: { value: "completed" } });
    fireEvent.click(screen.getByRole("button", { name: "ذخیره" }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([url, init]) => String(url) === "/api/workspace/contracts/contract-1" && (init as RequestInit)?.method === "PATCH",
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse(String((patch![1] as RequestInit).body)) as Record<string, unknown>;
      expect(body.status).toBe("completed");
    });
  });
});
