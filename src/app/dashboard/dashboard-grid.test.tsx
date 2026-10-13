// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DashboardGrid } from "./dashboard-grid";

vi.mock("react-grid-layout", async () => {
  const React = await import("react");
  return {
    useContainerWidth: () => ({ width: 1000, containerRef: React.useRef<HTMLDivElement>(null), mounted: true }),
    GridLayout: ({ children, onDragStop, dragConfig }: {
      children: ReactNode;
      dragConfig?: { enabled: boolean };
      onDragStop?: (layout: { i: string; x: number; y: number; w: number; h: number }[]) => void;
    }) => {
      const [moves, setMoves] = React.useState(0);
      return (
        <div>
          {children}
          {dragConfig?.enabled ? (
            <button
              type="button"
              onClick={() => {
                const x = moves === 0 ? 4 : 6;
                setMoves((value) => value + 1);
                onDragStop?.([{ i: "widget-1", x, y: 0, w: 4, h: 3 }]);
              }}
            >
              شبیه‌سازی جابه‌جایی
            </button>
          ) : null}
        </div>
      );
    },
  };
});

vi.mock("@/components/money/money-context", () => ({
  useMoney: () => ({ format: (value: number) => `${value.toLocaleString("en-US")} ریال` }),
}));

const ROLE_REVISION = "11111111-1111-4111-8111-111111111111";
const PERSONAL_REVISION_2 = "22222222-2222-4222-8222-222222222222";
const PERSONAL_REVISION_3 = "33333333-3333-4333-8333-333333333333";
const ROLE_REVISION_2 = "44444444-4444-4444-8444-444444444444";
const REPORT_ID = "123e4567-e89b-42d3-a456-426614174000";

const WIDGET = {
  id: "widget-1",
  saved_report_id: REPORT_ID,
  chart_type: "bar" as const,
  title: "فروش روزانه",
  x: 0,
  y: 0,
  w: 4,
  h: 3,
  report_name: "فروش روزانه",
  report_config: {
    view: "v_sales_by_day",
    metric: "total",
    aggregation: "sum" as const,
    dimension: "day",
  },
  applicable: true,
};

const INHERITED = {
  scope: "role-default" as const,
  widgets: [WIDGET],
  precondition: {
    source: { scope: "role-default" as const, revision: ROLE_REVISION },
    target: { scope: "personal" as const, revision: null },
  },
};

const ROLE_LAYOUT = {
  scope: "role-default" as const,
  widgets: [WIDGET],
  precondition: {
    source: { scope: "role-default" as const, revision: ROLE_REVISION },
    target: { scope: "role-default" as const, revision: ROLE_REVISION },
  },
};

function stubApi() {
  const posts: Record<string, unknown>[] = [];
  let personalWriteCount = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.startsWith("/api/dashboard/widgets") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      if (body.scope === "role") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            revision: ROLE_REVISION_2,
            precondition: {
              source: { scope: "role-default", revision: ROLE_REVISION_2 },
              target: { scope: "role-default", revision: ROLE_REVISION_2 },
            },
          }),
        } as Response;
      }
      personalWriteCount += 1;
      const revision = personalWriteCount === 1 ? PERSONAL_REVISION_2 : PERSONAL_REVISION_3;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          revision,
          precondition: {
            source: { scope: "personal", revision },
            target: { scope: "personal", revision },
          },
        }),
      } as Response;
    }
    if (href.startsWith("/api/dashboard/widgets?scope=role-default")) {
      return { ok: true, status: 200, json: async () => ROLE_LAYOUT } as Response;
    }
    if (href.startsWith("/api/dashboard/widgets")) {
      return { ok: true, status: 200, json: async () => INHERITED } as Response;
    }
    if (href.startsWith("/api/reports/query")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ rows: [{ dim: "2026-08-20", value: "250000" }] }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({ error: "not_found" }) } as Response;
  }));
  return posts;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DashboardGrid revision and permission contract", () => {
  it("turns the first inherited edit into personal, then uses the returned personal revision", async () => {
    const posts = stubApi();
    render(<DashboardGrid canEdit canExplain={false} />);

    expect(await screen.findByText(/نخستین ویرایش، یک نسخهٔ شخصی می‌سازد/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ویرایش چیدمان" }));
    fireEvent.click(screen.getByRole("button", { name: "شبیه‌سازی جابه‌جایی" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      scope: "personal",
      precondition: {
        source: { scope: "role-default", revision: ROLE_REVISION },
        target: { scope: "personal", revision: null },
      },
      widgets: [{ savedReportId: REPORT_ID, x: 4 }],
    });

    fireEvent.click(screen.getByRole("button", { name: "شبیه‌سازی جابه‌جایی" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toMatchObject({
      scope: "personal",
      precondition: {
        source: { scope: "personal", revision: PERSONAL_REVISION_2 },
        target: { scope: "personal", revision: PERSONAL_REVISION_2 },
      },
      widgets: [{ savedReportId: REPORT_ID, x: 6 }],
    });
  });

  it("exposes role-default management only with its dedicated capability and writes that scope", async () => {
    const posts = stubApi();
    render(<DashboardGrid canEdit canExplain={false} canManageRoleDefaults />);

    fireEvent.click(await screen.findByRole("button", { name: "چیدمان نمایشی" }));
    fireEvent.click(screen.getByRole("option", { name: "پیش‌فرض نقش‌ها" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "نقش دریافت‌کنندهٔ پیش‌فرض" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "نقش دریافت‌کنندهٔ پیش‌فرض" }));
    fireEvent.click(screen.getByRole("option", { name: "مدیر" }));

    expect(await screen.findByText(/این پیش‌فرض فقط برای اعضای نقش/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ویرایش چیدمان" }));
    fireEvent.click(screen.getByRole("button", { name: "شبیه‌سازی جابه‌جایی" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      scope: "role",
      role: "manager",
      precondition: {
        source: { scope: "role-default", revision: ROLE_REVISION },
        target: { scope: "role-default", revision: ROLE_REVISION },
      },
    });
  });

  it("keeps inherited widgets readable but hides every layout-write control without edit permissions", async () => {
    stubApi();
    render(<DashboardGrid canEdit={false} canExplain={false} canManageRoleDefaults={false} />);
    expect(await screen.findByText("فروش روزانه")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "ویرایش چیدمان" })).toBeNull();
    expect(screen.queryByRole("button", { name: "چیدمان نمایشی" })).toBeNull();
    expect(screen.queryByRole("button", { name: "شبیه‌سازی جابه‌جایی" })).toBeNull();
  });
});
