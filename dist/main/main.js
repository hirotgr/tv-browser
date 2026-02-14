"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/main/main.ts
var import_node_path2 = __toESM(require("path"));
var import_electron = require("electron");

// src/main/settings-store.ts
var import_node_fs = __toESM(require("fs"));
var import_node_path = __toESM(require("path"));
var SETTINGS_FILE_NAME = "settings.json";
var DEFAULT_SETTINGS = {
  theme: "dark",
  alwaysOnTop: false,
  cardWidth: 980,
  cardHeight: 680,
  windowWidth: 1320,
  windowHeight: 920,
  widthResizeOrigin: "right"
};
function asFiniteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function asBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function asTheme(value, fallback) {
  return value === "dark" || value === "light" ? value : fallback;
}
function asWidthResizeOrigin(value, fallback) {
  return value === "right" || value === "left" ? value : fallback;
}
function sanitize(raw) {
  return {
    theme: asTheme(raw.theme, DEFAULT_SETTINGS.theme),
    alwaysOnTop: asBoolean(raw.alwaysOnTop, DEFAULT_SETTINGS.alwaysOnTop),
    cardWidth: asFiniteNumber(raw.cardWidth, DEFAULT_SETTINGS.cardWidth),
    cardHeight: asFiniteNumber(raw.cardHeight, DEFAULT_SETTINGS.cardHeight),
    windowWidth: asFiniteNumber(raw.windowWidth, DEFAULT_SETTINGS.windowWidth),
    windowHeight: asFiniteNumber(raw.windowHeight, DEFAULT_SETTINGS.windowHeight),
    widthResizeOrigin: asWidthResizeOrigin(raw.widthResizeOrigin, DEFAULT_SETTINGS.widthResizeOrigin)
  };
}
function resolveSettingsPath(userDataPath) {
  return import_node_path.default.join(userDataPath, SETTINGS_FILE_NAME);
}
function loadSettings(userDataPath) {
  const settingsPath = resolveSettingsPath(userDataPath);
  if (!import_node_fs.default.existsSync(settingsPath)) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = import_node_fs.default.readFileSync(settingsPath, "utf8");
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings(userDataPath, settings2) {
  const settingsPath = resolveSettingsPath(userDataPath);
  const safeSettings = sanitize(settings2);
  try {
    import_node_fs.default.writeFileSync(settingsPath, JSON.stringify(safeSettings, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save settings:", error);
  }
}

// src/main/main.ts
var TRADINGVIEW_URL = "https://www.tradingview.com";
var TRADINGVIEW_PARTITION = "persist:tradingview";
var HEADER_HEIGHT = 38;
var WINDOW_PADDING = 2;
var CARD_PADDING = 8;
var HANDLE_SIZE = 18;
var MIN_CONTENT_WIDTH = 320;
var MIN_CONTENT_HEIGHT = 220;
var MIN_CARD_WIDTH = MIN_CONTENT_WIDTH + CARD_PADDING * 2;
var MIN_CARD_HEIGHT = MIN_CONTENT_HEIGHT + CARD_PADDING * 2;
var MIN_WINDOW_WIDTH = 320;
var MIN_WINDOW_HEIGHT = 640;
var SAVE_DEBOUNCE_MS = 250;
var mainWindow = null;
var tradingView = null;
var settings = { ...DEFAULT_SETTINGS };
var latestLayout = null;
var saveTimer = null;
var ipcRegistered = false;
function safeNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function sanitizeCoordinate(value) {
  return Math.max(0, Math.round(safeNumber(value, 0)));
}
function sanitizeTheme(value, fallback) {
  return value === "dark" || value === "light" ? value : fallback;
}
function sanitizeWidthResizeOrigin(value, fallback) {
  return value === "left" || value === "right" ? value : fallback;
}
function sanitizeSettings(next) {
  const base = {
    theme: sanitizeTheme(next.theme, DEFAULT_SETTINGS.theme),
    alwaysOnTop: Boolean(next.alwaysOnTop),
    cardWidth: sanitizeCoordinate(next.cardWidth),
    cardHeight: sanitizeCoordinate(next.cardHeight),
    windowWidth: sanitizeCoordinate(next.windowWidth),
    windowHeight: sanitizeCoordinate(next.windowHeight),
    widthResizeOrigin: sanitizeWidthResizeOrigin(
      next.widthResizeOrigin,
      DEFAULT_SETTINGS.widthResizeOrigin
    )
  };
  return {
    ...base,
    cardWidth: Math.max(MIN_CARD_WIDTH, base.cardWidth || DEFAULT_SETTINGS.cardWidth),
    cardHeight: Math.max(MIN_CARD_HEIGHT, base.cardHeight || DEFAULT_SETTINGS.cardHeight),
    windowWidth: Math.max(MIN_WINDOW_WIDTH, base.windowWidth || DEFAULT_SETTINGS.windowWidth),
    windowHeight: Math.max(MIN_WINDOW_HEIGHT, base.windowHeight || DEFAULT_SETTINGS.windowHeight)
  };
}
function flushSettings() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveSettings(import_electron.app.getPath("userData"), settings);
}
function scheduleSettingsSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushSettings();
  }, SAVE_DEBOUNCE_MS);
}
function computeLayout(windowWidth) {
  const cardWidth = Math.max(MIN_CARD_WIDTH, settings.cardWidth);
  const cardHeight = Math.max(MIN_CARD_HEIGHT, settings.cardHeight);
  if (cardWidth !== settings.cardWidth || cardHeight !== settings.cardHeight) {
    settings = { ...settings, cardWidth, cardHeight };
    scheduleSettingsSave();
  }
  const safeWindowWidth = Math.max(1, Math.round(windowWidth));
  const cardX = safeWindowWidth - WINDOW_PADDING - cardWidth;
  const cardY = HEADER_HEIGHT + WINDOW_PADDING;
  const contentX = cardX + CARD_PADDING;
  const contentY = cardY + CARD_PADDING;
  const contentWidth = Math.max(1, cardWidth - CARD_PADDING * 2);
  const contentHeight = Math.max(1, cardHeight - CARD_PADDING * 2);
  return {
    headerHeight: HEADER_HEIGHT,
    cardX,
    cardY,
    cardWidth,
    cardHeight,
    contentX,
    contentY,
    contentWidth,
    contentHeight,
    handleSize: HANDLE_SIZE,
    cardPadding: CARD_PADDING
  };
}
function broadcastLayout() {
  if (!mainWindow || !tradingView) {
    return;
  }
  const [windowWidth] = mainWindow.getContentSize();
  latestLayout = computeLayout(windowWidth);
  tradingView.setBounds({
    x: latestLayout.contentX,
    y: latestLayout.contentY,
    width: latestLayout.contentWidth,
    height: latestLayout.contentHeight
  });
  if (!mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("layout:changed", latestLayout);
  }
}
function applyThemeAndWindowFlags() {
  import_electron.nativeTheme.themeSource = settings.theme;
  if (!mainWindow) {
    return;
  }
  mainWindow.setAlwaysOnTop(settings.alwaysOnTop);
  mainWindow.setBackgroundColor(settings.theme === "dark" ? "#0d1217" : "#edf3f7");
  if (!mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("settings:changed", settings);
  }
}
function isAllowedExternalUrl(rawUrl) {
  try {
    return new URL(rawUrl).protocol === "https:";
  } catch {
    return false;
  }
}
function createMainWindow() {
  const initialWidth = Math.max(MIN_WINDOW_WIDTH, settings.windowWidth);
  const initialHeight = Math.max(MIN_WINDOW_HEIGHT, settings.windowHeight);
  mainWindow = new import_electron.BrowserWindow({
    useContentSize: true,
    width: initialWidth,
    height: initialHeight,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    autoHideMenuBar: true,
    title: "TV Browser",
    backgroundColor: "#0d1217",
    webPreferences: {
      preload: import_node_path2.default.join(__dirname, "renderer-preload.js"),
      contextIsolation: true,
      sandbox: false
    }
  });
  tradingView = new import_electron.WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      partition: TRADINGVIEW_PARTITION
    }
  });
  mainWindow.contentView.addChildView(tradingView);
  tradingView.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void import_electron.shell.openExternal(url);
    }
    return { action: "deny" };
  });
  void tradingView.webContents.loadURL(TRADINGVIEW_URL);
  void mainWindow.loadFile(import_node_path2.default.join(__dirname, "../renderer/index.html"));
  mainWindow.on("resize", () => {
    const windowRef = mainWindow;
    if (!windowRef) {
      return;
    }
    const [windowWidth, windowHeight] = windowRef.getContentSize();
    settings = {
      ...settings,
      windowWidth,
      windowHeight
    };
    scheduleSettingsSave();
    broadcastLayout();
  });
  mainWindow.on("close", () => {
    const windowRef = mainWindow;
    if (!windowRef) {
      return;
    }
    const [windowWidth, windowHeight] = windowRef.getContentSize();
    settings = {
      ...settings,
      windowWidth,
      windowHeight
    };
    flushSettings();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    tradingView = null;
    latestLayout = null;
  });
  mainWindow.webContents.on("did-finish-load", () => {
    applyThemeAndWindowFlags();
    broadcastLayout();
  });
}
function registerIpc() {
  if (ipcRegistered) {
    return;
  }
  ipcRegistered = true;
  import_electron.ipcMain.handle("settings:get", () => {
    return settings;
  });
  import_electron.ipcMain.handle("settings:update", (_event, patch) => {
    const next = {
      ...settings,
      theme: sanitizeTheme(patch.theme, settings.theme),
      alwaysOnTop: typeof patch.alwaysOnTop === "boolean" ? patch.alwaysOnTop : settings.alwaysOnTop,
      cardWidth: safeNumber(patch.cardWidth, settings.cardWidth),
      cardHeight: safeNumber(patch.cardHeight, settings.cardHeight),
      windowWidth: safeNumber(patch.windowWidth, settings.windowWidth),
      windowHeight: safeNumber(patch.windowHeight, settings.windowHeight),
      widthResizeOrigin: sanitizeWidthResizeOrigin(
        patch.widthResizeOrigin,
        settings.widthResizeOrigin
      )
    };
    settings = sanitizeSettings(next);
    applyThemeAndWindowFlags();
    broadcastLayout();
    scheduleSettingsSave();
    return settings;
  });
  import_electron.ipcMain.handle("card:resize", (_event, payload) => {
    const width = safeNumber(payload?.width, settings.cardWidth);
    const height = safeNumber(payload?.height, settings.cardHeight);
    settings = sanitizeSettings({
      ...settings,
      cardWidth: width,
      cardHeight: height
    });
    broadcastLayout();
    scheduleSettingsSave();
    return settings;
  });
  import_electron.ipcMain.handle("layout:get", () => {
    if (!latestLayout && mainWindow) {
      const [windowWidth] = mainWindow.getContentSize();
      latestLayout = computeLayout(windowWidth);
    }
    return latestLayout;
  });
  import_electron.ipcMain.handle(
    "window:set-width",
    (_event, payload) => {
      if (!mainWindow) {
        throw new Error("Main window is not available.");
      }
      const requestedWidth = Math.round(safeNumber(payload?.width, 0));
      const origin = sanitizeWidthResizeOrigin(payload?.origin, settings.widthResizeOrigin);
      const [minimumWidth] = mainWindow.getMinimumSize();
      const targetWidth = Math.max(minimumWidth, requestedWidth);
      const currentBounds = mainWindow.getContentBounds();
      const nextX = origin === "left" ? currentBounds.x + currentBounds.width - targetWidth : currentBounds.x;
      const nextBounds = {
        x: Math.round(nextX),
        y: currentBounds.y,
        width: targetWidth,
        height: currentBounds.height
      };
      mainWindow.setContentBounds(nextBounds);
      const [appliedWidth, appliedHeight] = mainWindow.getContentSize();
      settings = {
        ...settings,
        windowWidth: appliedWidth,
        windowHeight: appliedHeight,
        widthResizeOrigin: origin
      };
      scheduleSettingsSave();
      broadcastLayout();
      return { width: appliedWidth, height: appliedHeight };
    }
  );
}
void import_electron.app.whenReady().then(() => {
  settings = sanitizeSettings(loadSettings(import_electron.app.getPath("userData")));
  registerIpc();
  createMainWindow();
  applyThemeAndWindowFlags();
  import_electron.app.on("activate", () => {
    if (import_electron.BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      applyThemeAndWindowFlags();
    }
  });
});
import_electron.app.on("before-quit", () => {
  flushSettings();
});
import_electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    import_electron.app.quit();
  }
});
//# sourceMappingURL=main.js.map