import { OwnerActivation } from "./owner-activation";

/**
 * Issue #755 §14 — where an owner activates the account a platform operator
 * created for them.
 *
 * Public: the person following the link has no session and no usable password,
 * so the single-use token in the URL is the credential. It is on the
 * middleware's public list for the same reason `/invite` is.
 */
export default async function ActivatePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <OwnerActivation token={token} />;
}
