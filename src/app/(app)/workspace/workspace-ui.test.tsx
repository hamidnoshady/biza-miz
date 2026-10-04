// @vitest-environment jsdom

/**
 * The shared form dialog (#761 §24): a labelled modal that closes on Escape
 * and on its close button, and never on a stray click outside a half-filled form.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFormDialog } from "./workspace-ui";

afterEach(cleanup);

describe("WorkspaceFormDialog", () => {
  it("is a labelled dialog that closes on Escape and the close button only", () => {
    const onClose = vi.fn();
    render(
      <WorkspaceFormDialog title="قرارداد جدید" onClose={onClose}>
        <input aria-label="عنوان" />
      </WorkspaceFormDialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "قرارداد جدید" });
    expect(dialog).toBeTruthy();

    fireEvent.pointerDown(document.body);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "بستن" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
