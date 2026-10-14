// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ value: "/dashboard" }));
vi.mock("next/navigation", () => ({
  usePathname: () => pathname.value,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));

import { DeploymentCapabilityGate } from "./deployment-capability-gate";

afterEach(cleanup);

describe("DeploymentCapabilityGate on a Hybrid desktop", () => {
  const renderAt = (path: string) => {
    pathname.value = path;
    return render(
      <DeploymentCapabilityGate profile="hybrid" runtimeRole="site" cloudUrl={null}>
        <p>page</p>
      </DeploymentCapabilityGate>,
    );
  };

  it("renders a till screen itself", () => {
    renderAt("/accounting/pos");
    expect(screen.getByText("page")).toBeTruthy();
  });

  it("shows every other screen from the cloud — the assistant home included", () => {
    for (const path of ["/accounting/reports", "/crm/overview", "/dashboard"]) {
      renderAt(path);
      expect(screen.queryByText("page"), path).toBeNull();
      cleanup();
    }
  });
});

describe("DeploymentCapabilityGate on the cloud", () => {
  it("never interferes", () => {
    pathname.value = "/crm/overview";
    render(
      <DeploymentCapabilityGate profile="cloud" runtimeRole="central" cloudUrl={null}>
        <p>page</p>
      </DeploymentCapabilityGate>,
    );
    expect(screen.getByText("page")).toBeTruthy();
  });
});
