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
  LayersIcon,
  BarChart3Icon,
  CalendarDaysIcon,
  CalculatorIcon,
  CircleIcon,
  ClipboardListIcon,
  CoinsIcon,
  HashIcon,
  LandmarkIcon,
  WalletIcon,
  ArrowLeftRightIcon,
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
  // «داشبورد حسابداری» (`/accounting/overview`) keeps the layout glyph its
  // sidebar row has always worn — the approved reference frame shows it. The
  // bottom bar and its picker now read this same entry, so the page has one
  // face everywhere. The app door (`/accounting`) is a separate identity and
  // keeps the calculator.
  dashboard: LayoutDashboardIcon,
  // «فضای کار حسابداری» wears the same calculator, so the ledger row is
  // recognisable at the 4rem rail where its label is hidden.
  ledger: CalculatorIcon,
  "trial-balance": CalculatorIcon,
  entries: ClipboardListIcon,
  vouchers: HashIcon,
  manual: ClipboardListIcon,
  expenses: CircleIcon,
  "fiscal-periods": CalendarDaysIcon,
  "opening-balances": LandmarkIcon,
  directory: UsersIcon,
  receivables: UsersIcon,
  payables: UsersIcon,
  receipts: ScrollTextIcon,
  // The containers themselves (a wallet) and the movement between them (the
  // two-way arrow every transfer UI wears).
  "financial-accounts": WalletIcon,
  transfers: ArrowLeftRightIcon,
  installments: CalendarDaysIcon,
  cheques: ScrollTextIcon,
  reconciliation: CircleIcon,
  multicurrency: CoinsIcon,
  "chart-of-accounts": CalculatorIcon,
  dimensions: LayersIcon,
  payroll: UsersIcon,
  vat: CircleIcon,
  "tax-invoices": ReceiptIcon,
  "fixed-assets": CircleIcon,
  "financial-reports": BarChart3Icon,
  growth: TrendingUpIcon,
  settings: SettingsIcon,
};
