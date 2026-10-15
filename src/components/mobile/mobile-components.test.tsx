// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAdaptiveBottomNavHrefs } from "@/lib/bottom-nav";
import { NO_BROWSER_FEATURES } from "@/lib/native/capability";
import type { NativeEventName, NativeEventPayloads } from "@/lib/native/bridge-contract";
import { type NativeRuntimeSnapshot } from "@/lib/native/native-runtime";
import {
  NativeValueProvider,
  buildNativeContextValue,
  type NativeOnEvent,
  type NativeRequest,
} from "@/components/native/native-provider";
import { AppSheet } from "./app-sheet";
import { PostCallActivitySheet } from "./post-call-activity-sheet";
import { QuickCreateSheet, resolveAuthorizedQuickActions } from "./quick-create-sheet";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: pushMock,
    back: vi.fn(),
    refresh: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  pushMock.mockReset();
  vi.unstubAllGlobals();
});

const CONNECTED_TWA_SNAPSHOT: NativeRuntimeSnapshot = {
  kind: "android-twa",
  connection: "connected",
  androidPackage: "com.bizamiz.app",
  environment: "production",
  app: {
    appVersionName: "0.2.0",
    appVersionCode: 10,
    environment: "production",
    bridgeVersion: 3,
    capabilities: [
      "barcode.scan",
      "biometric",
      "notifications",
      "share",
      "media.capture",
      "crm.caller-id",
      "printer",
      "background.sync",
    ],
  },
};

describe("resolveAdaptiveBottomNavHrefs", () => {
  it("prioritizes enabled modules up to 4 primary slots and puts remaining authorized modules into moreHrefs", () => {
    const availableHrefs = [
      "/dashboard",
      "/accounting/pos",
      "/accounting/orders",
      "/crm/customers",
      "/inventory/items",
      "/accounting/reports",
      "/settings",
    ];
    const resolved = resolveAdaptiveBottomNavHrefs(null, availableHrefs, false);
    expect(resolved.primaryHrefs).toEqual([
      "/dashboard",
      "/accounting/orders",
      "/accounting/reports",
      "/accounting/pos",
    ]);
    expect(resolved.moreHrefs).toEqual([
      "/crm/customers",
      "/inventory/items",
      "/settings",
    ]);
  });

  it("honors user-stored shortcuts and never exposes unauthorized hrefs", () => {
    const availableHrefs = ["/dashboard", "/accounting/orders", "/settings"];
    const resolved = resolveAdaptiveBottomNavHrefs(
      ["/dashboard", "/crm/customers", "/settings"],
      availableHrefs,
      false,
    );
    expect(resolved.primaryHrefs).toEqual(["/dashboard", "/settings"]);
    expect(resolved.moreHrefs).toEqual(["/accounting/orders"]);
  });
});

describe("resolveAuthorizedQuickActions", () => {
  it("includes only actions permitted by the user's allowedHrefs and enabled modules", () => {
    const fullHrefs = new Set([
      "/pos",
      "/crm/customers",
      "/accounting/receipts",
      "/accounting/expenses",
      "/accounting/products",
      "/crm/activities",
      "/workspace/tasks",
    ]);
    const allActions = resolveAuthorizedQuickActions({
      allowedHrefs: fullHrefs,
      crmEnabled: true,
      inventoryEnabled: true,
    });
    expect(allActions.map((a) => a.id)).toEqual([
      "new_order",
      "new_customer",
      "record_payment",
      "record_expense",
      "scan_barcode",
      "crm_activity",
      "new_task",
    ]);

    const cashierOnly = new Set(["/pos"]);
    const restricted = resolveAuthorizedQuickActions({
      allowedHrefs: cashierOnly,
      crmEnabled: false,
      inventoryEnabled: false,
    });
    expect(restricted.map((a) => a.id)).toEqual(["new_order"]);
  });
});

describe("QuickCreateSheet API contract", () => {
  it("submits new_customer to POST /api/parties with displayName, role, and roles", async () => {
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ id: "p-1" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onOpenChange = vi.fn();

    render(
      <QuickCreateSheet
        open={true}
        onOpenChange={onOpenChange}
        allowedHrefs={new Set(["/crm/customers", "/crm/activities", "/workspace/tasks"])}
      />,
    );

    fireEvent.click(screen.getByText("افزودن مشتری جدید"));
    fireEvent.change(screen.getByPlaceholderText("مثلاً علی رضایی"), {
      target: { value: "سارا احمدی" },
    });
    fireEvent.change(screen.getByPlaceholderText("09123456789"), {
      target: { value: "09123334455" },
    });
    fireEvent.click(screen.getByText("ثبت مشتری"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/parties");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      displayName: "سارا احمدی",
      role: "Customer",
      roles: ["Customer"],
      phone: "09123334455",
    });
  });

  it("submits crm_activity and new_task to POST /api/crm/activities with subject and body", async () => {
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ id: "act-1" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <QuickCreateSheet
        open={true}
        onOpenChange={vi.fn()}
        allowedHrefs={new Set(["/crm/activities", "/workspace/tasks"])}
      />,
    );

    fireEvent.click(screen.getByText("ثبت تماس یا پیگیری CRM"));
    fireEvent.change(screen.getByLabelText("موضوع"), {
      target: { value: "پیگیری پیش‌فاکتور" },
    });
    fireEvent.change(screen.getByLabelText("توضیحات (اختیاری)"), {
      target: { value: "ارسال نمونه قیمت در واتساپ" },
    });
    fireEvent.click(screen.getByText("ذخیره"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [actUrl, actInit] = fetchMock.mock.calls[0]!;
    expect(actUrl).toBe("/api/crm/activities");
    expect(JSON.parse(actInit?.body as string)).toEqual({
      kind: "call",
      subject: "پیگیری پیش‌فاکتور",
      body: "ارسال نمونه قیمت در واتساپ",
      completed: false,
    });

    rerender(
      <QuickCreateSheet
        open={true}
        onOpenChange={vi.fn()}
        allowedHrefs={new Set(["/crm/activities", "/workspace/tasks"])}
      />,
    );
    fireEvent.click(screen.getByText("ایجاد وظیفه یا یادآور"));
    fireEvent.change(screen.getByLabelText("موضوع"), {
      target: { value: "ارسال قرارداد نهایی" },
    });
    fireEvent.click(screen.getByText("ذخیره"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [taskUrl, taskInit] = fetchMock.mock.calls[1]!;
    expect(taskUrl).toBe("/api/crm/activities");
    expect(JSON.parse(taskInit?.body as string)).toEqual({
      kind: "task",
      subject: "ارسال قرارداد نهایی",
      body: "",
      completed: false,
    });
  });
});

describe("PostCallActivitySheet API contract", () => {
  it("opens on crm.callEnded and submits valid subject/body/customerId payload to POST /api/crm/activities", async () => {
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ id: "call-1" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    let callEndedListener: ((payload: NativeEventPayloads["crm.callEnded"]) => void) | null = null;
    const onEvent: NativeOnEvent = (name: NativeEventName, listener: (payload: never) => void) => {
      if (name === "crm.callEnded") {
        callEndedListener = listener as unknown as (payload: NativeEventPayloads["crm.callEnded"]) => void;
      }
      return () => {};
    };
    const request = vi.fn() as unknown as NativeRequest;
    const ctxValue = {
      ...buildNativeContextValue(CONNECTED_TWA_SNAPSHOT, NO_BROWSER_FEATURES, request),
      onEvent,
    };

    render(
      <NativeValueProvider value={ctxValue}>
        <PostCallActivitySheet />
      </NativeValueProvider>,
    );

    expect(callEndedListener).not.toBeNull();
    act(() => {
      callEndedListener!({
        phoneNormalized: "+989121112233",
        direction: "incoming",
        durationSeconds: 95,
        customerId: "11111111-2222-4333-8444-555555555555",
        customerName: "رضا محمدی",
        endedAt: "2026-10-15T12:00:00.000Z",
      });
    });

    expect(screen.getByText("رضا محمدی")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("یادداشت تماس"), {
      target: { value: "هماهنگی ارسال سفارش فردا صبح" },
    });
    fireEvent.change(screen.getByLabelText("مسئول پیگیری (اختیاری)"), {
      target: { value: "واحد فروش" },
    });
    fireEvent.click(screen.getByText("ثبت در فعالیت‌های CRM"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/crm/activities");
    const parsed = JSON.parse(init?.body as string);
    expect(parsed).toEqual({
      kind: "call",
      subject: "تماس ورودی — رضا محمدی (پاسخ داده شد)",
      body: "نتیجه تماس: پاسخ داده شد\nشماره: +989121112233\nمدت مکالمه: 1 دقیقه و 35 ثانیه\nیادداشت: هماهنگی ارسال سفارش فردا صبح",
      customerId: "11111111-2222-4333-8444-555555555555",
      completed: true,
      assignedTo: "واحد فروش",
    });
  });
});

describe("AppSheet", () => {
  it("renders title, children, and closes on close button click", () => {
    const onOpenChange = vi.fn();
    render(
      <AppSheet open={true} onOpenChange={onOpenChange} title="سایر بخش‌ها" description="توضیح شیت">
        <div>محتوای شیت</div>
      </AppSheet>,
    );
    expect(screen.getByText("سایر بخش‌ها")).toBeTruthy();
    expect(screen.getByText("محتوای شیت")).toBeTruthy();
    fireEvent.click(screen.getByText("بستن"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
