"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "../ui";
import {
  DEFAULT_KITCHEN_ALERT_THRESHOLDS,
  DEFAULT_KITCHEN_SOUND_PREFERENCES,
  parseKitchenAlertThresholds,
  parseKitchenSoundPreferences,
  type KitchenAlertThresholds,
  type KitchenSoundEventKey,
  type KitchenSoundPreferences,
} from "@/lib/kitchen-alerts";

const THRESHOLD_CACHE_KEY = "kds.alert-thresholds";

/**
 * A cold boot with no network still needs the branch's last-known thresholds.
 * This is only a cache: the authoritative GET overwrites it as soon as the
 * server answers, and a corrupt entry falls back to the platform default.
 */
function readCachedThresholds(): KitchenAlertThresholds | null {
  try {
    const raw = window.localStorage.getItem(THRESHOLD_CACHE_KEY);
    if (!raw) return null;
    return parseKitchenAlertThresholds(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeCachedThresholds(thresholds: KitchenAlertThresholds): void {
  try {
    window.localStorage.setItem(THRESHOLD_CACHE_KEY, JSON.stringify(thresholds));
  } catch {
    // Private browsing/storage denial must not prevent use of the KDS.
  }
}

const ALERT_TONE_FREQUENCY: Record<KitchenSoundEventKey, number> = {
  newTicket: 880,
  addedItems: 988,
  aging: 660,
  connection: 440,
  printFailure: 330,
};


export function useKitchenAlertThresholds() {
  const [thresholds, setThresholds] = useState<KitchenAlertThresholds>(
    () => readCachedThresholds() ?? DEFAULT_KITCHEN_ALERT_THRESHOLDS,
  );
  const [canEditThresholds, setCanEditThresholds] = useState(false);
  const [thresholdsWarning, setThresholdsWarning] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<{ thresholds?: unknown; canEdit?: boolean; error?: string }>("/api/kitchen/alerts")
      .then(({ ok, data }) => {
        if (cancelled) return;
        const parsed = parseKitchenAlertThresholds(data.thresholds);
        if (ok && parsed) {
          setThresholds(parsed);
          writeCachedThresholds(parsed);
          setCanEditThresholds(data.canEdit === true);
          setThresholdsWarning(null);
          return;
        }
        if (!ok) {
          setThresholdsWarning(
            "آستانه‌های این شعبه از سرور خوانده نشد؛ آخرین مقدار ذخیره‌شده یا پیش‌فرض نمایش داده می‌شود.",
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setThresholdsWarning(
            "آستانه‌های این شعبه از سرور خوانده نشد؛ آخرین مقدار ذخیره‌شده یا پیش‌فرض نمایش داده می‌شود.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveThresholds(next: KitchenAlertThresholds): Promise<{ ok: boolean; error?: string }> {
    const result = await api<{ thresholds?: unknown; error?: string }>("/api/kitchen/alerts", {
      method: "PUT",
      body: JSON.stringify({ thresholds: next }),
    });
    if (!result.ok) return { ok: false, error: errorMessage(result.data.error) };
    const parsed = parseKitchenAlertThresholds(result.data.thresholds);
    if (!parsed) return { ok: false, error: "پاسخ تنظیمات آستانه معتبر نیست." };
    setThresholds(parsed);
    writeCachedThresholds(parsed);
    setThresholdsWarning(null);
    return { ok: true };
  }

  return { thresholds, canEditThresholds, thresholdsWarning, saveThresholds };
}

export function useKitchenSound() {
  const [soundPreferences, setSoundPreferences] = useState<KitchenSoundPreferences>(
    () => ({
      ...DEFAULT_KITCHEN_SOUND_PREFERENCES,
      events: { ...DEFAULT_KITCHEN_SOUND_PREFERENCES.events },
    }),
  );
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const audioContext = useRef<AudioContext | null>(null);

  const readSound = useCallback(() => {
    try {
      const legacySound = window.localStorage.getItem("kds.sound-alerts");
      const raw = window.localStorage.getItem("kds.sound-preferences");
      const parsed = parseKitchenSoundPreferences(raw ? JSON.parse(raw) : null);
      // `kds.sound-alerts` predates the per-event matrix; honour an explicit
      // legacy "on" choice rather than silently muting an existing device.
      setSoundPreferences(!raw && legacySound === "true" ? { ...parsed, enabled: true } : parsed);
    } catch {
      // Private browsing/storage denial must not prevent use of the KDS.
    }
  }, []);

  useEffect(() => {
    readSound();
    function syncSound(event: StorageEvent) {
      if (event.key === null || event.key === "kds.sound-preferences" || event.key === "kds.sound-alerts") readSound();
    }
    window.addEventListener("storage", syncSound);
    return () => {
      window.removeEventListener("storage", syncSound);
      void audioContext.current?.close().catch(() => {});
      audioContext.current = null;
    };
  }, [readSound]);

  /**
   * Create/resume the audio context only from a user gesture (or after the
   * operator has already opted in). A denied/suspended context is a visible
   * state, not a silent failure: the visual alerts stay on either way.
   */
  const ensureAudio = useCallback(async (): Promise<boolean> => {
    if (typeof window === "undefined") return false;
    const AudioCtor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) {
      setSoundBlocked(true);
      setAudioReady(false);
      return false;
    }
    try {
      let context = audioContext.current;
      if (!context || context.state === "closed") {
        context = new AudioCtor();
        audioContext.current = context;
      }
      if (context.state === "suspended") await context.resume();
      if (context.state !== "running") {
        setSoundBlocked(true);
        setAudioReady(false);
        return false;
      }
      setAudioReady(true);
      setSoundBlocked(false);
      return true;
    } catch {
      setSoundBlocked(true);
      setAudioReady(false);
      return false;
    }
  }, []);

  const playTone = useCallback((event: KitchenSoundEventKey): boolean => {
    const context = audioContext.current;
    if (!context || context.state !== "running") return false;
    try {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = ALERT_TONE_FREQUENCY[event];
      gain.gain.value = 0.04;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.16);
      return true;
    } catch {
      // Browser audio policy/device failures should never block queue updates.
      return false;
    }
  }, []);

  function saveSound(next: KitchenSoundPreferences) {
    try {
      window.localStorage.setItem("kds.sound-preferences", JSON.stringify(next));
      window.localStorage.setItem("kds.sound-alerts", String(next.enabled));
    } catch {
      // Audio may still work for this page when storage is blocked.
    }
    setSoundPreferences(next);
  }

  async function toggleSound() {
    if (soundPreferences.enabled && audioReady) {
      saveSound({ ...soundPreferences, enabled: false });
      void audioContext.current?.close().catch(() => {});
      audioContext.current = null;
      setAudioReady(false);
      setSoundBlocked(false);
      return;
    }
    // Enabled-from-storage but not yet unlocked in this page: the button says
    // «فعال‌سازی», so this click must resume the context rather than mute.
    const ready = await ensureAudio();
    if (!ready) {
      toast.warning(
        "پخش صدا در این مرورگر مسدود است؛ هشدارهای بصری همچنان نمایش داده می‌شوند.",
      );
      return;
    }
    saveSound({ ...soundPreferences, enabled: true });
    playTone("newTicket");
  }

  function toggleSoundEvent(event: KitchenSoundEventKey) {
    saveSound({
      ...soundPreferences,
      events: { ...soundPreferences.events, [event]: !soundPreferences.events[event] },
    });
  }

  async function testSound() {
    if (!(await ensureAudio())) {
      toast.warning(
        "پخش صدا در این مرورگر مسدود است؛ هشدارهای بصری همچنان نمایش داده می‌شوند.",
      );
      return;
    }
    playTone("newTicket");
  }

  return { soundPreferences, soundBlocked, setSoundBlocked, audioReady, ensureAudio, playTone, toggleSound, toggleSoundEvent, testSound };
}
