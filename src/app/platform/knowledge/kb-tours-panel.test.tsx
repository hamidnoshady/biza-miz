// @vitest-environment jsdom
/**
 * Issue #972 — the Tour Studio tab, mounted.
 *
 * `tour-studio.test.ts` pins the rules and the route tests pin the wire format;
 * this one holds what only a mounted panel shows: that a page's coverage
 * sentence follows the derived catalogue (authored tour / code tour / baseline),
 * that a new tour starts from the page it belongs to with a sane default key,
 * that saving sends the revision the editor opened (so a second session cannot
 * silently win), and that the revision list is honest about which version
 * members are actually playing.
 *
 * Only `api` and `useCan` are mocked; everything else — the pickers built from
 * `PERMISSIONS`, `INDUSTRIES` and `TOUR_ANCHORS`, the ordering buttons, the
 * status label — is the real component.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tourCoverage } from "@/lib/tour-coverage";
import { STUDIO_ERROR_TEXT, type StudioTour } from "@/lib/tour-studio";
import { api, useCan } from "../ui";
import { ToursPanel } from "./kb-tours-panel";

vi.mock("../ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui")>();
  return { ...actual, api: vi.fn(), useCan: vi.fn() };
});

const apiMock = vi.mocked(api);
const useCanMock = vi.mocked(useCan);

const COVERAGE = tourCoverage();
const BASELINE_PAGE = COVERAGE.pages.find((row) => row.kind === "baseline")!;
const ADVANCED_PAGE = COVERAGE.pages.find((row) => row.kind === "advanced")!;

type Reply = { ok: boolean; status: number; data: unknown; aborted: boolean };
const reply = (data: unknown, ok = true, status = 200): Reply => ({ ok, status, data, aborted: false });

let tours: StudioTour[];

function tour(overrides: Partial<StudioTour> = {}): StudioTour {
  return {
    id: "tour-1",
    tourKey: "studio.crm.audit",
    pageKey: BASELINE_PAGE.pageKey,
    route: BASELINE_PAGE.route,
    title: "تور دست‌نویس",
    description: "",
    eligibility: {},
    steps: [
      { id: "intro", kind: "explain", title: "شروع", body: "." },
      { id: "header", kind: "spotlight", anchor: "page.header", title: "سرصفحه", body: "." },
    ],
    status: "published",
    version: 3,
    publishedVersion: 3,
    updatedBy: "admin-1",
    updatedAt: "2026-11-01T00:00:00Z",
    publishedAt: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

/** A minimal router: the panel only uses these five requests. */
function routeApi() {
  apiMock.mockImplementation(async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    if (path === "/api/platform/knowledge/tours" && method === "GET") {
      return reply({ tours }) as never;
    }
    if (path === "/api/platform/knowledge/tours" && method === "POST") {
      const saved = tour({ title: "ذخیره‌شده" });
      tours = [saved];
      return reply({ ok: true, id: saved.id }) as never;
    }
    if (path.endsWith("/revisions")) return reply({ revisions: [] }) as never;
    if (path.startsWith("/api/platform/knowledge/tours/") && method === "GET") {
      return reply({ tour: tours[0], revisions: [] }) as never;
    }
    if (path.startsWith("/api/platform/knowledge/tours/") && method === "POST") {
      return reply({ ok: true, tour: tours[0] }) as never;
    }
    return reply({}) as never;
  });
}

function setPermissions(manage: boolean) {
  useCanMock.mockReturnValue((() => manage) as ReturnType<typeof useCan>);
}

async function renderPanel() {
  const utils = render(<ToursPanel />);
  await waitFor(() => expect(apiMock).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText("صفحه‌های کارگاه")).not.toBeNull());
  return utils;
}

function pagePicker(): HTMLSelectElement {
  return screen.getAllByRole("combobox")[0] as HTMLSelectElement;
}

beforeEach(() => {
  tours = [];
  setPermissions(true);
  routeApi();
});

afterEach(() => {
  cleanup();
  apiMock.mockReset();
  useCanMock.mockReset();
});

describe("Tour Studio — what the console shows", () => {
  it("derives a page's coverage sentence from the catalogue, not from a stored flag", async () => {
    await renderPanel();
    fireEvent.change(pagePicker(), { target: { value: BASELINE_PAGE.pageKey } });
    expect(
      screen.getByText("این صفحه فعلاً فقط «معرفی خودکار» دارد؛ تور شما جای آن را می‌گیرد."),
    ).toBeTruthy();

    fireEvent.change(pagePicker(), { target: { value: ADVANCED_PAGE.pageKey } });
    expect(
      screen.getByText(
        "این صفحه تور کدنویسی‌شده دارد؛ هر توری که اینجا منتشر کنید با همان شناسه جای آن می‌نشیند.",
      ),
    ).toBeTruthy();
  });

  it("opens a new tour on the selected page with a dotted key derived from its route", async () => {
    await renderPanel();
    fireEvent.change(pagePicker(), { target: { value: BASELINE_PAGE.pageKey } });
    fireEvent.click(screen.getByRole("button", { name: /تور تازه برای این صفحه/ }));

    const keyInput = screen.getByPlaceholderText("studio.accounting.orders") as HTMLInputElement;
    expect(keyInput.value).toBe(
      `studio.${BASELINE_PAGE.route.replace(/^\//, "").replace(/\//g, ".")}`,
    );
    expect(keyInput.getAttribute("dir")).toBe("ltr");

    // The default key is only a starting point: it is never saved unedited by accident
    // because the form stays a draft until «ذخیرهٔ پیش‌نویس» is pressed.
    expect(apiMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("keeps the panel readable but inert without knowledge.manage", async () => {
    setPermissions(false);
    await renderPanel();
    expect(screen.getByPlaceholderText("studio.accounting.orders")).toHaveProperty("disabled", true);
    expect(
      (screen.getByRole("button", { name: /تور تازه برای این صفحه/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: /ذخیرهٔ پیش‌نویس/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/تغییر در اختیار مهندس و مدیر ارشد است/)).toBeTruthy();
  });

  it("offers only registered anchors as spotlight targets", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /هایلایت/ }));
    const anchorSelect = screen.getByLabelText("لنگر") as HTMLSelectElement;
    expect(anchorSelect.options.length).toBeGreaterThan(0);
    for (const option of Array.from(anchorSelect.options)) {
      expect(option.value).not.toContain("#");
      expect(option.value).not.toContain("[");
    }
  });
});

describe("Tour Studio — saving and publishing", () => {
  it("sends the whole draft, without a version, the first time", async () => {
    await renderPanel();
    fireEvent.change(pagePicker(), { target: { value: BASELINE_PAGE.pageKey } });
    fireEvent.click(screen.getByRole("button", { name: /تور تازه برای این صفحه/ }));
    fireEvent.change(screen.getByPlaceholderText("studio.accounting.orders"), {
      target: { value: "studio.mine" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^توضیح$/ }));
    fireEvent.click(screen.getByRole("button", { name: /ذخیرهٔ پیش‌نویس/ }));

    await waitFor(() =>
      expect(screen.getByText("پیش‌نویس ذخیره شد.")).toBeTruthy(),
    );
    const posted = apiMock.mock.calls.find(([, init]) => init?.method === "POST");
    const body = JSON.parse(posted![1]!.body as string);
    expect(body).toMatchObject({ tourKey: "studio.mine", pageKey: BASELINE_PAGE.pageKey });
    expect(body.expectedVersion).toBeUndefined();
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0]).toMatchObject({ kind: "explain" });
    expect(body.steps[0].anchor).toBeUndefined();
  });

  it("answers a collision with this feature's Persian sentence, not the raw code", async () => {
    tours = [tour()];
    await renderPanel();
    apiMock.mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (init.method === "POST") {
        return reply({ error: "version_conflict", detail: "row version 2 != expected 1" }, false, 409) as never;
      }
      if (path === "/api/platform/knowledge/tours") return reply({ tours }) as never;
      return reply({ tour: tours[0], revisions: [] }) as never;
    });

    fireEvent.change(pagePicker(), { target: { value: BASELINE_PAGE.pageKey } });
    await waitFor(() => expect(screen.queryByText("تور دست‌نویس")).not.toBeNull());
    fireEvent.click(screen.getByText("تور دست‌نویس"));
    fireEvent.click(screen.getByRole("button", { name: /ذخیرهٔ پیش‌نویس/ }));

    await waitFor(() => expect(screen.getByText(STUDIO_ERROR_TEXT.version_conflict)).toBeTruthy());
    // The diagnostic detail is available, but demoted: never in the operator sentence.
    expect(screen.queryByText(/version_conflict/)).toBeNull();
    const diagnostic = screen.getByText("row version 2 != expected 1");
    expect(diagnostic.getAttribute("dir")).toBe("ltr");
  });

  it("publishes the version the editor holds, and lists the revision it becomes", async () => {
    tours = [tour()];
    await renderPanel();
    fireEvent.change(pagePicker(), { target: { value: BASELINE_PAGE.pageKey } });
    await waitFor(() => expect(screen.queryByText("تور دست‌نویس")).not.toBeNull());
    fireEvent.click(screen.getByText("تور دست‌نویس"));
    fireEvent.click(screen.getByRole("button", { name: /انتشار/ }));

    await waitFor(() => expect(screen.getByText("منتشر شد.")).toBeTruthy());
    const posted = apiMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(posted![1]!.body as string)).toEqual({ action: "publish", version: 3 });
  });

  it("marks the live revision and refuses to roll back to it", async () => {
    tours = [tour()];
    apiMock.mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (init.method === "POST") return reply({ ok: true, tour: tours[0] }) as never;
      if (path === "/api/platform/knowledge/tours") return reply({ tours }) as never;
      return reply({
        tour: tours[0],
        revisions: [
          { version: 3, title: "نسخهٔ سوم", steps: [], createdAt: "2026-11-01T00:00:00Z", live: true },
          { version: 2, title: "نسخهٔ دوم", steps: [], createdAt: "2026-10-01T00:00:00Z", live: false },
        ],
      }) as never;
    });
    await renderPanel();
    fireEvent.change(pagePicker(), { target: { value: BASELINE_PAGE.pageKey } });
    await waitFor(() => expect(screen.queryByText("تور دست‌نویس")).not.toBeNull());
    fireEvent.click(screen.getByText("تور دست‌نویس"));

    await waitFor(() => expect(screen.getAllByText("در حال اجرا")).toHaveLength(1));
    const rollbacks = screen.getAllByRole("button", { name: /بازگردانی/ });
    expect((rollbacks[0] as HTMLButtonElement).disabled).toBe(true);
    expect((rollbacks[1] as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(rollbacks[1]);
    await waitFor(() => expect(screen.getByText("نسخه بازگردانی شد.")).toBeTruthy());
    const posted = apiMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(posted![1]!.body as string)).toEqual({ action: "rollback", toVersion: 2 });
  });
});
