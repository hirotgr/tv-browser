"use strict";

// src/main/renderer-preload.ts
var import_electron = require("electron");
function subscribe(channel, callback) {
  const handler = (_event, payload) => {
    callback(payload);
  };
  import_electron.ipcRenderer.on(channel, handler);
  return () => {
    import_electron.ipcRenderer.removeListener(channel, handler);
  };
}
import_electron.contextBridge.exposeInMainWorld("desktopApi", {
  getSettings: () => import_electron.ipcRenderer.invoke("settings:get"),
  updateSettings: (patch) => import_electron.ipcRenderer.invoke("settings:update", patch),
  resizeCard: (size) => import_electron.ipcRenderer.invoke("card:resize", size),
  getLayout: () => import_electron.ipcRenderer.invoke("layout:get"),
  setWindowWidth: (payload) => import_electron.ipcRenderer.invoke("window:set-width", payload),
  setTradingViewSuspended: (suspended) => import_electron.ipcRenderer.invoke("trading-view:set-suspended", suspended),
  onLayoutChanged: (callback) => subscribe("layout:changed", callback),
  onSettingsChanged: (callback) => subscribe("settings:changed", callback)
});
//# sourceMappingURL=renderer-preload.js.map