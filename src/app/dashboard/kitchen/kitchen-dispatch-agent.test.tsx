// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { printKitchenTicket } from "@/lib/printing/client";
import { KitchenDispatchAgent } from "./kitchen-dispatch-agent";

vi.mock("@/lib/printing/client", () => ({ printKitchenTicket: vi.fn() }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("KitchenDispatchAgent", () => {
  it("uses the persisted item delta and acknowledges the leased dispatch", async () => {
    const job = {
      dispatchId: "dispatch-1",
      claimToken: "claim-1",
      orderId: "order-1",
      itemIds: ["line-2", "line-3"],
      requestId: "kitchen-dispatch:dispatch-1",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ jobs: [job] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(printKitchenTicket).mockResolvedValue({ ok: true });

    render(<KitchenDispatchAgent enabled />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(printKitchenTicket).toHaveBeenCalledWith(null, "order-1", {
      requestId: "kitchen-dispatch:dispatch-1",
      itemIds: ["line-2", "line-3"],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      dispatchId: "dispatch-1",
      claimToken: "claim-1",
      handedOff: true,
    });
  });

  it("does not poll on surfaces without print permission", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<KitchenDispatchAgent enabled={false} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
