// SPDX-License-Identifier: AGPL-3.0-only
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("circlechatDesktop", {
  setServer: (url) => ipcRenderer.invoke("set-server", url),
  setBadge: (n) => ipcRenderer.send("badge", Number(n) || 0),
});
