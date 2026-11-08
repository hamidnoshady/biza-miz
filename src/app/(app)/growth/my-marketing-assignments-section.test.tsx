// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/app/dashboard/ui";
import { MyMarketingAssignmentsSection } from "./my-marketing-assignments-section";
vi.mock("@/app/dashboard/ui", async (original) => ({ ...(await original<typeof import("@/app/dashboard/ui")>()), api: vi.fn() }));
const success = (data: unknown) => ({ ok: true, status: 200, data, aborted: false }) as never;
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("my assignments", () => {
  it("shows only self-service actions and refreshes after a status change", async () => {
    vi.mocked(api).mockImplementation(async (_url, init) => init?.method === "PATCH" ? success({ ok: true }) : success({ assignments: [{ id: "work", title: "Own work", target: "Site", location_name: "Main", status: "planned", due_date: null }], hasMore: false }));
    const user = userEvent.setup(); render(<MyMarketingAssignmentsSection />);
    expect(await screen.findByText("Own work")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "لغو" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "شروع" }));
    await waitFor(() => expect(vi.mocked(api).mock.calls.some(([url, init]) => url === "/api/growth/my-marketing-assignments/work" && init?.method === "PATCH")).toBe(true));
    const write = vi.mocked(api).mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(write[1]!.body as string)).toEqual({ expected: "planned", next: "in_progress" });
  });
});
