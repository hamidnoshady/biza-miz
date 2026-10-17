"use client";

import Link from "next/link";
import { FingerprintIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { useNative } from "@/components/native/native-provider";
import { SIDEBAR_FOOTER_BUTTON_CLASS } from "./sidebar-nav-styles";

export function BiometricSettingsButton() {
  const [webAuthnSupported, setWebAuthnSupported] = useState(false);
  const { capabilities } = useNative();

  useEffect(() => {
    setWebAuthnSupported(browserSupportsWebAuthn());
  }, []);

  if (!webAuthnSupported && !capabilities.biometric.available) return null;

  return (
    <Link href="/settings/profile" className={SIDEBAR_FOOTER_BUTTON_CLASS}>
      <FingerprintIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-start">ورود بیومتریک</span>
    </Link>
  );
}
