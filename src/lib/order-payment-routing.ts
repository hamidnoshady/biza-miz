import type { FinancialAccountKind } from "./financial-accounts";
import type { PaymentSettlement } from "./payment-methods";

export function paymentSourceKindForSettlement(settlement: PaymentSettlement): FinancialAccountKind | null {
  switch (settlement) {
    case "cash": return "cash";
    case "card":
    case "online": return "pos_psp";
    case "card_to_card": return "bank";
    default: return null;
  }
}
