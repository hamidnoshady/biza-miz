// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IndustryPicker } from "./industry-picker";

/**
 * The `role="radiogroup"` here promises the same keyboard contract as the
 * currency choice in business-settings.tsx and the branch colour picker in
 * branches-manager.tsx (see radio-keys.ts): one Tab stop, arrows move it.
 * This used to be a lie — every tile was independently tabbable and the
 * arrow keys did nothing. These tests pin the fix down.
 */
afterEach(() => {
  cleanup();
});

describe("IndustryPicker — keyboard navigation", () => {
  it("gives only the selected option a Tab stop, and moves both the selection and DOM focus together on ArrowDown", () => {
    const onChange = vi.fn();
    render(<IndustryPicker value="food_service" onChange={onChange} />);

    const radios = screen.getAllByRole("radio") as HTMLButtonElement[];
    const foodService = radios[0];
    const jewelry = radios[1];

    expect(foodService.getAttribute("aria-checked")).toBe("true");
    expect(foodService.tabIndex).toBe(0);
    expect(jewelry.getAttribute("aria-checked")).toBe("false");
    expect(jewelry.tabIndex).toBe(-1);

    foodService.focus();
    fireEvent.keyDown(foodService, { key: "ArrowDown" });

    expect(onChange).toHaveBeenCalledWith("jewelry");
  });

  it("wraps from the last option back to the first on ArrowDown, and back the other way on ArrowUp", () => {
    const onChange = vi.fn();
    render(<IndustryPicker value="haberdashery" onChange={onChange} />);

    const radios = screen.getAllByRole("radio") as HTMLButtonElement[];
    const haberdashery = radios[radios.length - 1];

    haberdashery.focus();
    fireEvent.keyDown(haberdashery, { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith("food_service");

    onChange.mockClear();
    const foodService = radios[0];
    foodService.focus();
    fireEvent.keyDown(foodService, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("haberdashery");
  });

  it("jumps to the first and last options on Home and End", () => {
    const onChange = vi.fn();
    render(<IndustryPicker value="wholesale" onChange={onChange} />);

    const radios = screen.getAllByRole("radio") as HTMLButtonElement[];
    const wholesale = radios.find((r) => r.getAttribute("aria-checked") === "true")!;

    wholesale.focus();
    fireEvent.keyDown(wholesale, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("food_service");

    onChange.mockClear();
    fireEvent.keyDown(wholesale, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("haberdashery");
  });

  it("does not respond to arrow keys when the whole group is disabled", () => {
    const onChange = vi.fn();
    render(<IndustryPicker value="food_service" onChange={onChange} disabled />);

    const radios = screen.getAllByRole("radio") as HTMLButtonElement[];
    radios.forEach((radio) => expect(radio.tabIndex).toBe(-1));

    fireEvent.keyDown(radios[0], { key: "ArrowDown" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
