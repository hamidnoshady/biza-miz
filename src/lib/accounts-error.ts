/**
 * The error every chart-of-accounts writer throws, in one place.
 *
 * Lives in its own module (rather than accounts-service.ts) so the shared
 * hierarchy rules in account-hierarchy.ts can throw the same class without
 * importing the service that imports them. `accounts-service` re-exports it,
 * so existing `import { AccountsError } from "./accounts-service"` call sites
 * are unchanged.
 */
export class AccountsError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}
