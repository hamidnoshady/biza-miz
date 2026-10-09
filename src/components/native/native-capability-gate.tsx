"use client";

/**
 * Renders children only when a native capability is available on this device.
 *
 * `fallback` is shown in a plain browser or when nothing provides the capability.
 * `updateRequired` is shown only when the installed app is too old to provide a
 * capability that has no browser fallback, so the user is told to update the app
 * rather than being told the feature is missing.
 *
 * This gate decides what to show. It grants no permission. A server action behind
 * a gated button must still pass its Biza Miz role check.
 */
import type { ReactNode } from "react";
import type { NativeCapability } from "@/lib/native/bridge-contract";
import { useNative } from "./native-provider";

export interface NativeCapabilityGateProps {
  capability: NativeCapability;
  children: ReactNode;
  fallback?: ReactNode;
  updateRequired?: ReactNode;
}

export function NativeCapabilityGate({ capability, children, fallback = null, updateRequired }: NativeCapabilityGateProps) {
  const { capabilities } = useNative();
  const resolution = capabilities[capability];
  if (resolution.available) return <>{children}</>;
  if (resolution.updateRequired && updateRequired !== undefined) return <>{updateRequired}</>;
  return <>{fallback}</>;
}
