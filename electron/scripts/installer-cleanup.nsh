; Issue #1001 — what the uninstaller must remove besides files.
;
; Two pieces of machine state outlive an uninstall because electron-builder's
; uninstaller does not know about them:
;
;  * the `businesssuite://` protocol handler. Electron's
;    `app.setAsDefaultProtocolClient()` writes it at every launch under
;    HKCU\Software\Classes\businesssuite (the installer's `protocols` entry only
;    declares the scheme). After an uninstall it pointed at a deleted
;    executable.
;  * the "Bizamiz Local Devices" inbound firewall rule (and the "Business Suite
;    Local Devices" rule installs made before the rename), created by the
;    app's own elevated PowerShell call (electron/firewall-manager.js) when the
;    owner enabled the local-devices gateway.
;
; Both removals are best-effort by design: the installer is per-user and the
; uninstaller does not elevate, so deleting a rule an administrator created can
; fail. A failure must never block the uninstall — the app's own
; `desktop:firewall-remove` action remains the supported way to drop the rule.

!macro customUnInstall
  ; Per-user protocol handler. DeleteRegKey is a no-op when the key is absent.
  DeleteRegKey HKCU "Software\Classes\businesssuite"

  ; Inbound rule for the local-devices gateway. Silent, logged, and its exit
  ; code is discarded: no error dialog on an uninstall that a standard user
  ; cannot complete.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Bizamiz Local Devices"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Business Suite Local Devices"'
  Pop $0
!macroend
