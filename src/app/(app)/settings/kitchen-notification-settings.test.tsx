// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KitchenNotificationSettings } from "./kitchen-notification-settings";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

/** The settings screen may only unlock audio from a gesture on a capable browser. */
function installAudioContext(stateAtStart: AudioContextState, resumeTo: AudioContextState) {
  class FakeAudioContext {
    state = stateAtStart;
    currentTime = 0;
    destination = {};
    resume = vi.fn(async () => {
      this.state = resumeTo;
    });
    close = vi.fn(async () => {
      this.state = "closed";
    });
    createOscillator() {
      return {
        type: "sine",
        frequency: { value: 0 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
    }
    createGain() {
      return { gain: { value: 0 }, connect: vi.fn() };
    }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
}

let alertsGet: { ok: boolean; data: unknown };

beforeEach(() => {
  localStorage.clear();
  installAudioContext("running", "running");
  alertsGet = {
    ok: true,
    data: { thresholds: { overdueMinutes: 10, approachingMinutes: null }, canEdit: true },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/kitchen/alerts")) {
        if (init?.method === "PUT") {
          return json({ thresholds: JSON.parse(String(init.body)).thresholds, canEdit: true });
        }
        return json(alertsGet.data, alertsGet.ok ? 200 : 403);
      }
      throw new Error(`unexpected ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("kitchen section of the notifications settings", () => {
  it("edits the device sound matrix and persists it to the shared store", async () => {
    render(<KitchenNotificationSettings />);

    // Sound is opt-in: the master switch starts off, the matrix is disabled.
    const master = await screen.findByRole("button", { name: "روشن کردن صدا" });
    expect(master.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(master);
    await waitFor(() => expect(localStorage.getItem("kds.sound-alerts")).toBe("true"));
    expect(screen.getByRole("button", { name: "خاموش کردن صدا" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    // Every event of the matrix is present and toggles its own flag only.
    fireEvent.click(screen.getByLabelText("سفارش تازه"));
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem("kds.sound-preferences")!).events.newTicket,
      ).toBe(false),
    );
    expect(
      JSON.parse(localStorage.getItem("kds.sound-preferences")!).events.aging,
    ).toBe(true);
  });

  it("saves the branch aging thresholds and honours canEdit", async () => {
    render(<KitchenNotificationSettings />);
    await screen.findByLabelText("آستانهٔ تأخیر (دقیقه)");

    fireEvent.change(screen.getByLabelText("آستانهٔ تأخیر (دقیقه)"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("آستانهٔ نزدیک‌شدن (دقیقه؛ خالی = خاموش)"), {
      target: { value: "12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "ذخیرهٔ آستانه‌ها" }));

    await waitFor(() => expect(screen.getByText("آستانه‌های این شعبه ذخیره شد.")).not.toBeNull());
    const put = vi.mocked(fetch).mock.calls.find(
      ([url, init]) => String(url).includes("/api/kitchen/alerts") && init?.method === "PUT",
    );
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      thresholds: { overdueMinutes: 20, approachingMinutes: 12 },
    });
  });

  it("shows the thresholds read-only to a member who cannot edit them", async () => {
    alertsGet = {
      ok: true,
      data: { thresholds: { overdueMinutes: 15, approachingMinutes: 5 }, canEdit: false },
    };
    render(<KitchenNotificationSettings />);

    await waitFor(() =>
      expect(document.body.textContent).toContain("آستانهٔ تأخیر این شعبه: ۱۵ دقیقه"),
    );
    expect(screen.queryByLabelText("آستانهٔ تأخیر (دقیقه)")).toBeNull();
    expect(document.body.textContent).toContain("برای تغییر، از مدیر یا مالک بخواهید.");
  });

  it("draws nothing when the kitchen API refuses the member", async () => {
    alertsGet = { ok: false, data: { error: "forbidden" } };
    const { container } = render(<KitchenNotificationSettings />);
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});
