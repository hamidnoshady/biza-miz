// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BugReportProvider, useBugReport } from "./bug-report-provider";

vi.mock("./use-shake", () => ({
  useShakeDetection: () => ({ requestPermission: vi.fn() }),
}));

vi.mock("./bug-report-dialog", () => ({
  BugReportDialog: ({ open }: { open: boolean }) => <div data-testid="bug-report-dialog" data-open={String(open)} />,
}));

function OpenReportButton() {
  const { openReport } = useBugReport();
  return <button onClick={openReport}>Report a bug</button>;
}

afterEach(cleanup);

describe("BugReportProvider", () => {
  it("loads the report dialog only after a report is requested", async () => {
    render(
      <BugReportProvider>
        <OpenReportButton />
      </BugReportProvider>,
    );

    expect(screen.queryByTestId("bug-report-dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Report a bug" }));
    await waitFor(() => expect(screen.getByTestId("bug-report-dialog").getAttribute("data-open")).toBe("true"));
  });
});
