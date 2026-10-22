"use client";

/**
 * Shared store picker for WP Manager sections.
 *
 * Two forms. `embedded` is the common one: the caller already owns a toolbar
 * card (`${cardClass} flex … p-4`) holding the picker next to its own
 * actions, so the picker contributes the label and the select and no chrome
 * of its own — nesting one bordered, padded surface inside another drew a
 * doubled border with dead space around the select. The standalone form
 * keeps the card for a host that renders the picker on its own.
 */
import { useId } from "react";
import { cardClass } from "@/app/dashboard/page-chrome";
import { inputClass } from "@/app/dashboard/ui";

export interface ConnectionLite {
  id: string;
  name: string;
  linkMode: "rest_api" | "plugin";
  status?: string;
  /** The store's URL; shown next to the name so two stores that share a name are told apart (#944 / OVR-09). */
  baseUrl?: string;
}

function hostOf(baseUrl: string | undefined): string {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

/** «نام — دامنه (حالت)» for one option of the picker. */
export function connectionOptionLabel(connection: ConnectionLite): string {
  const host = hostOf(connection.baseUrl);
  const name = host && host !== connection.name ? `${connection.name} — ${host}` : connection.name;
  return `${name} (${connection.linkMode === "plugin" ? "افزونهٔ وردپرس" : "REST API"})`;
}

export function ConnectionPicker({
  connections,
  value,
  onChange,
  children,
  className,
  embedded = false,
  disabled,
}: {
  connections: ConnectionLite[];
  value: string;
  onChange: (id: string) => void;
  /**
   * Drop the card chrome when the picker sits inside another surface (a
   * toolbar card with the section's actions). The default standalone form
   * keeps the chrome so hosts that render it on its own are unchanged.
   */
  children?: React.ReactNode;
  className?: string;
  embedded?: boolean;
  disabled?: boolean;
}) {
  // A page can host two pickers (a section plus a dialog); the hardcoded id
  // this replaces tied both labels — and both click targets — to whichever
  // select mounted first.
  const id = useId();
  return (
    <div
      className={
        embedded
          ? "flex min-w-0 flex-1 flex-wrap items-center gap-2"
          : `${cardClass} flex flex-wrap items-center justify-between gap-3 p-3 sm:p-4 ${className ?? ""}`
      }
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <label className="shrink-0 text-sm font-medium text-foreground" htmlFor={id}>
          فروشگاه:
        </label>
        <select
          id={id}
          className={`${inputClass} min-w-0 flex-1 basis-40 sm:min-w-56`}
          value={value}
          disabled={disabled || connections.length === 0}
          onChange={(e) => onChange(e.target.value)}
        >
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {connectionOptionLabel(c)}
            </option>
          ))}
        </select>
      </div>
      {children ? (
        <div className={`flex flex-wrap items-center gap-2 ${embedded ? "" : "ms-auto"}`}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
