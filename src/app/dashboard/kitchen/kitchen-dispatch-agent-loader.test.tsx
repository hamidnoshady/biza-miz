// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KitchenDispatchAgentLoader } from "./kitchen-dispatch-agent-loader";

vi.mock("./kitchen-dispatch-agent", () => ({
  KitchenDispatchAgent: ({ enabled }: { enabled: boolean }) => (
    <div data-testid="dispatch-agent" data-enabled={String(enabled)} />
  ),
}));

afterEach(cleanup);

describe("KitchenDispatchAgentLoader", () => {
  it("keeps the worker unmounted for members without printer authority", () => {
    render(<KitchenDispatchAgentLoader enabled={false} />);
    expect(screen.queryByTestId("dispatch-agent")).toBeNull();
  });

  it("loads the printer worker only for an authorized station", async () => {
    render(<KitchenDispatchAgentLoader enabled />);
    await waitFor(() => expect(screen.getByTestId("dispatch-agent").getAttribute("data-enabled")).toBe("true"));
  });
});
