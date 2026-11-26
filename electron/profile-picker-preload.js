"use strict";

/**
 * The saved-business picker's bridge (issue #1572 / ESH-223).
 *
 * A deliberately tiny surface: list the profiles, choose one, add one, remove
 * one locally, quit. Nothing here can read a business's data, and nothing here
 * carries a credential — the picker only selects which data root the app should
 * start, and the business's own login then runs unchanged inside its own app.
 */

const { contextBridge, ipcRenderer } = require("electron");

// A refused action is shown where the user is looking, inside this document.
// The main process names the channel; the renderer never sees ipcRenderer.
ipcRenderer.on("profiles:error", (_event, detail) => {
  const message = typeof detail?.message === "string" ? detail.message : "عملیات انجام نشد. دوباره تلاش کنید.";
  window.dispatchEvent(new CustomEvent("bizamiz:profiles-error", { detail: { message } }));
});

contextBridge.exposeInMainWorld(
  "bizamizProfiles",
  Object.freeze({
    list: () => ipcRenderer.invoke("profiles:list"),
    choose: (profileId) => ipcRenderer.invoke("profiles:choose", { profileId }),
    add: (displayName) => ipcRenderer.invoke("profiles:add", { displayName }),
    remove: (profileId) => ipcRenderer.invoke("profiles:remove", { profileId }),
    quit: () => ipcRenderer.invoke("profiles:quit"),
  }),
);

