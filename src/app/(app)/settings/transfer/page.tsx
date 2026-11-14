import { redirect } from "next/navigation";

/**
 * Legacy Data Transfer route (`/settings/transfer`), preserving `?import=catalogue`
 * and any other query string when forwarding to `/settings/data-transfer`.
 */
export default async function LegacyTransferRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") qs.set(key, value);
    else if (Array.isArray(value)) for (const v of value) qs.append(key, v);
  }
  const query = qs.toString();
  redirect(query ? `/settings/data-transfer?${query}` : "/settings/data-transfer");
}
