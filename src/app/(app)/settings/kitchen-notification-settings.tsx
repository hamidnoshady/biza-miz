"use client";

import { KitchenAlertSettings } from "@/app/dashboard/kitchen/kitchen-alert-settings";
import { useKitchenAlertThresholds, useKitchenSound } from "@/app/dashboard/kitchen/use-kitchen-alert-settings";

export function KitchenNotificationSettings() {
  const { thresholds, canEditThresholds, thresholdsWarning, saveThresholds } = useKitchenAlertThresholds();
  const { soundPreferences, soundBlocked, audioReady, toggleSound, toggleSoundEvent, testSound } = useKitchenSound();

  return (
    <KitchenAlertSettings
      canEditThresholds={canEditThresholds}
      thresholds={thresholds}
      thresholdsWarning={thresholdsWarning}
      soundPreferences={soundPreferences}
      soundBlocked={soundBlocked}
      audioReady={audioReady}
      onToggleSound={() => void toggleSound()}
      onToggleSoundEvent={toggleSoundEvent}
      onTestSound={() => void testSound()}
      onSaveThresholds={saveThresholds}
    />
  );
}
