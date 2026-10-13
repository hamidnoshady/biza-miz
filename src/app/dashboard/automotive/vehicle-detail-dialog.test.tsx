// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VehicleDetailDialog } from "./vehicle-detail-dialog";

vi.mock("../media/media-picker", () => ({
  mediaFileUrl: (id: string) => `/api/media/${id}/file`,
  MediaPickerDialog: ({ title, onPick, onClose }: {
    title: string;
    onPick: (asset: { id: string; fileName: string }) => void;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label={title}>
      <button type="button" onClick={() => onPick({ id: "asset-picked", fileName: "front.jpg" })}>انتخاب فایل آزمایشی</button>
      <button type="button" onClick={onClose}>بستن انتخابگر</button>
    </div>
  ),
}));

const baseVehicle = {
  serialId: "vehicle-1",
  locationId: "branch-1",
  stockNumber: "AUTO-17",
  displayName: "پژو ۲۰۷ پانوراما",
  make: "پژو",
  model: "207",
  trim: "پانوراما",
  vehicleYearCalendar: "jalali" as const,
  modelYear: 1403,
  productionYear: 1402,
  vin: "WBA1A345678901234",
  chassisNumber: "IRX123456789",
  engineNumber: "ENG-17",
  plateNumber: null,
  bodyType: "hatchback",
  transmission: "automatic",
  fuelType: "petrol",
  engineSpec: "1.6L",
  drivetrain: "fwd",
  exteriorColor: "سفید",
  interiorColor: "مشکی",
  condition: "used" as const,
  mileageKm: 56_000,
  priorOwners: 1,
  registrationDate: "2025-01-10",
  inspectionNotes: null,
  bodyConditionNotes: null,
  mechanicalNotes: null,
  serviceHistory: null,
  state: "in_stock" as const,
  acquisitionDate: "2025-01-10",
  askingPriceRial: 900_000_000,
  soldOn: null,
  salePriceRial: null,
};

const defaultProps = {
  serialId: "vehicle-1",
  activeLocationId: "branch-1",
  locations: [{ id: "branch-1", name: "شعبهٔ مرکزی" }],
  canSeeCost: true,
  canEditVehicle: true,
  canEditPrice: true,
  canOverrideMinPrice: true,
  canTransferVehicle: true,
  canArchiveVehicle: true,
  canViewMedia: true,
  canManageMedia: false,
  onClose: vi.fn(),
  onChanged: vi.fn(),
};

function ok(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function stubApi(respond: (url: string, init?: RequestInit) => unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const response = respond(url, init) as ReturnType<typeof ok>;
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("vehicle detail dialog", () => {
  it("loads and saves mileage and identity facts through the tenant-scoped detail API", async () => {
    const patchBodies: Record<string, unknown>[] = [];
    const fetchMock = stubApi((url, init) => {
      if (url === "/api/automotive/vehicles/vehicle-1/media") return ok({ attachments: [] });
      if (url === "/api/automotive/vehicles/vehicle-1" && init?.method === "PATCH") {
        patchBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return ok({ ok: true, vehicle: baseVehicle });
      }
      if (url === "/api/automotive/vehicles/vehicle-1") {
        return ok({ vehicle: baseVehicle, canSeeCost: true, canSeePriceHistory: true, priceHistory: [], transfers: [] });
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    });
    const user = userEvent.setup();
    render(<VehicleDetailDialog {...defaultProps} />);

    expect(await screen.findByRole("dialog", { name: "پروندهٔ خودرو" })).not.toBeNull();
    expect(await screen.findByDisplayValue("AUTO-17")).not.toBeNull();
    await user.clear(screen.getByLabelText("VIN"));
    await user.type(screen.getByLabelText("VIN"), "1HGCM82633A004352");
    await user.clear(screen.getByLabelText("شماره شاسی"));
    await user.type(screen.getByLabelText("شماره شاسی"), "IRX987654321");
    await user.clear(screen.getByLabelText("کارکرد (کیلومتر)"));
    await user.type(screen.getByLabelText("کارکرد (کیلومتر)"), "75321");
    await user.click(screen.getByRole("button", { name: "ذخیرهٔ مشخصات" }));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toMatchObject({
      vin: "1HGCM82633A004352",
      chassisNumber: "IRX987654321",
      mileageKm: 75_321,
      priorOwners: 1,
      bodyConditionNotes: null,
    });
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes("/api/automotive/vehicles/vehicle-1") && init?.method === "PATCH")).toBe(true);
    expect(defaultProps.onChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps cost-only prices hidden and never submits them when a price editor lacks cost.view", async () => {
    const postBodies: Record<string, unknown>[] = [];
    const fetchMock = stubApi((url, init) => {
      if (url === "/api/automotive/vehicles/vehicle-1/media") return ok({ attachments: [] });
      if (url === "/api/automotive/vehicles/vehicle-1/price" && init?.method === "POST") {
        postBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return ok({ ok: true, priceHistory: [] });
      }
      if (url === "/api/automotive/vehicles/vehicle-1") {
        return ok({
          vehicle: { ...baseVehicle },
          canSeeCost: false,
          canSeePriceHistory: true,
          priceHistory: [{ id: "h1", askingPriceRial: 900_000_000, previousAskingPriceRial: 850_000_000, changedAt: "2026-02-01", changedByName: "مدیر", reason: "بازار" }],
          transfers: [],
        });
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    });
    const user = userEvent.setup();
    render(<VehicleDetailDialog {...defaultProps} canSeeCost={false} canOverrideMinPrice={false} />);

    await screen.findByDisplayValue("AUTO-17");
    await user.click(screen.getByRole("tab", { name: "قیمت و تاریخچه" }));
    expect(screen.queryByLabelText("حداقل قیمت (تومان)")).toBeNull();
    expect(screen.queryByLabelText("قیمت عمده (تومان)")).toBeNull();
    expect(screen.queryByLabelText("قیمت تبلیغاتی (تومان)")).toBeNull();
    expect(screen.queryByText("بهای تمام‌شده")).toBeNull();

    // The business shows Toman (the default unit): the field is seeded with
    // the stored Rial as Toman, and what is typed is sent back as Rial.
    expect((screen.getByLabelText("قیمت فروش (تومان)") as HTMLInputElement).value).toBe("۹۰٬۰۰۰٬۰۰۰");
    await user.clear(screen.getByLabelText("قیمت فروش (تومان)"));
    await user.type(screen.getByLabelText("قیمت فروش (تومان)"), "92000000");
    await user.click(screen.getByRole("button", { name: "ثبت قیمت و تاریخچه" }));
    await waitFor(() => expect(postBodies).toHaveLength(1));
    expect(postBodies[0]).toEqual({ askingPriceRial: 920_000_000, reason: "" });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("keeps the vehicle record usable when media loading fails, and exposes only the files returned by the scoped API", async () => {
    const fetchMock = stubApi((url) => {
      if (url === "/api/automotive/vehicles/vehicle-1/media") return ok({ error: "network_error" }, 503);
      if (url === "/api/automotive/vehicles/vehicle-1") {
        return ok({ vehicle: baseVehicle, canSeeCost: true, canSeePriceHistory: true, priceHistory: [], transfers: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<VehicleDetailDialog {...defaultProps} canViewMedia={false} />);
    expect(await screen.findByDisplayValue("AUTO-17")).not.toBeNull();
    expect(screen.getByRole("dialog", { name: "پروندهٔ خودرو" })).not.toBeNull();
    await userEvent.setup().click(screen.getByRole("tab", { name: "رسانه و مدارک" }));
    expect(await screen.findByText(/ارتباط با سرور برقرار نشد/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: /انتخاب از کتابخانهٔ رسانه/ })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/media"))).toBe(true);
  });
});
