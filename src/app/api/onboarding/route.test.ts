/**
 * ESH-202 / #1387 — the onboarding API's continuation guard and action switch.
 *
 * These pin the door rather than the database service: an invalid/expired
 * continuation is a 401 with no draft, a live one returns that identity's state,
 * and a person who already belongs to a business is sent to sign-in instead of
 * being offered a second business.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const readOnboardingIdentity = vi.hoisted(() => vi.fn());
const loadOnboardingState = vi.hoisted(() => vi.fn());
const saveOnboardingStep = vi.hoisted(() => vi.fn());
const submitOnboarding = vi.hoisted(() => vi.fn());
const saveOnboardingLogo = vi.hoisted(() => vi.fn());
const removeOnboardingLogo = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "onboarding-token" }) }),
}));
vi.mock("@/lib/iam/onboarding-session", () => ({
  ONBOARDING_COOKIE: "pos_onboarding",
  readOnboardingIdentity,
}));
vi.mock("@/lib/onboarding", () => ({
  loadOnboardingState,
  saveOnboardingStep,
  submitOnboarding,
  saveOnboardingLogo,
  removeOnboardingLogo,
}));

import { DELETE, GET, POST } from "./route";

const STATE = {
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
  industries: [{ key: "food_service", label: "کافه و رستوران" }],
  membershipsExist: false,
  provisioned: false,
};

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function postForm(fields: Record<string, string | File>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return POST(new Request("http://localhost/api/onboarding", { method: "POST", body: form }));
}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeEach(() => {
  readOnboardingIdentity.mockReset();
  loadOnboardingState.mockReset();
  saveOnboardingStep.mockReset();
  submitOnboarding.mockReset();
  saveOnboardingLogo.mockReset();
  removeOnboardingLogo.mockReset();
});

describe("the onboarding state API", () => {
  it("refuses an invalid or expired continuation without reading a draft", async () => {
    readOnboardingIdentity.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: "continuation_invalid",
      next: "/login",
    });
    expect(loadOnboardingState).not.toHaveBeenCalled();
  });

  it("returns only the signed-in identity's own draft", async () => {
    readOnboardingIdentity.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    loadOnboardingState.mockResolvedValue(STATE);
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(STATE);
    expect(readOnboardingIdentity).toHaveBeenCalledWith("onboarding-token");
  });

  it("sends a person who already has a membership to sign-in", async () => {
    readOnboardingIdentity.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    loadOnboardingState.mockResolvedValue({ ...STATE, membershipsExist: true });
    const response = await GET();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "memberships_exist",
      next: "/login",
    });
  });
});

describe("the onboarding mutation API", () => {
  it("requires the continuation before accepting any action", async () => {
    readOnboardingIdentity.mockResolvedValue(null);
    const response = await post({ action: "step", step: "industry", industry: "food_service" });
    expect(response.status).toBe(401);
    expect(saveOnboardingStep).not.toHaveBeenCalled();
    expect(submitOnboarding).not.toHaveBeenCalled();
  });

  it("rejects an unknown action", async () => {
    readOnboardingIdentity.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    const response = await post({ action: "delete_everything" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_action" });
  });

  it("saves a step and maps the step-specific status", async () => {
    readOnboardingIdentity.mockResolvedValue("11111111-1111-4111-8111-111111111111");

    saveOnboardingStep.mockResolvedValue({ ok: true, draft: STATE.draft });
    const saved = await post({ action: "step", step: "industry", industry: "food_service" });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({ ok: true, draft: STATE.draft });

    saveOnboardingStep.mockResolvedValue({ ok: false, error: "email_taken" });
    const failed = await post({ action: "step", step: "profile", email: "taken@example.invalid" });
    expect(failed.status).toBe(409);
  });

  it("rejects a step without a step name", async () => {
    readOnboardingIdentity.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    const response = await post({ action: "step" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_step" });
  });

  it("requires the continuation before provisioning", async () => {
    readOnboardingIdentity.mockResolvedValue(null);
    const response = await post({ action: "submit" });
    expect(response.status).toBe(401);
    expect(submitOnboarding).not.toHaveBeenCalled();
  });

  it("maps a missing required field to 400 without opening a tenant session", async () => {
    readOnboardingIdentity.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    submitOnboarding.mockResolvedValue({ ok: false, error: "missing_business_name" });

    const response = await post({ action: "submit" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "missing_business_name" });
  });

  it("sends an existing membership to sign-in instead of a second business", async () => {
    readOnboardingIdentity.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    submitOnboarding.mockResolvedValue({ ok: false, error: "memberships_exist" });

    const response = await post({ action: "submit" });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "memberships_exist",
      next: "/login",
    });
  });

  it("passes the email delivery outcome through the step response", async () => {
    readOnboardingIdentity.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    saveOnboardingStep.mockResolvedValue({
      ok: true,
      draft: STATE.draft,
      emailVerification: "sent",
    });

    const response = await post({ action: "step", step: "profile", email: "a@example.invalid" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      emailVerification: "sent",
    });
  });

  it("requires the explicit logo action and validates the uploaded file", async () => {
    readOnboardingIdentity.mockResolvedValue("11111111-1111-4111-8111-111111111111");

    const noAction = await postForm({
      file: new File([PNG_SIGNATURE], "logo.png", { type: "image/png" }),
    });
    expect(noAction.status).toBe(400);
    await expect(noAction.json()).resolves.toEqual({ error: "invalid_action" });

    const wrongType = await postForm({
      action: "logo",
      file: new File([PNG_SIGNATURE], "logo.txt", { type: "text/plain" }),
    });
    expect(wrongType.status).toBe(400);
    await expect(wrongType.json()).resolves.toEqual({ error: "invalid_logo" });
    expect(saveOnboardingLogo).not.toHaveBeenCalled();

    saveOnboardingLogo.mockResolvedValue(STATE.draft);
    const valid = await postForm({
      action: "logo",
      file: new File([PNG_SIGNATURE], "logo.png", { type: "image/png" }),
    });
    expect(valid.status).toBe(201);
    await expect(valid.json()).resolves.toMatchObject({ ok: true, draft: STATE.draft });
    expect(saveOnboardingLogo).toHaveBeenCalledTimes(1);
    const [platformUserId, logo] = saveOnboardingLogo.mock.calls[0] as [
      string,
      { mimeType: string; dataUrl: string },
    ];
    expect(platformUserId).toBe("11111111-1111-4111-8111-111111111111");
    expect(logo.mimeType).toBe("image/png");
    expect(logo.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("removes the draft logo only for a live continuation", async () => {
    readOnboardingIdentity.mockResolvedValue(null);
    expect((await DELETE()).status).toBe(401);
    expect(removeOnboardingLogo).not.toHaveBeenCalled();

    readOnboardingIdentity.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    removeOnboardingLogo.mockResolvedValue(STATE.draft);
    const response = await DELETE();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, draft: STATE.draft });
    expect(removeOnboardingLogo).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
  });
});
