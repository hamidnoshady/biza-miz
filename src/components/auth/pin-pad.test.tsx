// @vitest-environment jsdom
/**
 * The PIN pad's keyboard path.
 *
 * The pad is shared by the login door and the lock screen, and until now the
 * only way to add a digit was to tap an on-screen key — unusable at a terminal
 * with a keyboard and no pointer. Typing must be the same entry, not a
 * different one: same four-digit minimum, same twelve-digit ceiling, same
 * submit, with the on-screen keys left working for touchscreens.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PinPad } from "./pin-pad";

afterEach(cleanup);

function renderPad(props: Partial<React.ComponentProps<typeof PinPad>> = {}) {
  const onComplete = vi.fn();
  render(<PinPad onComplete={onComplete} {...props} />);
  return { onComplete, dots: screen.getByRole("progressbar", { name: "پین وارد شده" }) };
}

/** Type keys at the page, as a physical keyboard would. */
function type(...keys: string[]) {
  for (const key of keys) fireEvent.keyDown(window, { key });
}

describe("PIN pad keyboard entry", () => {
  it("adds typed digits without touching the on-screen keys", () => {
    const { dots } = renderPad();

    type("1", "2", "3", "4");

    expect(dots.getAttribute("aria-valuenow")).toBe("4");
  });

  it("submits the typed PIN with Enter", () => {
    const { onComplete } = renderPad();

    type("1", "2", "3", "4", "Enter");

    expect(onComplete).toHaveBeenCalledWith("1234");
  });

  it("does not submit below the four-digit minimum", () => {
    const { onComplete } = renderPad();

    type("1", "2", "3", "Enter");

    expect(onComplete).not.toHaveBeenCalled();
  });

  it("accepts Persian digits from a Persian keyboard", () => {
    const { onComplete } = renderPad();

    type("۱", "۲", "۳", "۴", "Enter");

    expect(onComplete).toHaveBeenCalledWith("1234");
  });

  it("deletes the last digit with Backspace and clears with Escape", () => {
    const { dots } = renderPad();

    type("1", "2", "3", "4");
    type("Backspace");
    expect(dots.getAttribute("aria-valuenow")).toBe("3");

    type("Escape");
    expect(dots.getAttribute("aria-valuenow")).toBe("0");
  });

  it("ignores typing while a request is in flight", () => {
    const { onComplete, dots } = renderPad({ busy: true });

    type("1", "2", "3", "4", "Enter");

    expect(dots.getAttribute("aria-valuenow")).toBe("0");
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("leaves keystrokes meant for another field alone", () => {
    const { onComplete } = renderPad();

    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    for (const key of ["1", "2", "3", "4", "Enter"]) {
      fireEvent.keyDown(field, { key });
    }

    expect(onComplete).not.toHaveBeenCalled();
    field.remove();
  });

  it("keeps the on-screen keys working", () => {
    const { onComplete } = renderPad();

    for (const name of ["۱", "۲", "۳", "۴"]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }
    fireEvent.click(screen.getByRole("button", { name: "تأیید" }));

    expect(onComplete).toHaveBeenCalledWith("1234");
  });
});
