// @vitest-environment jsdom

/**
 * The shared ledger overlay is what every hand-rolled accounting panel renders.
 * These pin its keyboard contract: Escape closes it (and only the busy guard
 * may stop that), focus moves in on open and returns to the opener on close,
 * and Tab cannot leave a modal panel.
 */
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayDialog } from "./ledger-ui";

afterEach(() => cleanup());

function Harness({
  dismissible = true,
  onClose,
  autoFocusField = false,
}: {
  dismissible?: boolean;
  onClose: () => void;
  autoFocusField?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        باز کردن
      </button>
      {open ? (
        <OverlayDialog
          headingId="harness-heading"
          dismissible={dismissible}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        >
          <h2 id="harness-heading">پنل آزمایشی</h2>
          {autoFocusField ? <input aria-label="مبلغ" autoFocus /> : null}
          <button type="button">اول</button>
          <button type="button">آخر</button>
        </OverlayDialog>
      ) : null}
    </>
  );
}

describe("the ledger overlay's keyboard contract", () => {
  it("closes on Escape", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "باز کردن" }));
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on Escape while it is not dismissible (a submit in flight)", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness onClose={onClose} dismissible={false} />);
    await user.click(screen.getByRole("button", { name: "باز کردن" }));
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("moves focus into the panel when it opens", async () => {
    const user = userEvent.setup();
    render(<Harness onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "باز کردن" }));
    const dialog = await screen.findByRole("dialog");

    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("leaves focus on a field that asked for it, rather than taking it back", async () => {
    const user = userEvent.setup();
    render(<Harness onClose={vi.fn()} autoFocusField />);
    await user.click(screen.getByRole("button", { name: "باز کردن" }));
    await screen.findByRole("dialog");

    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "مبلغ" }));
  });

  it("returns focus to the control that opened it when it closes", async () => {
    const user = userEvent.setup();
    render(<Harness onClose={vi.fn()} />);
    const opener = screen.getByRole("button", { name: "باز کردن" });
    opener.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("keeps Tab and Shift+Tab inside the panel, wrapping at either end", async () => {
    const user = userEvent.setup();
    render(<Harness onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "باز کردن" }));
    const dialog = await screen.findByRole("dialog");
    const last = screen.getByRole("button", { name: "آخر" });
    const first = screen.getByRole("button", { name: "اول" });

    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(first);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes on a backdrop click but not a click inside the panel", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "باز کردن" }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
