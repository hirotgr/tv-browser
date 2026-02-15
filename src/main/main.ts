import path from "node:path";
import {
  app,
  BrowserWindow,
  Rectangle,
  ipcMain,
  nativeTheme,
  shell,
  WebContentsView
} from "electron";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings-store";
import type {
  AppSettings,
  LayoutMetrics,
  ThemeMode,
  WidthResizeOrigin
} from "../shared/types";

const TRADINGVIEW_PARTITION = "persist:tradingview";

const HEADER_HEIGHT = 38;
const WINDOW_PADDING = 2;
const CARD_PADDING = 8;
const HANDLE_SIZE = 18;

const MIN_CONTENT_WIDTH = 320;
const MIN_CONTENT_HEIGHT = 220;
const MIN_CARD_WIDTH = MIN_CONTENT_WIDTH + CARD_PADDING * 2;
const MIN_CARD_HEIGHT = MIN_CONTENT_HEIGHT + CARD_PADDING * 2;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 640;

const SAVE_DEBOUNCE_MS = 250;
const MAX_SITE_URL_LENGTH = 64;

let mainWindow: BrowserWindow | null = null;
let tradingView: WebContentsView | null = null;
let settings: AppSettings = { ...DEFAULT_SETTINGS };
let latestLayout: LayoutMetrics | null = null;
let saveTimer: NodeJS.Timeout | null = null;
let ipcRegistered = false;
let tradingViewSuspended = false;

function safeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sanitizeCoordinate(value: unknown): number {
  return Math.max(0, Math.round(safeNumber(value, 0)));
}

function sanitizeTheme(value: unknown, fallback: ThemeMode): ThemeMode {
  return value === "dark" || value === "light" ? value : fallback;
}

function sanitizeSiteUrl(value: unknown, fallback: string): string {
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

function sanitizeWidthResizeOrigin(
  value: unknown,
  fallback: WidthResizeOrigin
): WidthResizeOrigin {
  return value === "left" || value === "right" ? value : fallback;
}

function sanitizeSettings(next: AppSettings): AppSettings {
  const base = {
    theme: sanitizeTheme(next.theme, DEFAULT_SETTINGS.theme),
    alwaysOnTop: Boolean(next.alwaysOnTop),
    siteUrl: sanitizeSiteUrl(next.siteUrl, DEFAULT_SETTINGS.siteUrl),
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

function flushSettings(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  saveSettings(app.getPath("userData"), settings);
}

function scheduleSettingsSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushSettings();
  }, SAVE_DEBOUNCE_MS);
}

function computeLayout(windowWidth: number): LayoutMetrics {
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

function broadcastLayout(): void {
  if (!mainWindow || !tradingView) {
    return;
  }

  const [windowWidth] = mainWindow.getContentSize();
  latestLayout = computeLayout(windowWidth);

  if (tradingViewSuspended) {
    tradingView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  } else {
    tradingView.setBounds({
      x: latestLayout.contentX,
      y: latestLayout.contentY,
      width: latestLayout.contentWidth,
      height: latestLayout.contentHeight
    });
  }

  if (!mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("layout:changed", latestLayout);
  }
}

function applyThemeAndWindowFlags(): void {
  nativeTheme.themeSource = settings.theme;
  if (!mainWindow) {
    return;
  }

  mainWindow.setAlwaysOnTop(settings.alwaysOnTop);
  mainWindow.setBackgroundColor(settings.theme === "dark" ? "#0d1217" : "#edf3f7");

  if (!mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("settings:changed", settings);
  }
}

function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).protocol === "https:";
  } catch {
    return false;
  }
}

function loadTradingViewTarget(url: string): void {
  if (!tradingView) {
    return;
  }

  void tradingView.webContents.loadURL(url).catch((error: unknown) => {
    console.error("Failed to load site URL:", error);
  });
}

function createMainWindow(): void {
  tradingViewSuspended = false;
  const initialWidth = Math.max(MIN_WINDOW_WIDTH, settings.windowWidth);
  const initialHeight = Math.max(MIN_WINDOW_HEIGHT, settings.windowHeight);

  mainWindow = new BrowserWindow({
    useContentSize: true,
    width: initialWidth,
    height: initialHeight,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    autoHideMenuBar: true,
    title: "TV Browser",
    backgroundColor: "#0d1217",
    webPreferences: {
      preload: path.join(__dirname, "renderer-preload.js"),
      contextIsolation: true,
      sandbox: false
    }
  });

  tradingView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      partition: TRADINGVIEW_PARTITION
    }
  });

  mainWindow.contentView.addChildView(tradingView);

  tradingView.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  loadTradingViewTarget(settings.siteUrl);
  void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

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
    tradingViewSuspended = false;
  });

  mainWindow.webContents.on("did-finish-load", () => {
    applyThemeAndWindowFlags();
    broadcastLayout();
  });
}

function registerIpc(): void {
  if (ipcRegistered) {
    return;
  }
  ipcRegistered = true;

  ipcMain.handle("settings:get", () => {
    return settings;
  });

  ipcMain.handle("settings:update", (_event, patch: Partial<AppSettings>) => {
    const previousSiteUrl = settings.siteUrl;
    const next: AppSettings = {
      ...settings,
      theme: sanitizeTheme(patch.theme, settings.theme),
      alwaysOnTop: typeof patch.alwaysOnTop === "boolean" ? patch.alwaysOnTop : settings.alwaysOnTop,
      siteUrl: sanitizeSiteUrl(patch.siteUrl, settings.siteUrl),
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
    if (settings.siteUrl !== previousSiteUrl) {
      loadTradingViewTarget(settings.siteUrl);
    }
    applyThemeAndWindowFlags();
    broadcastLayout();
    scheduleSettingsSave();
    return settings;
  });

  ipcMain.handle("card:resize", (_event, payload: { width: number; height: number }) => {
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

  ipcMain.handle("layout:get", () => {
    if (!latestLayout && mainWindow) {
      const [windowWidth] = mainWindow.getContentSize();
      latestLayout = computeLayout(windowWidth);
    }
    return latestLayout;
  });

  ipcMain.handle("trading-view:set-suspended", (_event, suspended: boolean) => {
    tradingViewSuspended = Boolean(suspended);
    broadcastLayout();
  });

  ipcMain.handle(
    "window:set-width",
    (_event, payload: { width: number; origin: WidthResizeOrigin }) => {
      if (!mainWindow) {
        throw new Error("Main window is not available.");
      }

      const requestedWidth = Math.round(safeNumber(payload?.width, 0));
      const origin = sanitizeWidthResizeOrigin(payload?.origin, settings.widthResizeOrigin);
      const [minimumWidth] = mainWindow.getMinimumSize();
      const targetWidth = Math.max(minimumWidth, requestedWidth);
      const currentBounds = mainWindow.getContentBounds();
      const nextX =
        origin === "left"
          ? currentBounds.x + currentBounds.width - targetWidth
          : currentBounds.x;

      const nextBounds: Rectangle = {
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

void app.whenReady().then(() => {
  settings = sanitizeSettings(loadSettings(app.getPath("userData")));
  registerIpc();
  createMainWindow();
  applyThemeAndWindowFlags();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      applyThemeAndWindowFlags();
    }
  });
});

app.on("before-quit", () => {
  flushSettings();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
