"use client";

import Link from "next/link";
import { FingerprintIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { SIDEBAR_FOOTER_BUTTON_CLASS } from "./sidebar-nav-styles";

/**
 * Phase 20 Wave 3 — self-service "manage biometric login" entry for PIN-role
 * staff (the same audience as the lock screen/login picker's biometric
 * option). Lives in the sidebar footer next to the lock button rather than
 * under /dashboard/settings: that page's tabs are all gated by owner/manager
 * permissions (settings-tabs.ts), and this is each employee managing their
 * own credential, not something a manager configures for them.
 *
 * Issue #854 (P2.28): the credential management itself moved to the canonical
 * `WebAuthnManager` card on `/settings/profile` — this button used to own a
 * second, sidebar-only copy of the whole panel, which meant the profile page
 * had no biometric surface and the panel had no permanent home. The shortcut
 * now links to the one implementation instead of duplicating it.
 */
export function BiometricSettingsButton() {
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
  }, []);

  if (!supported) return null;

  return (
    <Link href="/settings/profile" className={SIDEBAR_FOOTER_BUTTON_CLASS}>
      <FingerprintIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-start">ورود بیومتریک</span>
    </Link>
  );
}
