import { ReviewScreen } from "./review-screen";

/**
 * Issue #1128 §E — the page a client review link lands on.
 *
 * Public, and public in the same way `/invite` is: the person arriving has no
 * session and must never be given one, because they are the client and not
 * staff. §B asks for "revocable scoped external review links" and for review
 * "without a new staff identity system", so the token in the URL is the whole
 * credential — there is no approve-style media permission behind this door, and
 * giving the client one would mean making them a member, which is the thing the
 * requirement rules out.
 *
 * Nothing is read here. The token is a secret and this page renders for whoever
 * holds it, so the fetch happens client-side against `/api/media/review/[token]`,
 * which answers `no-store`. Doing it server-side instead would put the token in
 * a rendered payload and cache key for no benefit.
 */
export default async function ReviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ReviewScreen token={token} />;
}
