// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { usePlatformMutation } from "./use-platform-data";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function MutationProbe() {
  const [label, setLabel] = useState("first");
  const mutation = usePlatformMutation<void, unknown>("/api/platform/test", {
    method: "POST",
    errorToast: false,
    request: () => ({
      options: { body: { label } },
    }),
  });

  return (
    <div>
      <button type="button" onClick={() => setLabel("second")}>set</button>
      <button type="button" onClick={() => void mutation.mutate()}>send</button>
    </div>
  );
}

describe("usePlatformMutation", () => {
  it("uses the latest request builder when mutate is called", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MutationProbe />);
    await act(async () => {
      screen.getByText("set").click();
    });
    await act(async () => {
      screen.getByText("send").click();
    });

    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ label: "second" });
  });
});
