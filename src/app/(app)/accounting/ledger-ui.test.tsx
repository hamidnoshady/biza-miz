// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { OverlayDialog } from "./ledger-ui";

afterEach(cleanup);
it("uses the shared Escape handler but never dismisses an in-flight mutation", () => {
  const onClose = vi.fn();
  const { rerender } = render(<OverlayDialog headingId="heading" onClose={onClose} dismissible={false}><h2 id="heading">Payment</h2></OverlayDialog>);
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.click(screen.getByRole("dialog").parentElement!);
  expect(onClose).not.toHaveBeenCalled();
  rerender(<OverlayDialog headingId="heading" onClose={onClose}><h2 id="heading">Payment</h2></OverlayDialog>);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
});


it("contains Tab/Shift+Tab and programmatic focus, then restores the opener", async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Open statement</button><button>Outside</button>
      {open ? <OverlayDialog headingId="statement" onClose={() => setOpen(false)}>
        <h2 id="statement">Statement</h2><button>First</button><button>Last</button>
      </OverlayDialog> : null}</>;
  }
  const user = userEvent.setup();
  render(<Harness />);
  const opener = screen.getByRole("button", { name: "Open statement" });
  const outside = screen.getByRole("button", { name: "Outside" });
  await user.click(opener);
  expect(screen.queryByRole("button", { name: "Outside" })).toBeNull();
  const first = screen.getByRole("button", { name: "First" });
  const last = screen.getByRole("button", { name: "Last" });
  expect(document.activeElement).toBe(first);
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(last);
  await user.tab();
  expect(document.activeElement).toBe(first);
  outside.focus();
  expect(document.activeElement).toBe(first);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

it("dismisses only the top entry, restores its trigger, then restores the statement opener", async () => {
  function Harness() {
    const [statement, setStatement] = useState(false);
    const [entry, setEntry] = useState(false);
    return <><button onClick={() => setStatement(true)}>Open statement</button>
      {statement ? <OverlayDialog headingId="statement" onClose={() => setStatement(false)}>
        <h2 id="statement">Statement</h2><button onClick={() => setEntry(true)}>Open entry</button>
        {entry ? <OverlayDialog headingId="entry" onClose={() => setEntry(false)}>
          <h2 id="entry">Entry</h2><button>Entry action</button>
        </OverlayDialog> : null}
      </OverlayDialog> : null}</>;
  }
  const user = userEvent.setup();
  render(<Harness />);
  const opener = screen.getByRole("button", { name: "Open statement" });
  await user.click(opener);
  const entryTrigger = screen.getByRole("button", { name: "Open entry" });
  await user.click(entryTrigger);
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Entry action" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Entry" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Statement" })).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(entryTrigger));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

it("focuses a loading panel with no controls and honors prevented Escape", async () => {
  const onClose = vi.fn();
  render(<OverlayDialog headingId="heading" onClose={onClose}><h2 id="heading">Loading</h2></OverlayDialog>);
  expect(document.activeElement).toBe(screen.getByRole("dialog"));
  const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
  event.preventDefault();
  window.dispatchEvent(event);
  expect(onClose).not.toHaveBeenCalled();
});

it("a busy top layer consumes Escape without closing its parent", () => {
  const parentClose = vi.fn();
  const childClose = vi.fn();
  render(<OverlayDialog headingId="parent" onClose={parentClose}>
    <h2 id="parent">Statement</h2>
    <OverlayDialog headingId="busy" onClose={childClose} dismissible={false}>
      <h2 id="busy">Saving</h2>
    </OverlayDialog>
  </OverlayDialog>);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(parentClose).not.toHaveBeenCalled();
  expect(childClose).not.toHaveBeenCalled();
});
