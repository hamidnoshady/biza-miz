// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ value: "/dashboard" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.value }));

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

  it("lets the home page decide (it redirects to a till screen, or explains there is none)", () => {
    renderAt("/dashboard");
    expect(screen.getByText("page")).toBeTruthy();
  });

  it("renders a till screen and hands every other screen to the cloud", () => {
    renderAt("/accounting/pos");
    expect(screen.getByText("page")).toBeTruthy();
    cleanup();
    renderAt("/accounting/reports");
    expect(screen.queryByText("page")).toBeNull();
  });
});
