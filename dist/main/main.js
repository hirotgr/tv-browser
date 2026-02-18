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
var import_node_fs2 = __toESM(require("fs"));
var import_node_path2 = __toESM(require("path"));
var import_electron = require("electron");

// src/main/settings-store.ts
var import_node_fs = __toESM(require("fs"));
var import_node_path = __toESM(require("path"));
var SETTINGS_FILE_NAME = "settings.json";
var MAX_SITE_URL_LENGTH = 64;
var DEFAULT_SETTINGS = {
  theme: "dark",
  alwaysOnTop: false,
  siteUrl: "https://www.tradingview.com",
  cardWidth: 980,
  cardHeight: 680,
  windowWidth: 1320,
  windowHeight: 920,
  windowX: null,
  windowY: null,
  widthResizeOrigin: "right"
};
function asFiniteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function asNullableCoordinate(value, fallback) {
  if (value === null || value === void 0) {
    return fallback;
  }
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
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
function asSiteUrl(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SITE_URL_LENGTH) {
    return fallback;
  }
  try {
    return new URL(trimmed).protocol === "https:" ? trimmed : fallback;
  } catch {
    return fallback;
  }
}
function sanitize(raw) {
  return {
    theme: asTheme(raw.theme, DEFAULT_SETTINGS.theme),
    alwaysOnTop: asBoolean(raw.alwaysOnTop, DEFAULT_SETTINGS.alwaysOnTop),
    siteUrl: asSiteUrl(raw.siteUrl, DEFAULT_SETTINGS.siteUrl),
    cardWidth: asFiniteNumber(raw.cardWidth, DEFAULT_SETTINGS.cardWidth),
    cardHeight: asFiniteNumber(raw.cardHeight, DEFAULT_SETTINGS.cardHeight),
    windowWidth: asFiniteNumber(raw.windowWidth, DEFAULT_SETTINGS.windowWidth),
    windowHeight: asFiniteNumber(raw.windowHeight, DEFAULT_SETTINGS.windowHeight),
    windowX: asNullableCoordinate(raw.windowX, DEFAULT_SETTINGS.windowX),
    windowY: asNullableCoordinate(raw.windowY, DEFAULT_SETTINGS.windowY),
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
var TRADINGVIEW_PARTITION = "persist:tradingview";
var HEADER_HEIGHT = 38;
var WINDOW_PADDING = 2;
var CARD_PADDING = 8;
var HANDLE_SIZE = 18;
var NEW_WINDOW_OFFSET = 28;
var MIN_CONTENT_WIDTH = 320;
var MIN_CONTENT_HEIGHT = 220;
var MIN_CARD_WIDTH = MIN_CONTENT_WIDTH + CARD_PADDING * 2;
var MIN_CARD_HEIGHT = MIN_CONTENT_HEIGHT + CARD_PADDING * 2;
var MIN_WINDOW_WIDTH = 320;
var MIN_WINDOW_HEIGHT = 640;
var SAVE_DEBOUNCE_MS = 250;
var MAX_SITE_URL_LENGTH2 = 64;
var SETTINGS_FILE_NAME2 = "settings.json";
var LEGACY_USER_DATA_DIR = "tv-watchlist";
var settings = { ...DEFAULT_SETTINGS };
var saveTimer = null;
var ipcRegistered = false;
var windowContexts = /* @__PURE__ */ new Map();
var lastClosedLocalSnapshot = null;
function safeNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function sanitizeCoordinate(value) {
  return Math.max(0, Math.round(safeNumber(value, 0)));
}
function sanitizeOptionalCoordinate(value, fallback) {
  if (value === null || value === void 0) {
    return fallback;
  }
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
}
function sanitizeTheme(value, fallback) {
  return value === "dark" || value === "light" ? value : fallback;
}
function sanitizeSiteUrl(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SITE_URL_LENGTH2) {
    return fallback;
  }
  try {
    return new URL(trimmed).protocol === "https:" ? trimmed : fallback;
  } catch {
    return fallback;
  }
}
function sanitizeWidthResizeOrigin(value, fallback) {
  return value === "left" || value === "right" ? value : fallback;
}
function migrateLegacySettingsIfNeeded() {
  const userDataPath = import_electron.app.getPath("userData");
  const currentSettingsPath = import_node_path2.default.join(userDataPath, SETTINGS_FILE_NAME2);
  if (import_node_fs2.default.existsSync(currentSettingsPath)) {
    return;
  }
  const legacyUserDataPath = import_node_path2.default.join(import_node_path2.default.dirname(userDataPath), LEGACY_USER_DATA_DIR);
  const legacySettingsPath = import_node_path2.default.join(legacyUserDataPath, SETTINGS_FILE_NAME2);
  if (!import_node_fs2.default.existsSync(legacySettingsPath)) {
    return;
  }
  try {
    import_node_fs2.default.mkdirSync(userDataPath, { recursive: true });
    import_node_fs2.default.copyFileSync(legacySettingsPath, currentSettingsPath);
  } catch (error) {
    console.error("Failed to migrate legacy settings:", error);
  }
}
function sanitizeSettings(next) {
  const base = {
    theme: sanitizeTheme(next.theme, DEFAULT_SETTINGS.theme),
    alwaysOnTop: Boolean(next.alwaysOnTop),
    siteUrl: sanitizeSiteUrl(next.siteUrl, DEFAULT_SETTINGS.siteUrl),
    cardWidth: sanitizeCoordinate(next.cardWidth),
    cardHeight: sanitizeCoordinate(next.cardHeight),
    windowWidth: sanitizeCoordinate(next.windowWidth),
    windowHeight: sanitizeCoordinate(next.windowHeight),
    windowX: sanitizeOptionalCoordinate(next.windowX, DEFAULT_SETTINGS.windowX),
    windowY: sanitizeOptionalCoordinate(next.windowY, DEFAULT_SETTINGS.windowY),
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
function extractLocalSettings(source) {
  return {
    alwaysOnTop: source.alwaysOnTop,
    cardWidth: source.cardWidth,
    cardHeight: source.cardHeight,
    windowWidth: source.windowWidth,
    windowHeight: source.windowHeight,
    windowX: source.windowX,
    windowY: source.windowY,
    widthResizeOrigin: source.widthResizeOrigin
  };
}
function sanitizeLocalSettings(next) {
  const base = {
    alwaysOnTop: Boolean(next.alwaysOnTop),
    cardWidth: sanitizeCoordinate(next.cardWidth),
    cardHeight: sanitizeCoordinate(next.cardHeight),
    windowWidth: sanitizeCoordinate(next.windowWidth),
    windowHeight: sanitizeCoordinate(next.windowHeight),
    windowX: sanitizeOptionalCoordinate(next.windowX, DEFAULT_SETTINGS.windowX),
    windowY: sanitizeOptionalCoordinate(next.windowY, DEFAULT_SETTINGS.windowY),
    widthResizeOrigin: sanitizeWidthResizeOrigin(next.widthResizeOrigin, DEFAULT_SETTINGS.widthResizeOrigin)
  };
  return {
    ...base,
    cardWidth: Math.max(MIN_CARD_WIDTH, base.cardWidth || DEFAULT_SETTINGS.cardWidth),
    cardHeight: Math.max(MIN_CARD_HEIGHT, base.cardHeight || DEFAULT_SETTINGS.cardHeight),
    windowWidth: Math.max(MIN_WINDOW_WIDTH, base.windowWidth || DEFAULT_SETTINGS.windowWidth),
    windowHeight: Math.max(MIN_WINDOW_HEIGHT, base.windowHeight || DEFAULT_SETTINGS.windowHeight)
  };
}
function sameLocalSettings(a, b) {
  return a.alwaysOnTop === b.alwaysOnTop && a.cardWidth === b.cardWidth && a.cardHeight === b.cardHeight && a.windowWidth === b.windowWidth && a.windowHeight === b.windowHeight && a.windowX === b.windowX && a.windowY === b.windowY && a.widthResizeOrigin === b.widthResizeOrigin;
}
function mergeLocalSettingsIntoDefaults(local, options) {
  const includePosition = options?.includePosition ?? true;
  settings = sanitizeSettings({
    ...settings,
    alwaysOnTop: local.alwaysOnTop,
    cardWidth: local.cardWidth,
    cardHeight: local.cardHeight,
    windowWidth: local.windowWidth,
    windowHeight: local.windowHeight,
    windowX: includePosition ? local.windowX : settings.windowX,
    windowY: includePosition ? local.windowY : settings.windowY,
    widthResizeOrigin: local.widthResizeOrigin
  });
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
function composeSettings(context) {
  return {
    theme: settings.theme,
    alwaysOnTop: context.local.alwaysOnTop,
    siteUrl: settings.siteUrl,
    cardWidth: context.local.cardWidth,
    cardHeight: context.local.cardHeight,
    windowWidth: context.local.windowWidth,
    windowHeight: context.local.windowHeight,
    windowX: context.local.windowX,
    windowY: context.local.windowY,
    widthResizeOrigin: context.local.widthResizeOrigin
  };
}
function computeLayout(windowWidth, local) {
  const safeWindowWidth = Math.max(1, Math.round(windowWidth));
  const cardX = safeWindowWidth - WINDOW_PADDING - local.cardWidth;
  const cardY = HEADER_HEIGHT + WINDOW_PADDING;
  const contentX = cardX + CARD_PADDING;
  const contentY = cardY + CARD_PADDING;
  const contentWidth = Math.max(1, local.cardWidth - CARD_PADDING * 2);
  const contentHeight = Math.max(1, local.cardHeight - CARD_PADDING * 2);
  return {
    headerHeight: HEADER_HEIGHT,
    cardX,
    cardY,
    cardWidth: local.cardWidth,
    cardHeight: local.cardHeight,
    contentX,
    contentY,
    contentWidth,
    contentHeight,
    handleSize: HANDLE_SIZE,
    cardPadding: CARD_PADDING
  };
}
function emitSettingsChanged(context) {
  if (!context.window.webContents.isDestroyed()) {
    context.window.webContents.send("settings:changed", composeSettings(context));
  }
}
function broadcastLayout(context) {
  if (context.window.isDestroyed() || context.tradingView.webContents.isDestroyed()) {
    return;
  }
  const [windowWidth] = context.window.getContentSize();
  context.latestLayout = computeLayout(windowWidth, context.local);
  if (context.tradingViewSuspended) {
    context.tradingView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  } else {
    context.tradingView.setBounds({
      x: context.latestLayout.contentX,
      y: context.latestLayout.contentY,
      width: context.latestLayout.contentWidth,
      height: context.latestLayout.contentHeight
    });
  }
  if (!context.window.webContents.isDestroyed()) {
    context.window.webContents.send("layout:changed", context.latestLayout);
  }
}
function applyWindowAppearance(context, emit = true) {
  context.window.setAlwaysOnTop(context.local.alwaysOnTop);
  context.window.setBackgroundColor(settings.theme === "dark" ? "#0d1217" : "#edf3f7");
  if (emit) {
    emitSettingsChanged(context);
  }
}
function applyThemeAndWindowFlags() {
  import_electron.nativeTheme.themeSource = settings.theme;
  for (const context of windowContexts.values()) {
    applyWindowAppearance(context, true);
  }
}
function isAllowedExternalUrl(rawUrl) {
  try {
    return new URL(rawUrl).protocol === "https:";
  } catch {
    return false;
  }
}
function loadTradingViewTarget(context, url) {
  if (context.tradingView.webContents.isDestroyed()) {
    return;
  }
  void context.tradingView.webContents.loadURL(url).catch((error) => {
    console.error("Failed to load site URL:", error);
  });
}
function loadTradingViewTargets(url) {
  for (const context of windowContexts.values()) {
    loadTradingViewTarget(context, url);
  }
}
function resolveWindowContext(event) {
  const senderWindow = import_electron.BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow) {
    return null;
  }
  return windowContexts.get(senderWindow.id) ?? null;
}
function requireWindowContext(event) {
  const context = resolveWindowContext(event);
  if (!context) {
    throw new Error("Window context is not available.");
  }
  return context;
}
function resolveSourceContext(sourceWindowId) {
  if (typeof sourceWindowId === "number") {
    return windowContexts.get(sourceWindowId) ?? null;
  }
  const focusedWindow = import_electron.BrowserWindow.getFocusedWindow();
  if (!focusedWindow) {
    return null;
  }
  return windowContexts.get(focusedWindow.id) ?? null;
}
function updateWindowSizeInLocalSettings(context) {
  if (context.window.isDestroyed()) {
    return;
  }
  const [windowWidth, windowHeight] = context.window.getContentSize();
  context.local = sanitizeLocalSettings({
    ...context.local,
    windowWidth,
    windowHeight
  });
}
function updateWindowPositionInLocalSettings(context) {
  if (context.window.isDestroyed()) {
    return;
  }
  const { x, y } = context.window.getBounds();
  context.local = sanitizeLocalSettings({
    ...context.local,
    windowX: x,
    windowY: y
  });
}
function captureWindowSnapshot(context) {
  try {
    updateWindowSizeInLocalSettings(context);
    updateWindowPositionInLocalSettings(context);
    lastClosedLocalSnapshot = { ...context.local };
  } catch (error) {
    console.error("Failed to capture window snapshot:", error);
  }
}
function clampBoundsToDisplayWorkArea(bounds) {
  const display = import_electron.screen.getDisplayMatching(bounds);
  const { x, y, width, height } = display.workArea;
  const maxX = x + Math.max(0, width - bounds.width);
  const maxY = y + Math.max(0, height - bounds.height);
  return {
    x: Math.round(Math.min(Math.max(bounds.x, x), maxX)),
    y: Math.round(Math.min(Math.max(bounds.y, y), maxY)),
    width: bounds.width,
    height: bounds.height
  };
}
function createAppWindow(sourceWindowId) {
  const sourceContext = resolveSourceContext(sourceWindowId);
  let local = sanitizeLocalSettings(sourceContext ? sourceContext.local : extractLocalSettings(settings));
  if (sourceContext && !sourceContext.window.isDestroyed()) {
    const [sourceWidth, sourceHeight] = sourceContext.window.getContentSize();
    local = sanitizeLocalSettings({
      ...local,
      windowWidth: sourceWidth,
      windowHeight: sourceHeight
    });
  }
  const windowOptions = {
    useContentSize: true,
    width: local.windowWidth,
    height: local.windowHeight,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    autoHideMenuBar: true,
    title: "TV Browser",
    alwaysOnTop: local.alwaysOnTop,
    backgroundColor: settings.theme === "dark" ? "#0d1217" : "#edf3f7",
    webPreferences: {
      preload: import_node_path2.default.join(__dirname, "renderer-preload.js"),
      contextIsolation: true,
      sandbox: false
    }
  };
  if (sourceContext && !sourceContext.window.isDestroyed()) {
    const sourceBounds = sourceContext.window.getBounds();
    windowOptions.x = sourceBounds.x + NEW_WINDOW_OFFSET;
    windowOptions.y = sourceBounds.y + NEW_WINDOW_OFFSET;
  } else if (local.windowX !== null && local.windowY !== null) {
    const clamped = clampBoundsToDisplayWorkArea({
      x: local.windowX,
      y: local.windowY,
      width: local.windowWidth,
      height: local.windowHeight
    });
    windowOptions.x = clamped.x;
    windowOptions.y = clamped.y;
  }
  const windowRef = new import_electron.BrowserWindow(windowOptions);
  const tradingView = new import_electron.WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      partition: TRADINGVIEW_PARTITION
    }
  });
  const context = {
    window: windowRef,
    tradingView,
    local,
    latestLayout: null,
    tradingViewSuspended: false
  };
  windowContexts.set(windowRef.id, context);
  windowRef.contentView.addChildView(tradingView);
  tradingView.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void import_electron.shell.openExternal(url);
    }
    return { action: "deny" };
  });
  loadTradingViewTarget(context, settings.siteUrl);
  void windowRef.loadFile(import_node_path2.default.join(__dirname, "../renderer/index.html"));
  windowRef.on("resize", () => {
    updateWindowSizeInLocalSettings(context);
    mergeLocalSettingsIntoDefaults(context.local, { includePosition: false });
    scheduleSettingsSave();
    broadcastLayout(context);
  });
  windowRef.on("move", () => {
    updateWindowPositionInLocalSettings(context);
  });
  windowRef.on("moved", () => {
    updateWindowPositionInLocalSettings(context);
  });
  windowRef.on("close", () => {
    captureWindowSnapshot(context);
  });
  windowRef.on("closed", () => {
    lastClosedLocalSnapshot = { ...context.local };
    windowContexts.delete(windowRef.id);
  });
  windowRef.webContents.on("did-finish-load", () => {
    applyWindowAppearance(context, true);
    broadcastLayout(context);
  });
  return windowRef;
}
function createApplicationMenu() {
  const newWindowMenuItem = {
    label: "New Window",
    accelerator: process.platform === "darwin" ? "Command+N" : "CommandOrControl+N",
    click: () => {
      const focusedWindow = import_electron.BrowserWindow.getFocusedWindow();
      createAppWindow(focusedWindow?.id);
    }
  };
  const template = process.platform === "darwin" ? [
    { role: "appMenu" },
    {
      label: "File",
      submenu: [newWindowMenuItem, { type: "separator" }, { role: "close" }]
    },
    { role: "editMenu" },
    { role: "windowMenu" }
  ] : [
    {
      label: "File",
      submenu: [newWindowMenuItem, { type: "separator" }, { role: "quit" }]
    }
  ];
  import_electron.Menu.setApplicationMenu(import_electron.Menu.buildFromTemplate(template));
}
function registerIpc() {
  if (ipcRegistered) {
    return;
  }
  ipcRegistered = true;
  import_electron.ipcMain.handle("window:create", (event) => {
    const source = resolveWindowContext(event);
    createAppWindow(source?.window.id);
  });
  import_electron.ipcMain.handle("settings:get", (event) => {
    const context = requireWindowContext(event);
    return composeSettings(context);
  });
  import_electron.ipcMain.handle("settings:update", (event, patch) => {
    const context = requireWindowContext(event);
    const nextTheme = sanitizeTheme(patch.theme, settings.theme);
    const nextSiteUrl = sanitizeSiteUrl(patch.siteUrl, settings.siteUrl);
    let globalChanged = false;
    if (nextTheme !== settings.theme) {
      settings = { ...settings, theme: nextTheme };
      globalChanged = true;
    }
    const previousSiteUrl = settings.siteUrl;
    if (nextSiteUrl !== settings.siteUrl) {
      settings = { ...settings, siteUrl: nextSiteUrl };
      globalChanged = true;
    }
    const localPatchProvided = typeof patch.alwaysOnTop === "boolean" || patch.cardWidth !== void 0 || patch.cardHeight !== void 0 || patch.windowWidth !== void 0 || patch.windowHeight !== void 0 || patch.windowX !== void 0 || patch.windowY !== void 0 || patch.widthResizeOrigin !== void 0;
    let localChanged = false;
    if (localPatchProvided) {
      const nextLocal = sanitizeLocalSettings({
        alwaysOnTop: typeof patch.alwaysOnTop === "boolean" ? patch.alwaysOnTop : context.local.alwaysOnTop,
        cardWidth: safeNumber(patch.cardWidth, context.local.cardWidth),
        cardHeight: safeNumber(patch.cardHeight, context.local.cardHeight),
        windowWidth: safeNumber(patch.windowWidth, context.local.windowWidth),
        windowHeight: safeNumber(patch.windowHeight, context.local.windowHeight),
        windowX: sanitizeOptionalCoordinate(patch.windowX, context.local.windowX),
        windowY: sanitizeOptionalCoordinate(patch.windowY, context.local.windowY),
        widthResizeOrigin: sanitizeWidthResizeOrigin(
          patch.widthResizeOrigin,
          context.local.widthResizeOrigin
        )
      });
      if (!sameLocalSettings(nextLocal, context.local)) {
        context.local = nextLocal;
        localChanged = true;
      }
    }
    if (localChanged) {
      mergeLocalSettingsIntoDefaults(context.local, { includePosition: false });
      broadcastLayout(context);
    }
    if (settings.siteUrl !== previousSiteUrl) {
      loadTradingViewTargets(settings.siteUrl);
    }
    if (globalChanged) {
      applyThemeAndWindowFlags();
    } else if (localChanged) {
      applyWindowAppearance(context, true);
    }
    if (globalChanged || localChanged) {
      scheduleSettingsSave();
    }
    return composeSettings(context);
  });
  import_electron.ipcMain.handle("card:resize", (event, payload) => {
    const context = requireWindowContext(event);
    const nextLocal = sanitizeLocalSettings({
      ...context.local,
      cardWidth: safeNumber(payload?.width, context.local.cardWidth),
      cardHeight: safeNumber(payload?.height, context.local.cardHeight)
    });
    if (!sameLocalSettings(nextLocal, context.local)) {
      context.local = nextLocal;
      mergeLocalSettingsIntoDefaults(context.local, { includePosition: false });
      scheduleSettingsSave();
      broadcastLayout(context);
    }
    return composeSettings(context);
  });
  import_electron.ipcMain.handle("layout:get", (event) => {
    const context = requireWindowContext(event);
    if (!context.latestLayout) {
      const [windowWidth] = context.window.getContentSize();
      context.latestLayout = computeLayout(windowWidth, context.local);
    }
    return context.latestLayout;
  });
  import_electron.ipcMain.handle("trading-view:set-suspended", (event, suspended) => {
    const context = requireWindowContext(event);
    context.tradingViewSuspended = Boolean(suspended);
    broadcastLayout(context);
  });
  import_electron.ipcMain.handle(
    "window:set-width",
    (event, payload) => {
      const context = requireWindowContext(event);
      const requestedWidth = Math.round(safeNumber(payload?.width, 0));
      const origin = sanitizeWidthResizeOrigin(payload?.origin, context.local.widthResizeOrigin);
      const [minimumWidth] = context.window.getMinimumSize();
      const targetWidth = Math.max(minimumWidth, requestedWidth);
      const currentBounds = context.window.getContentBounds();
      const nextX = origin === "left" ? currentBounds.x + currentBounds.width - targetWidth : currentBounds.x;
      const nextBounds = {
        x: Math.round(nextX),
        y: currentBounds.y,
        width: targetWidth,
        height: currentBounds.height
      };
      context.window.setContentBounds(nextBounds);
      const [appliedWidth, appliedHeight] = context.window.getContentSize();
      context.local = sanitizeLocalSettings({
        ...context.local,
        windowWidth: appliedWidth,
        windowHeight: appliedHeight,
        widthResizeOrigin: origin
      });
      mergeLocalSettingsIntoDefaults(context.local, { includePosition: false });
      scheduleSettingsSave();
      broadcastLayout(context);
      emitSettingsChanged(context);
      return { width: appliedWidth, height: appliedHeight };
    }
  );
}
void import_electron.app.whenReady().then(() => {
  migrateLegacySettingsIfNeeded();
  settings = sanitizeSettings(loadSettings(import_electron.app.getPath("userData")));
  import_electron.nativeTheme.themeSource = settings.theme;
  registerIpc();
  createApplicationMenu();
  createAppWindow();
  import_electron.app.on("activate", () => {
    if (import_electron.BrowserWindow.getAllWindows().length === 0) {
      createAppWindow();
    }
  });
});
import_electron.app.on("window-all-closed", () => {
  if (lastClosedLocalSnapshot) {
    mergeLocalSettingsIntoDefaults(lastClosedLocalSnapshot, { includePosition: true });
    flushSettings();
  }
  lastClosedLocalSnapshot = null;
  if (process.platform !== "darwin") {
    import_electron.app.quit();
  }
});
//# sourceMappingURL=main.js.map