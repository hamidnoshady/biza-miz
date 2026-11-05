import type { Metadata } from "next";
import { SignerExperience } from "./signer-experience";

/**
 * `/sign/<token>` — the external signatory's page (issue #908).
 *
 * Deliberately NOT inside `(app)`: the signer is a third party who must never
 * receive the tenant's shell, navigation or any hint that they could sign in.
 * The page holds nothing but the document they were invited to sign and the
 * four steps that make their signature mean something.
 *
 * It renders no data on the server: everything comes from
 * `/api/sign/<token>`, which is the endpoint that resolves the token to exactly
 * one signer and one frozen version. That keeps the token out of the HTML a
 * proxy or a browser cache could retain, and keeps the page a shell that the
 * API can answer as `active`, `receipt` or `closed`.
 */
export const metadata: Metadata = {
  title: "امضای قرارداد",
  description: "مشاهده و امضای الکترونیکی سند قرارداد",
  robots: { index: false, follow: false },
};

export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="min-h-dvh bg-background px-3 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-[820px]">
        <SignerExperience token={token} />
      </div>
    </main>
  );
}
