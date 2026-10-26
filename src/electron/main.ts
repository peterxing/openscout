import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, globalShortcut, Menu, nativeImage, Notification, screen, shell, Tray } from "electron";
import { OpenScoutApp } from "../server/app.js";
import { ASSETS_DIR, paths } from "../server/paths.js";
import { readJson, writeJson, type BroadcastMessage } from "../server/util.js";

const APP_ID = "com.openscout.desktop";
const WINDOW_ICON = path.join(ASSETS_DIR, process.platform === "win32" ? "icon.ico" : "icon.png");

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId(APP_ID);

/**
 * Windows only shows toasts for unpackaged apps that have a Start Menu shortcut carrying the
 * same AppUserModelID, so keep one in place (it doubles as the launcher).
 */
function ensureStartMenuShortcut(): void {
  if (process.platform !== "win32" || app.isPackaged) return;
  try {
    const lnk = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "OpenScout.lnk");
    const options = {
      target: process.execPath,
      args: `"${app.getAppPath()}"`,
      cwd: app.getAppPath(),
      description: "OpenScout — desktop assistant for work and study (GitHub Copilot + Microsoft 365)",
      icon: path.join(ASSETS_DIR, "icon.ico"),
      iconIndex: 0,
      appUserModelId: APP_ID,
    };
    const existing = fs.existsSync(lnk) ? shell.readShortcutLink(lnk) : null;
    if (!existing || existing.target !== options.target || existing.args !== options.args || existing.appUserModelId !== APP_ID) {
      shell.writeShortcutLink(lnk, existing ? "replace" : "create", options);
    }
  } catch {
    // Non-fatal: notifications fall back to the in-app toast.
  }
}

let backend: OpenScoutApp | null = null;
let appUrl = "";
let appOrigin = "";
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let shortcut = "";

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

function restoreBounds(): WindowState {
  const st = readJson<WindowState>(paths.windowState, { width: 1180, height: 820 });
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return st.x !== undefined && st.y !== undefined && st.x >= a.x - 50 && st.y >= a.y - 50 && st.x < a.x + a.width && st.y < a.y + a.height;
  });
  return visible ? st : { width: st.width, height: st.height, maximized: st.maximized };
}

function saveBounds(): void {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  writeJson(paths.windowState, { ...b, maximized: win.isMaximized() });
}

function createWindow(): void {
  const st = restoreBounds();
  win = new BrowserWindow({
    x: st.x,
    y: st.y,
    width: st.width,
    height: st.height,
    minWidth: 720,
    minHeight: 520,
    title: "OpenScout",
    icon: WINDOW_ICON,
    backgroundColor: "#111318",
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  if (st.maximized) win.maximize();
  win.loadURL(appUrl);
  win.once("ready-to-show", () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(appOrigin)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith(appOrigin)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  let saveTimer: NodeJS.Timeout | null = null;
  const queueSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBounds, 500);
  };
  win.on("resize", queueSave);
  win.on("move", queueSave);
  win.on("close", (e) => {
    saveBounds();
    if (!quitting && backend?.settings.get().closeToTray) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on("closed", () => {
    win = null;
  });
}

function showWindow(): void {
  if (!win) createWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow(): void {
  if (win && win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

function createTray(): void {
  const icon = nativeImage.createFromPath(path.join(ASSETS_DIR, "tray.png"));
  tray = new Tray(icon);
  tray.setToolTip("OpenScout");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open OpenScout", click: showWindow },
      {
        label: "New conversation",
        click: () => {
          showWindow();
          backend?.bus.publish("ui.newChat", {});
        },
      },
      { type: "separator" },
      { label: "Run heartbeat now", click: () => backend?.automations.runNow("heartbeat") },
      { label: "Open working folder", click: () => void shell.openPath(backend?.settings.get().workingDirectory ?? paths.data) },
      { type: "separator" },
      {
        label: "Quit OpenScout",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", toggleWindow);
}

function registerShortcut(): void {
  const sc = backend?.settings.get().shortcut;
  const wanted = sc?.enabled ? sc.accelerator : "";
  if (wanted === shortcut) return;
  if (shortcut) globalShortcut.unregister(shortcut);
  shortcut = "";
  if (wanted) {
    try {
      if (globalShortcut.register(wanted, toggleWindow)) shortcut = wanted;
    } catch {
      // Invalid accelerator; leave unregistered.
    }
  }
}

function showNotification(payload: { title?: string; body?: string; sessionId?: string }): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: payload.title || "OpenScout",
    body: payload.body || "",
    icon: path.join(ASSETS_DIR, "icon-64.png"),
  });
  n.on("click", () => {
    showWindow();
    if (payload.sessionId) backend?.bus.publish("ui.openSession", { sessionId: payload.sessionId });
  });
  n.show();
}

app.on("second-instance", showWindow);

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  ensureStartMenuShortcut();
  backend = new OpenScoutApp({
    host: "electron",
    openPath: (p) => shell.openPath(p),
    showItemInFolder: (p) => shell.showItemInFolder(p),
    openExternal: (u) => shell.openExternal(u),
  });
  const started = await backend.start({ port: 0 });
  appUrl = started.url;
  appOrigin = new URL(appUrl).origin;
  backend.bus.on("broadcast", (msg: BroadcastMessage) => {
    if (msg.event === "notify") showNotification(msg.payload as any);
    if (msg.event === "settings.changed") registerShortcut();
    if (msg.event === "attention" && win && !win.isFocused()) win.flashFrame(true);
  });
  createWindow();
  createTray();
  registerShortcut();
});

app.on("window-all-closed", () => {
  // Keep running in the tray so automations continue; quitting happens via the tray menu.
  if (!backend?.settings.get().closeToTray) {
    quitting = true;
    app.quit();
  }
});

app.on("before-quit", () => {
  quitting = true;
});

let stopped = false;
app.on("will-quit", (e) => {
  globalShortcut.unregisterAll();
  if (stopped || !backend) return;
  e.preventDefault();
  stopped = true;
  // Bounded cleanup (runtime, Work IQ, HTTP), then exit without re-running the quit sequence.
  void Promise.race([backend.stop(), new Promise((r) => setTimeout(r, 8000))])
    .catch(() => undefined)
    .finally(() => app.exit(0));
});
