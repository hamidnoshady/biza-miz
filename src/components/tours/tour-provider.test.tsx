// @vitest-environment jsdom

/**
 * Issue #972 — the runtime's wire contract with `POST …/progress`: the route
 * reads the event's name from `event`, so every write the runtime sends must
 * carry it, with the step id the route requires for the two step events.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/accounting/products" }));
vi.mock("@/app/dashboard/ui", () => ({ api: (...args: unknown[]) => api(...args) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), message: vi.fn(), error: vi.fn() } }));

import { TourProvider, useTourRuntime } from "./tour-provider";

const lookup = {
  ok: true,
  status: 200,
  aborted: false,
  data: {
    tour: {
      id: "test.tour",
      version: 1,
      route: "/accounting/products",
      title: "تور",
      steps: [{ id: "welcome", kind: "explain", title: "خوش", body: "شروع" }],
    },
    progress: { status: "not_started", seenCount: 0, totalSteps: 1, percent: 0, resumeStepId: null, outdated: false },
  },
};

let runtime: ReturnType<typeof useTourRuntime> = null;
function Probe() {
  runtime = useTourRuntime();
  return null;
}

beforeEach(() => {
  api.mockReset();
  runtime = null;
});
afterEach(cleanup);

describe("TourProvider progress writes", () => {
  it("names the event in `event`, the field the route reads", async () => {
    api.mockImplementation(async (url: string) =>
      url.endsWith("/progress") ? { ok: true, status: 200, aborted: false, data: {} } : lookup,
    );
    render(
      <TourProvider>
        <Probe />
      </TourProvider>,
    );
    await act(async () => {
      await runtime!.startTour("test.tour");
    });
    const write = api.mock.calls.find(([url]) => String(url).endsWith("/progress"));
    expect(write).toBeTruthy();
    expect(JSON.parse(write![1].body)).toMatchObject({ event: "start" });
  });
});
