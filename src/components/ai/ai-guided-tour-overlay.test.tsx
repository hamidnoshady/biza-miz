// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AiGuidedTourOverlay } from "./ai-guided-tour-overlay";
import { AI_GUIDED_TOUR_EVENT } from "@/lib/ai-guided-tour-events";

const steps = [
  { target: "primary-navigation", title: "ناوبری کسب‌وکار", explanation: "از منو به بخش‌های مجاز بروید." },
  { target: "assistant-composer", title: "دستیار", explanation: "در این بخش پیام خود را بفرستید." },
];

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function requestTour(guideId: string) {
  window.dispatchEvent(new CustomEvent(AI_GUIDED_TOUR_EVENT, { detail: { guideId } }));
}

describe("AI guided tours", () => {
  it("shows only current-session server-authorized steps and supports next/escape", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ guide: { id: "assistant-basics", label: "آشنایی با دستیار", steps } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<>
      <div data-ai-guide="primary-navigation">Menu</div>
      <div data-ai-guide="assistant-composer">Composer</div>
      <AiGuidedTourOverlay />
    </>);
    requestTour("assistant-basics");
    expect(await screen.findByRole("dialog", { name: "آشنایی با دستیار" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/ai/guided-tour", expect.objectContaining({
      method: "POST", credentials: "same-origin",
    }));
    expect(screen.getByText("ناوبری کسب‌وکار")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /بعدی/ }));
    expect(screen.getByText("در این بخش پیام خود را بفرستید.")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("never renders a tour returned with unknown selectors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ guide: { id: "assistant-basics", label: "Injected", steps: [
        { target: "body", title: "Bad", explanation: "Unknown selector" },
      ] } }),
    }));
    render(<AiGuidedTourOverlay />);
    requestTour("assistant-basics");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("does not show unavailable or unauthorized tours", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    render(<AiGuidedTourOverlay />);
    requestTour("app-accounting");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
