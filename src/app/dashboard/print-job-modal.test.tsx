// @vitest-environment jsdom

/**
 * This dialog is the only feedback a cashier gets while a receipt or
 * kitchen ticket is being handed to a printer. Its phase transitions
 * (preparing → sending → handed_off/failed) used to be purely visual —
 * a screen-reader user tabbed into the dialog once and then heard nothing
 * as the state moved underneath them. These tests pin the live-region
 * announcements added to fix that.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import { PrintJobModal } from "./print-job-modal";
import type { PrintProgress } from "@/lib/printing/client";

const listeners = new Set<(state: PrintProgress | null) => void>();

vi.mock("@/lib/printing/client", () => ({
  subscribePrintProgress: (listener: (state: PrintProgress | null) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));

function push(state: PrintProgress | null) {
  act(() => {
    for (const listener of listeners) listener(state);
  });
}

afterEach(() => {
  cleanup();
  listeners.clear();
});

describe("PrintJobModal — progress announcements", () => {
  it("exposes the step list as a polite live region so phase changes are announced", () => {
    render(<PrintJobModal />);
    push({ phase: "preparing", title: "چاپ رسید" });

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("آماده‌سازی سند");
    expect(status.textContent).toContain("در حال انجام");
  });

  it("moves the active marker's accessible text when the phase advances", () => {
    render(<PrintJobModal />);
    push({ phase: "preparing", title: "چاپ رسید" });
    push({ phase: "sending", title: "چاپ رسید", printerName: "EPSON TM-T88" });

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("ارسال به چاپگر");
    expect(status.textContent).toContain("EPSON TM-T88");
  });

  it("announces a failure assertively via role=alert without dropping the polite region", () => {
    render(<PrintJobModal />);
    push({ phase: "failed", title: "چاپ رسید", error: "printer_offline" });

    const alert = screen.getByRole("alert");
    expect(alert.textContent?.length).toBeGreaterThan(0);
    expect(screen.getByRole("status").contains(alert)).toBe(true);
  });

  it("announces success through the same live region", () => {
    render(<PrintJobModal />);
    push({ phase: "handed_off", title: "چاپ رسید", printerName: "EPSON TM-T88" });

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("به چاپگر ارسال شد");
  });
});
