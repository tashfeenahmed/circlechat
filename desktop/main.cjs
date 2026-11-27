// SPDX-License-Identifier: AGPL-3.0-only
// CircleChat desktop: a thin native shell around your own CircleChat server.
// Remembers the server address, shows native notifications (from the web app),
// puts the number of things waiting on you in the Dock badge, opens links in the browser.
const { app, BrowserWindow, shell, ipcMain, Menu } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const cfgFile = () => path.join(app.getPath("userData"), "settings.json");
const load = () => { try { return JSON.parse(fs.readFileSync(cfgFile(), "utf8")); } catch { return {}; } };
const save = (c) => fs.writeFileSync(cfgFile(), JSON.stringify(c, null, 2));

let win;
function open() {
  const cfg = load();
  win = new BrowserWindow({
    width: cfg.bounds?.width ?? 1360, height: cfg.bounds?.height ?? 900, x: cfg.bounds?.x, y: cfg.bounds?.y,
    minWidth: 980, minHeight: 640, title: "CircleChat", backgroundColor: "#F4F5F8",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  const server = process.env.CIRCLECHAT_URL || cfg.server;
  if (server) win.loadURL(server);
  else win.loadFile(path.join(__dirname, "connect.html"));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => {
    const s = load().server;
    if (s && !url.startsWith(s) && !url.startsWith("file:")) { e.preventDefault(); shell.openExternal(url); }
  });
  win.on("close", () => save({ ...load(), bounds: win.getBounds() }));
  // smoke test hook: CIRCLECHAT_SCREENSHOT=<file> captures the window once loaded, then quits
  if (process.env.CIRCLECHAT_SCREENSHOT) {
    win.webContents.once("did-finish-load", () => setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.CIRCLECHAT_SCREENSHOT, img.toPNG());
      app.quit();
    }, 2500));
  }
}

ipcMain.handle("set-server", (_e, url) => {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Use an http or https address");
  save({ ...load(), server: u.origin });
  win.loadURL(u.origin);
});
ipcMain.on("badge", (_e, n) => { if (process.platform === "darwin") app.dock.setBadge(n > 0 ? String(n) : ""); else app.setBadgeCount(n); });

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "editMenu" }, { role: "viewMenu" },
    { label: "Server", submenu: [{ label: "Change server…", click: () => { save({ ...load(), server: undefined }); win.loadFile(path.join(__dirname, "connect.html")); } }] },
    { role: "windowMenu" },
  ]));
  open();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && open());
});
app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());
