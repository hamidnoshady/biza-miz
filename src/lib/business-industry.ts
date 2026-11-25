/**
 * The tenant's industry, read under an explicit tenant scope.
 *
 * A deliberately tiny module: the richer `industry-guard.ts` also answers
 * module/capability questions and pulls the industry/profile and routing
 * registries. Background workers, service activation and API guards only need
 * the value, and importing the rich guard there duplicates that graph into many
 * server route bundles (measured by the desktop size gate). Same query, same
 * tenant scope, one small dependency.
 */
import { query, withTenant } from "./db";
import type { Industry } from "./industries";

export async function readBusinessIndustry(businessId: string): Promise<Industry | null> {
  const { rows } = await withTenant(businessId, () =>
    query<{ industry: Industry }>("SELECT industry FROM businesses WHERE id = $1", [businessId]),
  );
  return rows[0]?.industry ?? null;
}
