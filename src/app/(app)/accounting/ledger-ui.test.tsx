// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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
