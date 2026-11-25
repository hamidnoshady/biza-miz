"use strict";

/**
 * The saved-business picker window (issue #1572 / ESH-223).
 *
 * ## Why it is a window and not a route
 *
 * Choosing a business happens *before* any business's application server exists
 * — it is the decision that says which server to start. There is therefore no
 * Next.js process to render a page from, exactly like `main.js`'s first-run
 * storage prompt, which is why this is a standalone local document
 * (`profile-picker.html`) rather than a route inside the app.
 *
 * ## What it is allowed to do
 *
 * Only four things, each one resolving the promise `showProfilePicker()` returns:
 * choose a profile, add one, remove one locally, or quit. It cannot read a
 * business's data and it never receives a credential — it selects a data root,
 * and that business's own login then runs unchanged inside its own app.
 *
 * ## Trust boundary
 *
 * The window is a sandboxed renderer with no Node and a narrow preload. Every
 * handler checks that the message came from *this* window's main frame, so a
 * document that somehow got the bridge cannot drive the picker. The picker's IPC
 * handlers are registered here, not in `main.js`, so the desktop shell's
 * "no raw `ipcMain.handle`" rule (src/lib/desktop-shell-hardening.test.ts) keeps
 * holding for the main window's much more powerful bridge.
 *
 * A removal asks first, in a native dialog that names the business, states that
 * its Cloud data is untouched, and warns about any local sales that have not
 * synchronised yet. Removing a local profile is not deleting a business.
 */

const path = require("node:path");
const { BrowserWindow, dialog, ipcMain } = require("electron");

const PICKER_CHANNELS = Object.freeze([
  "profiles:list",
  "profiles:choose",
  "profiles:add",
  "profiles:remove",
  "profiles:quit",
]);

function removeConfirmationDetail(profile) {
  const lines = [
    `«${profile.displayName}» از فهرست کسب‌وکارهای این رایانه حذف می‌شود.`,
    "داده‌های کسب‌وکار در فضای ابری حذف نمی‌شود.",
  ];
  if (profile.hasData) {
    lines.push(
      "توجه: داده‌های محلی این کسب‌وکار — از جمله فروش‌های ثبت‌شده و رویدادهای همگام‌سازی‌نشده — نیز از این رایانه پاک می‌شود. اگر همگام‌سازی انجام نشده باشد، این اطلاعات از دست می‌رود.",
    );
  } else {
    lines.push("این کسب‌وکار هنوز دادهٔ محلی ندارد.");
  }
  return lines.join("\n\n");
}

/**
 * Show the picker and resolve with what the user chose:
 *   `{ action: "choose", profileId }` | `{ action: "add", displayName }`
 *   | `{ action: "remove", profileId }` | `{ action: "quit" }`
 *
 * @param {object} options
 * @param {() => { profiles: object[], lastUsedProfileId: string | null }} options.list
 * @param {(profileId: string) => object | null} options.describe Removal facts (`displayName`, `hasData`).
 * @param {object} [options.logger]
 */
function showProfilePicker(options) {
  const { list, describe, logger } = options;

  return new Promise((resolve) => {
    let settled = false;
    const window = new BrowserWindow({
      width: 760,
      height: 640,
      minWidth: 620,
      minHeight: 520,
      show: false,
      resizable: true,
      minimizable: true,
      maximizable: false,
      autoHideMenuBar: true,
      backgroundColor: "#faf9f7",
      title: "انتخاب کسب‌وکار — بیزامیز",
      webPreferences: {
        preload: path.join(__dirname, "profile-picker-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const senderId = window.webContents.id;
    const fromThisWindow = (event) => event?.sender?.id === senderId;

    function cleanup() {
      for (const channel of PICKER_CHANNELS) ipcMain.removeHandler(channel);
      if (!window.isDestroyed()) window.destroy();
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      resolve(result);
      cleanup();
    }

    function reportError(event, message) {
      // Shown in place, next to the control the user just used.
      if (!settled && !window.isDestroyed()) {
        event.sender.send("profiles:error", { message });
      }
    }

    ipcMain.handle("profiles:list", (event) => {
      if (!fromThisWindow(event)) throw new Error("profiles:list_from_unknown_sender");
      return list();
    });

    ipcMain.handle("profiles:choose", (event, payload) => {
      if (!fromThisWindow(event)) throw new Error("profiles:choose_from_unknown_sender");
      const profileId = typeof payload?.profileId === "string" ? payload.profileId : "";
      if (!profileId) throw new Error("profiles:choose_requires_profile");
      finish({ action: "choose", profileId });
      return { ok: true };
    });

    ipcMain.handle("profiles:add", (event, payload) => {
      if (!fromThisWindow(event)) throw new Error("profiles:add_from_unknown_sender");
      const displayName = typeof payload?.displayName === "string" ? payload.displayName.trim().slice(0, 120) : "";
      if (!displayName) {
        reportError(event, "یک نام نمایشی برای این کسب‌وکار بنویسید.");
        return { ok: false, error: "display_name_required" };
      }
      finish({ action: "add", displayName });
      return { ok: true };
    });

    ipcMain.handle("profiles:remove", async (event, payload) => {
      if (!fromThisWindow(event)) throw new Error("profiles:remove_from_unknown_sender");
      const profileId = typeof payload?.profileId === "string" ? payload.profileId : "";
      const profile = profileId ? describe(profileId) : null;
      if (!profile) {
        reportError(event, "این کسب‌وکار پیدا نشد. فهرست را دوباره باز کنید.");
        return { ok: false, error: "profile_not_found" };
      }
      const confirmation = await dialog.showMessageBox(window, {
        type: "warning",
        title: "حذف کسب‌وکار از این رایانه",
        message: `«${profile.displayName}» از این رایانه حذف شود؟`,
        detail: removeConfirmationDetail(profile),
        buttons: ["انصراف", "حذف از این رایانه"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) return { ok: false, cancelled: true };
      finish({ action: "remove", profileId });
      return { ok: true };
    });

    ipcMain.handle("profiles:quit", (event) => {
      if (!fromThisWindow(event)) throw new Error("profiles:quit_from_unknown_sender");
      finish({ action: "quit" });
      return { ok: true };
    });

    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      // Closing the window with the title bar is "quit", not "hang forever".
      if (!settled) finish({ action: "quit" });
    });

    window.loadFile(path.join(__dirname, "profile-picker.html")).catch((error) => {
      logger?.error?.("The saved-business picker could not be loaded", error);
      finish({ action: "quit" });
    });
  });
}

module.exports = { showProfilePicker, PICKER_CHANNELS, removeConfirmationDetail };
