"use client";

/**
 * Issue #812 §3 — the AI console's section navigation.
 *
 * One file so the five sub-pages cannot drift into six different tab bars, and
 * so the console's shape is readable in one place: connection/fleet, runtime
 * modes, prompt layers, system agents, Deep Research, assistant widgets.
 *
 * The nav lives on every page rather than on a layout because the platform
 * console's other sections (billing, backup, …) each own their own SubNav and
 * a shared layout here would have to know which section it is in.
 */
import { SubNav } from "../ui";

export const AI_CONSOLE_SECTIONS = [
  { label: "اتصال و کلیدها", href: "/platform/ai", exact: true },
  { label: "حالت‌های اجرا", href: "/platform/ai/modes" },
  { label: "لایه‌های پرامپت", href: "/platform/ai/prompts" },
  { label: "ایجنت‌های سیستمی", href: "/platform/ai/agents" },
  { label: "پژوهش عمیق", href: "/platform/ai/research" },
  { label: "ویجت‌ها", href: "/platform/ai/widgets" },
];

export function AiConsoleNav() {
  return <SubNav items={AI_CONSOLE_SECTIONS} />;
}
