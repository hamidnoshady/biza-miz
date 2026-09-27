import type { CmsOrder } from "./types";

/** CMS store prices are integer minor units in the site's currency snapshot. */
export function cmsMinorToRial(amount: number, currency: CmsOrder["currency"]): bigint {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("invalid_amount");
  const minor = BigInt(Math.trunc(amount));
  switch (currency) {
    case "IRT":
      return minor * 10n;
    case "IRR":
      return minor;
    default:
      throw new Error("unsupported_currency");
  }
}
