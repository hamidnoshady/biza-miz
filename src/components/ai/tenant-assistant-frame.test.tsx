// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TenantAssistantFrame } from "./tenant-assistant-frame";

let pathname = "/dashboard";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("@/app/dashboard/ai/ai-chat-hub", () => ({
  AiChatHub: ({ compact }: { compact?: boolean }) => <span>{compact ? "compact assistant" : "full assistant"}</span>,
}));
vi.mock("./ai-guided-tour-overlay", () => ({ AiGuidedTourOverlay: () => null }));

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(["/dashboard", "/accounting/overview"])("leaves the Hybrid guest in charge on %s", (route) => {
  pathname = route;
  render(
    <TenantAssistantFrame account="business:member" enabled hybridSite aiProps={{ canAutoApply: false }}>
      <div>cloud pane</div>
    </TenantAssistantFrame>,
  );
  expect(screen.getByText("cloud pane").parentElement?.className).toBe("contents");
  expect(screen.queryByText(/assistant/)).toBeNull();
});

it.each([
  ["/dashboard", false, "full assistant"],
  ["/accounting/overview", false, "compact assistant"],
  ["/accounting/pos", true, "compact assistant"],
] as const)("keeps the assistant on its owning route %s", (route, hybridSite, label) => {
  pathname = route;
  render(<TenantAssistantFrame account="business:member" enabled hybridSite={hybridSite} aiProps={{}}>
    <div>route content</div>
  </TenantAssistantFrame>);
  expect(screen.getByText(label)).toBeTruthy();
});
