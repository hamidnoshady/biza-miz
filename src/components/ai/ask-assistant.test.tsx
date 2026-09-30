// src/components/ai/ask-assistant.test.tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AskAssistant, AssistantLinkProvider } from "./ask-assistant";

afterEach(cleanup);

describe("AskAssistant", () => {
  it("renders nothing outside a shell that says the assistant is on", () => {
    const { container } = render(<AskAssistant context="گزارش فروش" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when the business's AI is switched off", () => {
    const { container } = render(
      <AssistantLinkProvider enabled={false}>
        <AskAssistant context="گزارش فروش" />
      </AssistantLinkProvider>,
    );
    expect(container.innerHTML).toBe("");
  });

  it("links to the chat home with the page's context when AI is on", () => {
    render(
      <AssistantLinkProvider enabled>
        <AskAssistant context="گزارش فروش" app="growth" />
      </AssistantLinkProvider>,
    );
    const link = screen.getByRole("link", { name: /از دستیار بپرس/ });
    expect(link.getAttribute("href")).toBe(`/dashboard?${new URLSearchParams({ ctx: "گزارش فروش", app: "growth" })}`);
  });
});
