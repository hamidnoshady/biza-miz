// @vitest-environment jsdom
/**
 * ESH-202 / #1387 — the short onboarding wizard's contract.
 *
 * The screen must be generated from the server's canonical industry list, ask
 * for the business details only once, make the logo and personal-profile steps
 * skippable, and require an explicit confirmation before provisioning.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENABLED_INDUSTRIES, INDUSTRY_LABELS } from "@/lib/industries";
import type { OnboardingState } from "@/lib/onboarding";
import { OnboardingWizard } from "./onboarding-wizard";

const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn(), prefetch: vi.fn() }),
}));

function baseState(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    identity: {
      fullName: "نگار احمدی",
      maskedPhone: "+989***4567",
      email: null,
      emailVerified: false,
      hasNationalId: false,
    },
    draft: {
      industry: null,
      businessName: "",
      locationName: "",
      address: "",
      phone: "",
      logo: null,
      completedSteps: [],
      submitted: false,
      provisionedBusinessId: null,
    },
    industries: ENABLED_INDUSTRIES.map((key) => ({ key, label: INDUSTRY_LABELS[key] })),
    membershipsExist: false,
    provisioned: false,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  replace.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the short onboarding wizard", () => {
  it("renders every enabled industry from the canonical registry", () => {
    render(<OnboardingWizard initialState={baseState()} />);

    expect(screen.getByRole("radiogroup", { name: "نوع کسب‌وکار" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(ENABLED_INDUSTRIES.length);
    for (const industry of ENABLED_INDUSTRIES) {
      expect(document.body.textContent).toContain(INDUSTRY_LABELS[industry]);
    }
    expect(document.body.textContent).not.toMatch(/نام خانوادگی|شمارهٔ موبایل خود را/);
  });

  it("collects only the supported business basics once and marks optional fields", async () => {
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { industry?: string };
      return jsonResponse(200, {
        ok: true,
        draft: {
          ...baseState().draft,
          industry: body.industry ?? null,
          completedSteps: ["industry"],
        },
      });
    });

    render(<OnboardingWizard initialState={baseState()} />);
    fireEvent.click(screen.getByRole("radio", { name: INDUSTRY_LABELS.food_service }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ذخیره و ادامه" }));
    });

    expect(await screen.findByLabelText("نام کسب‌وکار *")).toBeTruthy();
    expect(screen.getByLabelText(/نام شعبهٔ اول/)).toBeTruthy();
    expect(screen.getByLabelText(/نشانی کسب‌وکار/)).toBeTruthy();
    expect(screen.getByLabelText(/تلفن کسب‌وکار/)).toBeTruthy();
    expect(document.body.textContent).toContain("اختیاری");
    // Signup's captured fields are never asked again on this step.
    expect(document.querySelector('input[name="firstName"]')).toBeNull();
    expect(document.querySelector('input[name="lastName"]')).toBeNull();
    expect(document.querySelector('input[type="email"]')).toBeNull();
  });

  it("lets the owner skip the logo and the optional profile, then confirm before submitting", async () => {
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { step?: string };
      const completed = ["industry", "basics", "logo", "profile"];
      return jsonResponse(200, {
        ok: true,
        draft: {
          ...baseState().draft,
          industry: "food_service",
          businessName: "کافه بهار",
          completedSteps: body.step === "logo" ? ["industry", "basics", "logo"] : completed,
        },
      });
    });

    render(
      <OnboardingWizard
        initialState={baseState({
          draft: {
            ...baseState().draft,
            industry: "food_service",
            businessName: "کافه بهار",
            completedSteps: ["industry", "basics"],
          },
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "رد کردن لوگو" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "رد کردن لوگو" }));
    });

    expect(await screen.findByLabelText(/ایمیل/)).toBeTruthy();
    expect(screen.getByLabelText(/کد ملی/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ذخیره و ادامه" }));
    });

    expect(await screen.findByRole("checkbox")).toBeTruthy();
    const submit = screen.getByRole("button", { name: "ثبت کسب‌وکار و ادامه" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.click(screen.getByRole("checkbox"));
    expect(submit.disabled).toBe(false);
    expect(document.body.textContent).toContain("هیچ برنامه‌ای فعال نمی‌شود");
    expect(document.body.textContent).not.toMatch(/کیف پول خود را شارژ کنید/);
  });

  it("keeps the entered business name and shows a recoverable error when saving fails", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(503, { error: "field_too_long" }),
    );

    render(
      <OnboardingWizard
        initialState={baseState({
          draft: {
            ...baseState().draft,
            industry: "food_service",
            completedSteps: ["industry"],
          },
        })}
      />,
    );

    const name = screen.getByLabelText("نام کسب‌وکار *") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "کافه بهار" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ذخیره و ادامه" }));
    });

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/طول یکی از فیلدها/)).toBeTruthy();
    // The step did not advance and the value the person typed is still there.
    expect((screen.getByLabelText("نام کسب‌وکار *") as HTMLInputElement).value).toBe("کافه بهار");
  });

  it("sends an expired continuation back to sign-in instead of losing the form", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { error: "continuation_invalid", next: "/login" }),
    );

    render(<OnboardingWizard initialState={baseState()} />);
    fireEvent.click(screen.getByRole("radio", { name: INDUSTRY_LABELS.food_service }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ذخیره و ادامه" }));
    });

    expect(replace).toHaveBeenCalledWith("/login");
  });

  it("redirects a provisioned draft to the existing setup wizard instead of asking again", () => {
    render(
      <OnboardingWizard
        initialState={baseState({
          provisioned: true,
          draft: {
            ...baseState().draft,
            industry: "food_service",
            businessName: "کافه بهار",
            submitted: true,
            provisionedBusinessId: "11111111-1111-4111-8111-111111111111",
          },
        })}
      />,
    );
    expect(replace).toHaveBeenCalledWith("/setup/business");
  });
});
