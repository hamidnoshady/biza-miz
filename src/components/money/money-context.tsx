"use client";

import { createContext, useContext, useMemo } from "react";
import {
  formatMoney,
  formatMoneyText,
  moneyFromInput,
  moneyToInput,
  moneyToInputText,
  parseMoneyToRial,
  parseToRialText,
  type MoneyUnit,
  type Rial,
} from "@/lib/money";

/**
 * A business's money is always *stored* in Rial; its display/input unit is the
 * owner's choice (`business.prefs.currencyDisplay`, set in the setup wizard and
 * editable in settings). This context carries that unit to every money input
 * and read-out so a business that chose «ریال» sees and types Rial, while the
 * default «تومان» keeps the original behaviour.
 */
export interface MoneyApi {
  unit: MoneyUnit;
  /** The unit's Persian name: «تومان» or «ریال». */
  unitLabel: string;
  /** Rial (number) → display string with the business's unit. */
  format: (rial: Rial, opts?: { withUnit?: boolean }) => string;
  /** Rial (string, BigInt-safe) → display string with the business's unit. */
  formatText: (rialText: string, opts?: { withUnit?: boolean }) => string;
  /** User input string → integer Rial in the business's unit. */
  parse: (input: string) => Rial;
  /** User input string → Rial *as a decimal string* (BigInt-safe) in the business's unit. */
  parseText: (input: string) => string;
  /** Rial → the number a numeric input should show in the business's unit. */
  toInput: (rial: Rial) => number;
  /** Rial *text* (BigInt-safe) → the integer text a money input should show in the business's unit. */
  toInputText: (rialText: string) => string;
  /** A numeric input's value → Rial in the business's unit. */
  fromInput: (value: number) => Rial;
}

function apiFor(unit: MoneyUnit): MoneyApi {
  return {
    unit,
    unitLabel: unit === "rial" ? "ریال" : "تومان",
    format: (rial, opts) => formatMoney(rial, unit, opts),
    formatText: (rialText, opts) => formatMoneyText(rialText, unit, opts),
    parse: (input) => parseMoneyToRial(input, unit),
    parseText: (input) => parseToRialText(input, unit),
    toInput: (rial) => moneyToInput(rial, unit),
    toInputText: (rialText) => moneyToInputText(rialText, unit),
    fromInput: (value) => moneyFromInput(value, unit),
  };
}

const MoneyContext = createContext<MoneyApi>(apiFor("toman"));

export function MoneyProvider({
  unit,
  children,
}: {
  unit: MoneyUnit;
  children: React.ReactNode;
}) {
  const value = useMemo(() => apiFor(unit), [unit]);
  return <MoneyContext.Provider value={value}>{children}</MoneyContext.Provider>;
}

/**
 * Read the business's money unit and the helpers bound to it. Outside a
 * provider this falls back to Toman (the historical default), so shared
 * components keep working in contexts that never mount one.
 */
export function useMoney(): MoneyApi {
  return useContext(MoneyContext);
}
