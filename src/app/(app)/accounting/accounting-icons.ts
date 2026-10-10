/**
 * One glyph per Accounting section.
 *
 * Split out of `accounting-manager.tsx` when the app got a sidebar of its own:
 * the in-page rail and the app's main menu draw the same sections, and two
 * icon maps over one list is how the same section ends up with two faces. The
 * *list* still lives in `accounting-nav.ts` (framework-free, server-readable);
 * this is the client-side presentation half, keyed by the same union so a new
 * section cannot be added without giving it a glyph.
 */

import {
  BarChart3Icon,
  CalendarDaysIcon,
  CalculatorIcon,
  CircleIcon,
  ClipboardListIcon,
  LayoutDashboardIcon,
  ReceiptIcon,
  ScrollTextIcon,
  SettingsIcon,
  TrendingUpIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import type { AccountingSectionKey } from "./accounting-routes";

export const ACCOUNTING_SECTION_ICONS: Record<AccountingSectionKey, LucideIcon> = {
  dashboard: LayoutDashboardIcon,
  "trial-balance": CalculatorIcon,
  entries: ClipboardListIcon,
  manual: ClipboardListIcon,
  expenses: CircleIcon,
  "fiscal-periods": CalendarDaysIcon,
  directory: UsersIcon,
  receivables: UsersIcon,
  payables: UsersIcon,
  receipts: ScrollTextIcon,
  installments: CalendarDaysIcon,
  cheques: ScrollTextIcon,
  reconciliation: CircleIcon,
  "chart-of-accounts": CalculatorIcon,
  payroll: UsersIcon,
  vat: CircleIcon,
  "tax-invoices": ReceiptIcon,
  "fixed-assets": CircleIcon,
  "financial-reports": BarChart3Icon,
  growth: TrendingUpIcon,
  settings: SettingsIcon,
};
