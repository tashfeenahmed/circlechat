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

const { randomUUID } = require("node:crypto");
const session = randomUUID();
let reports = 0;
function trackOpen() {
  if (!app.isPackaged || !load().diagnostics) return;
  void fetch('https://analytics.neu.so/api/track', {
    method: 'POST', headers: { Origin: 'https://circlechat.co', 'Content-Type': 'application/json', 'openpanel-client-id': 'a2e862a0-1a8d-4ad6-8b66-f5399650a434' },
    body: JSON.stringify({ type: 'track', payload: { name: 'app_open', properties: {
      platform: 'desktop', os: process.platform, __deviceId: session, __path: '/app',
    } } }),
  }).catch(() => {});
}
function reportFailure(kind) {
  if (!app.isPackaged || !load().diagnostics || reports++ >= 5) return;
  const id = randomUUID().replace(/-/g, '');
  const event = { event_id: id, timestamp: Date.now() / 1000, environment: 'production', level: 'error',
    platform: 'javascript', tags: { os: process.platform }, exception: { values: [{ type: kind, value: 'Desktop application error' }] } };
  const body = [{ event_id: id }, { type: 'event' }, event].map(part => JSON.stringify(part)).join('\n');
  void fetch('https://errors.neu.so/api/32/envelope/?sentry_key=fee7ba55176e43dd8284fff5fb0d2413&sentry_version=7', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body }).catch(() => {});
}
function startDiagnostics() {
  trackOpen();
  app.on('render-process-gone', (_event, _contents, details) => {
    if (details.reason !== 'clean-exit') reportFailure('RendererExit');
  });
  process.on('uncaughtExceptionMonitor', () => reportFailure('MainProcessError'));
}


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
  startDiagnostics();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "editMenu" }, { role: "viewMenu" },
    { label: "Server", submenu: [{ label: "Change server…", click: () => { save({ ...load(), server: undefined }); win.loadFile(path.join(__dirname, "connect.html")); } }] },
    { label: "Diagnostics", submenu: [{ label: "Share usage counts and error reports", type: "checkbox", checked: load().diagnostics === true,
      click: item => { save({ ...load(), diagnostics: item.checked }); if (item.checked) trackOpen(); } }] },
    { role: "windowMenu" },
  ]));
  open();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && open());
});
app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());
