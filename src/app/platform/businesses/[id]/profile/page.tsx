"use client";

/**
 * Owner & managers for one business (issue #755 §1).
 *
 * A dedicated section rather than a card inside Settings: there can be more
 * than one login-holding member, and a list needs room to grow into a team
 * view without becoming a wall inside a settings form.
 */
import { OwnerProfilesPanel } from "../owner-profiles-panel";

export default function BusinessProfilePage() {
  return <OwnerProfilesPanel />;
}
