// @vitest-environment jsdom
/**
 * Issue #1126 DoD #4 — the connect guide and the issuance panel, mounted.
 *
 * The static suite (`mcp-connections.test.ts`) pins the source shape; this one
 * mounts the JSX and holds the rendered behavior: LTR code blocks inside the
 * Persian guide, copy buttons that copy and confirm, dismissal dropping the
 * token from the DOM with nothing left in browser storage, placeholders (never
 * a stored token) on a fresh mount, the client-side wrong-realm verdict firing
 * with zero network, and the diagnose-then-wire success path rendering the
 * server's tool list with its scope. Only `api` (the session-authenticated
 * diagnosis) is mocked — the wire handshake goes through a stubbed `fetch`,
 * so the request shape (platform path, bearer header) is asserted for real.
 *
 * Viewport/layout itself is covered by the visual-regression suite, which
 * jsdom cannot see; what jsdom can see — the horizontal-scroll class that
 * keeps long configs usable on a phone — is asserted here.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../ui";
import { PlatformMcpConnectPanel, PlatformMcpIssuancePanel } from "./connect-panel";

vi.mock("../ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui")>();
  return { ...actual, api: vi.fn() };
});

const apiMock = vi.mocked(api);

const ENDPOINT = "https://admin.example.com/api/platform/mcp";
const SECRET = "pospmcp_testsecretvalue";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  apiMock.mockReset();
  localStorage.clear();
  sessionStorage.clear();
  Reflect.deleteProperty(window.navigator, "clipboard");
});

function mockClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("issue #1126 — connect guide rendering", () => {
  it("renders the endpoint and the config sections as LTR scrollable code", () => {
    const { container } = render(<PlatformMcpConnectPanel endpoint={ENDPOINT} endpointWarnings={[]} />);
    const pres = container.querySelectorAll('pre[dir="ltr"]');
    expect(pres.length).toBeGreaterThanOrEqual(3);
    for (const pre of pres) {
      expect(pre.className).toContain("overflow-x-auto");
    }
    expect(container.textContent).toContain(ENDPOINT);
    expect(screen.getByText("HTTP مستقیم — Claude Code و کلاینت‌های مشابه")).toBeTruthy();
    expect(screen.getByText("Claude Desktop با mcp-remote")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByLabelText("توکن برای آزمایش اتصال").getAttribute("dir")).toBe("ltr");
  });

  it("copies the endpoint to the clipboard and confirms", async () => {
    const writeText = mockClipboard();
    render(<PlatformMcpConnectPanel endpoint={ENDPOINT} endpointWarnings={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "کپی نشانی" }));
    expect(writeText).toHaveBeenCalledWith(ENDPOINT);
    expect(await screen.findByText("کپی شد ✓")).toBeTruthy();
  });

  it("falls back to a clearly-marked template when the endpoint is unknown", () => {
    const { container } = render(<PlatformMcpConnectPanel endpoint="" endpointWarnings={["unconfigured"]} />);
    expect(container.textContent).toContain("YOUR-PLATFORM-HOST");
    expect(container.textContent).toContain("pospmcp_REPLACE_WITH_YOUR_TOKEN");
    expect(screen.getByText(/نشانی سرور مشخص نیست/)).toBeTruthy();
  });
});

describe("issue #1126 — one-time issuance and dismissal", () => {
  it("drops the dismissed token from the DOM and leaves browser storage empty", () => {
    const onDismiss = vi.fn();
    const { container, unmount } = render(
      <PlatformMcpIssuancePanel token={SECRET} endpoint={ENDPOINT} onDismiss={onDismiss} />,
    );
    expect(container.textContent).toContain(SECRET);
    fireEvent.click(screen.getByRole("button", { name: "بستن" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    // Reload analog: a fresh guide mount knows nothing of the dismissed token.
    unmount();
    const fresh = render(<PlatformMcpConnectPanel endpoint={ENDPOINT} endpointWarnings={[]} />);
    expect(fresh.container.textContent).not.toContain(SECRET);
    expect(fresh.container.textContent).toContain("pospmcp_REPLACE_WITH_YOUR_TOKEN");
  });
});

describe("issue #1126 — test-connection behavior", () => {
  function probeWith(value: string) {
    fireEvent.change(screen.getByLabelText("توکن برای آزمایش اتصال"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "آزمایش اتصال" }));
  }

  it("decides wrong_realm locally with zero network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<PlatformMcpConnectPanel endpoint={ENDPOINT} endpointWarnings={[]} />);
    probeWith("posmcp_abc");
    expect(await screen.findByText(/نه توکن سکو/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("runs diagnose-then-wire and renders the server tool list with its scope", async () => {
    apiMock.mockResolvedValue({
      ok: true,
      status: 200,
      aborted: false,
      data: {
        ok: true,
        status: "valid",
        connection: {
          id: "conn-1",
          name: "توکن عملیات",
          adminName: "سرپرست",
          adminRole: "owner",
          capabilities: ["businesses.read"],
          effectiveCapabilities: ["businesses.read"],
          capabilitiesReduced: false,
          expiresAt: null,
          businessScope: { mode: "all" },
        },
        warnings: [],
      },
    });
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-06-18", serverInfo: { name: "biza-miz-superadmin", version: "1" } }
          : { tools: [{ name: "list_businesses", description: "List businesses" }] };
      return { status: 200, ok: true, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PlatformMcpConnectPanel endpoint={ENDPOINT} endpointWarnings={[]} />);
    probeWith("pospmcp_validtoken");
    expect(await screen.findByText(/اتصال موفق/)).toBeTruthy();
    // Diagnose first, then exactly initialize + tools/list.
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The wire calls hit the platform path and carry the pasted token as a bearer.
    const calls = fetchMock.mock.calls as [unknown, { headers: Record<string, string> }][];
    for (const [url, init] of calls) {
      expect(url).toBe("/api/platform/mcp");
      expect(init.headers.Authorization).toBe("Bearer pospmcp_validtoken");
    }
    // Scope reporting: the tool the server listed, the connection, the domain.
    expect(screen.getByText("list_businesses")).toBeTruthy();
    expect(screen.getByText("توکن عملیات")).toBeTruthy();
    const successBox = screen.getByText(/اتصال موفق/).closest("div");
    expect(successBox?.textContent).toContain("کل سکو");
  });
});
