import { describe, it, expect } from "vitest";
import { explicitlyRequestedPageNavigation } from "./ai-navigation-intent";

describe("navigation intent requires an explicit request", () => {
  it.each([
    "Open the expense page",
    "Go to CRM",
    "Navigate to accounting",
    "Take me to inventory",
    "صفحه هزینه‌ها رو باز کن",
    "برو به حسابداری",
    "وارد بخش مشتریان شو",
  ])("allows an explicit imperative: %s", (input) => {
    expect(explicitlyRequestedPageNavigation(input)).toBe(true);
  });
  it.each([
    "Where is the expense page?",
    "How do I enter expenses?",
    "Which menu has CRM?",
    "صفحه هزینه‌ها کجاست؟",
    "چطوری وارد حسابداری بشم؟",
    "راهنمای ثبت هزینه",
    "", null,
  ])("never navigates based on an informational query: %s", (input) => {
    expect(explicitlyRequestedPageNavigation(input)).toBe(false);
  });
});
