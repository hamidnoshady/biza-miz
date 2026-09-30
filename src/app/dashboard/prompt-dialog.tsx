"use client";

import { useRef, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PrimaryButton, SecondaryButton, inputClass } from "./ui";

/**
 * In-app replacement for `window.prompt`, which the desktop app cannot use:
 * Electron replaces it with a function that throws «prompt() is not
 * supported.», so any action behind it silently did nothing there.
 *
 *   const [promptDialog, ask] = usePromptDialog();
 *   const reason = await ask("دلیل ابطال سفارش؟");   // null = cancelled
 *   … render {promptDialog} once in the component.
 */
export function usePromptDialog(): [ReactNode, (title: string, initial?: string) => Promise<string | null>] {
  const [state, setState] = useState<{ title: string; value: string } | null>(null);
  const resolver = useRef<((value: string | null) => void) | null>(null);

  function close(result: string | null) {
    resolver.current?.(result);
    resolver.current = null;
    setState(null);
  }

  function ask(title: string, initial = ""): Promise<string | null> {
    resolver.current?.(null);
    setState({ title, value: initial });
    return new Promise((resolve) => {
      resolver.current = resolve;
    });
  }

  const element = (
    <Dialog open={state !== null} onOpenChange={(open) => (open ? undefined : close(null))}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            close(state?.value ?? "");
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>{state?.title}</DialogTitle>
          </DialogHeader>
          <input
            autoFocus
            className={inputClass}
            value={state?.value ?? ""}
            onChange={(event) => setState((s) => (s ? { ...s, value: event.target.value } : s))}
            aria-label={state?.title}
          />
          <DialogFooter>
            <SecondaryButton onClick={() => close(null)}>انصراف</SecondaryButton>
            <PrimaryButton>تأیید</PrimaryButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
  return [element, ask];
}
