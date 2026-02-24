import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  Rectangle,
  ipcMain,
  nativeTheme,
  screen,
  WebContentsView
} from "electron";
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from "electron";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings-store";
import type {
  AppSettings,
  CaptureIntervalMin,
  CaptureState,
  CaptureToggleResult,
  LayoutMetrics,
  ThemeMode,
  WidthResizeOrigin
} from "../shared/types";

const TRADINGVIEW_PARTITION = "persist:tradingview";

const HEADER_HEIGHT = 38;
const WINDOW_PADDING = 2;
const CARD_PADDING = 8;
const HANDLE_SIZE = 18;
const NEW_WINDOW_OFFSET = 28;

const MIN_CONTENT_WIDTH = 320;
const MIN_CONTENT_HEIGHT = 220;
const MIN_CARD_WIDTH = MIN_CONTENT_WIDTH + CARD_PADDING * 2;
const MIN_CARD_HEIGHT = MIN_CONTENT_HEIGHT + CARD_PADDING * 2;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 640;

const SAVE_DEBOUNCE_MS = 250;
const MAX_SITE_URL_LENGTH = 64;
const SETTINGS_FILE_NAME = "settings.json";
const LEGACY_USER_DATA_DIR = "tv-watchlist";
const CAPTURE_INTERVAL_VALUES: readonly CaptureIntervalMin[] = [1, 5, 15, 30, 60, 240];
const CAPTURE_MARGIN_SECONDS = 5;
const INVALID_CAPTURE_FILE_NAME_PATTERN = /[<>:"/\\|?*\u0000-\u001f]/;

interface WindowLocalSettings {
  alwaysOnTop: boolean;
  cardWidth: number;
  cardHeight: number;
  windowWidth: number;
  windowHeight: number;
  windowX: number | null;
  windowY: number | null;
  widthResizeOrigin: WidthResizeOrigin;
}

interface WindowContext {
  window: BrowserWindow;
  tradingView: WebContentsView;
  local: WindowLocalSettings;
  latestLayout: LayoutMetrics | null;
  tradingViewSuspended: boolean;
  allowCloseAfterCaptureConfirm: boolean;
}

let settings: AppSettings = { ...DEFAULT_SETTINGS };
let saveTimer: NodeJS.Timeout | null = null;
let ipcRegistered = false;
const windowContexts = new Map<number, WindowContext>();
let lastClosedLocalSnapshot: WindowLocalSettings | null = null;
let activeCaptureWindowId: number | null = null;
let capturePaused = false;
let captureTimer: NodeJS.Timeout | null = null;

function safeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sanitizeCoordinate(value: unknown): number {
  return Math.max(0, Math.round(safeNumber(value, 0)));
}

function sanitizeOptionalCoordinate(value: unknown, fallback: number | null): number | null {
  if (value === null || value === undefined) {
    return fallback;
  }

  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
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

function sanitizeCaptureIntervalMin(
  value: unknown,
  fallback: CaptureIntervalMin
): CaptureIntervalMin {
  return CAPTURE_INTERVAL_VALUES.includes(value as CaptureIntervalMin)
    ? (value as CaptureIntervalMin)
    : fallback;
}

function sanitizeDisplayModeWidths(
  wideValue: unknown,
  narrowValue: unknown,
  fallbackWide: number,
  fallbackNarrow: number
): Pick<AppSettings, "wideModeWidth" | "narrowModeWidth"> {
  const defaultWideModeWidth = Math.max(MIN_WINDOW_WIDTH, DEFAULT_SETTINGS.wideModeWidth);
  const defaultNarrowModeWidth = Math.max(MIN_WINDOW_WIDTH, DEFAULT_SETTINGS.narrowModeWidth);

  let safeFallbackWide = Math.max(MIN_WINDOW_WIDTH, sanitizeCoordinate(fallbackWide) || defaultWideModeWidth);
  let safeFallbackNarrow = Math.max(
    MIN_WINDOW_WIDTH,
    sanitizeCoordinate(fallbackNarrow) || defaultNarrowModeWidth
  );

  if (safeFallbackWide <= safeFallbackNarrow) {
    safeFallbackWide = defaultWideModeWidth;
    safeFallbackNarrow = defaultNarrowModeWidth;
  }

  const wideModeWidth = Math.max(MIN_WINDOW_WIDTH, sanitizeCoordinate(wideValue) || safeFallbackWide);
  const narrowModeWidth = Math.max(MIN_WINDOW_WIDTH, sanitizeCoordinate(narrowValue) || safeFallbackNarrow);

  if (wideModeWidth <= narrowModeWidth) {
    return {
      wideModeWidth: safeFallbackWide,
      narrowModeWidth: safeFallbackNarrow
    };
  }

  return {
    wideModeWidth,
    narrowModeWidth
  };
}

function normalizeCaptureFileName(rawValue: string): string {
  return rawValue.trim().replace(/(?:\.png)+$/i, "").trim();
}

function sanitizeCaptureFileName(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = normalizeCaptureFileName(value);
  if (normalized.length === 0 || INVALID_CAPTURE_FILE_NAME_PATTERN.test(normalized)) {
    return fallback;
  }

  return normalized;
}

function sanitizeCaptureDirectory(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallback;
  }

  const resolved = path.resolve(trimmed);
  if (!fs.existsSync(resolved)) {
    return fallback;
  }

  try {
    return fs.statSync(resolved).isDirectory() ? resolved : fallback;
  } catch {
    return fallback;
  }
}

function migrateLegacySettingsIfNeeded(): void {
  const userDataPath = app.getPath("userData");
  const currentSettingsPath = path.join(userDataPath, SETTINGS_FILE_NAME);
  if (fs.existsSync(currentSettingsPath)) {
    return;
  }

  const legacyUserDataPath = path.join(path.dirname(userDataPath), LEGACY_USER_DATA_DIR);
  const legacySettingsPath = path.join(legacyUserDataPath, SETTINGS_FILE_NAME);
  if (!fs.existsSync(legacySettingsPath)) {
    return;
  }

  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.copyFileSync(legacySettingsPath, currentSettingsPath);
  } catch (error) {
    console.error("Failed to migrate legacy settings:", error);
  }
}

function sanitizeSettings(next: AppSettings): AppSettings {
  const defaultCaptureDirectory = path.resolve(app.getPath("downloads"));
  const displayModeWidths = sanitizeDisplayModeWidths(
    next.wideModeWidth,
    next.narrowModeWidth,
    DEFAULT_SETTINGS.wideModeWidth,
    DEFAULT_SETTINGS.narrowModeWidth
  );
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
    ),
    captureIntervalMin: sanitizeCaptureIntervalMin(
      next.captureIntervalMin,
      DEFAULT_SETTINGS.captureIntervalMin
    ),
    captureFileName: sanitizeCaptureFileName(next.captureFileName, DEFAULT_SETTINGS.captureFileName),
    captureDirectory: sanitizeCaptureDirectory(next.captureDirectory, defaultCaptureDirectory),
    wideModeWidth: displayModeWidths.wideModeWidth,
    narrowModeWidth: displayModeWidths.narrowModeWidth
  };

  return {
    ...base,
    cardWidth: Math.max(MIN_CARD_WIDTH, base.cardWidth || DEFAULT_SETTINGS.cardWidth),
    cardHeight: Math.max(MIN_CARD_HEIGHT, base.cardHeight || DEFAULT_SETTINGS.cardHeight),
    windowWidth: Math.max(MIN_WINDOW_WIDTH, base.windowWidth || DEFAULT_SETTINGS.windowWidth),
    windowHeight: Math.max(MIN_WINDOW_HEIGHT, base.windowHeight || DEFAULT_SETTINGS.windowHeight)
  };
}

function extractLocalSettings(source: AppSettings): WindowLocalSettings {
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

function sanitizeLocalSettings(next: WindowLocalSettings): WindowLocalSettings {
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

function sameLocalSettings(a: WindowLocalSettings, b: WindowLocalSettings): boolean {
  return (
    a.alwaysOnTop === b.alwaysOnTop &&
    a.cardWidth === b.cardWidth &&
    a.cardHeight === b.cardHeight &&
    a.windowWidth === b.windowWidth &&
    a.windowHeight === b.windowHeight &&
    a.windowX === b.windowX &&
    a.windowY === b.windowY &&
    a.widthResizeOrigin === b.widthResizeOrigin
  );
}

function mergeLocalSettingsIntoDefaults(
  local: WindowLocalSettings,
  options?: { includePosition?: boolean }
): void {
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

function composeSettings(context: WindowContext): AppSettings {
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
    widthResizeOrigin: context.local.widthResizeOrigin,
    captureIntervalMin: settings.captureIntervalMin,
    captureFileName: settings.captureFileName,
    captureDirectory: settings.captureDirectory,
    wideModeWidth: settings.wideModeWidth,
    narrowModeWidth: settings.narrowModeWidth
  };
}

function computeLayout(windowWidth: number, windowHeight: number): LayoutMetrics {
  const safeWindowWidth = Math.max(1, Math.round(windowWidth));
  const safeWindowHeight = Math.max(1, Math.round(windowHeight));
  const availableCardWidth = Math.max(1, safeWindowWidth - WINDOW_PADDING * 2);
  const minimumCardWidthFromWideMode = Math.max(
    MIN_CARD_WIDTH,
    Math.max(1, settings.wideModeWidth - WINDOW_PADDING * 2)
  );
  const cardWidth = Math.max(availableCardWidth, minimumCardWidthFromWideMode);
  const cardHeight = Math.max(1, safeWindowHeight - HEADER_HEIGHT - WINDOW_PADDING * 2);
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

function emitSettingsChanged(context: WindowContext): void {
  if (!context.window.webContents.isDestroyed()) {
    context.window.webContents.send("settings:changed", composeSettings(context));
  }
}

function broadcastLayout(context: WindowContext): void {
  if (context.window.isDestroyed() || context.tradingView.webContents.isDestroyed()) {
    return;
  }

  const [windowWidth, windowHeight] = context.window.getContentSize();
  context.latestLayout = computeLayout(windowWidth, windowHeight);

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

function applyWindowAppearance(context: WindowContext, emit = true): void {
  context.window.setAlwaysOnTop(context.local.alwaysOnTop);
  context.window.setBackgroundColor(settings.theme === "dark" ? "#0d1217" : "#edf3f7");

  if (emit) {
    emitSettingsChanged(context);
  }
}

function applyThemeAndWindowFlags(): void {
  nativeTheme.themeSource = settings.theme;
  for (const context of windowContexts.values()) {
    applyWindowAppearance(context, true);
  }
}

function composeCaptureState(): CaptureState {
  return {
    activeWindowId: activeCaptureWindowId
  };
}

function emitCaptureStateChanged(): void {
  const payload = composeCaptureState();
  for (const context of windowContexts.values()) {
    try {
      if (context.window.isDestroyed()) {
        continue;
      }

      const webContents = context.window.webContents;
      if (webContents.isDestroyed()) {
        continue;
      }

      webContents.send("capture:state:changed", payload);
    } catch {
      // Ignore races while windows are being torn down.
    }
  }
}

function clearCaptureTimer(): void {
  if (captureTimer) {
    clearTimeout(captureTimer);
    captureTimer = null;
  }
}

function resolveActiveCaptureContext(): WindowContext | null {
  if (activeCaptureWindowId === null) {
    return null;
  }

  return windowContexts.get(activeCaptureWindowId) ?? null;
}

function computeNextCaptureTime(now: Date, intervalMin: CaptureIntervalMin): Date {
  const minute = now.getMinutes();
  const remainder = minute % intervalMin;
  const minutesUntilNext = remainder === 0 ? intervalMin : intervalMin - remainder;

  const nextCaptureTime = new Date(now.getTime());
  nextCaptureTime.setSeconds(0, 0);
  nextCaptureTime.setMinutes(nextCaptureTime.getMinutes() + minutesUntilNext);
  nextCaptureTime.setSeconds(CAPTURE_MARGIN_SECONDS, 0);
  return nextCaptureTime;
}

function stopPeriodicCapture(options?: { emit?: boolean }): void {
  clearCaptureTimer();
  activeCaptureWindowId = null;
  capturePaused = false;
  if (options?.emit ?? true) {
    emitCaptureStateChanged();
  }
}

async function captureAndSave(context: WindowContext): Promise<void> {
  if (context.tradingView.webContents.isDestroyed()) {
    return;
  }

  const image = await context.tradingView.webContents.capturePage();
  const captureFilePath = path.join(settings.captureDirectory, `${settings.captureFileName}.png`);
  await fs.promises.writeFile(captureFilePath, image.toPNG());
}

function scheduleNextCapture(): void {
  clearCaptureTimer();
  if (activeCaptureWindowId === null || capturePaused) {
    return;
  }

  const context = resolveActiveCaptureContext();
  if (!context) {
    stopPeriodicCapture();
    return;
  }

  const now = new Date();
  const nextCaptureTime = computeNextCaptureTime(now, settings.captureIntervalMin);
  const delayMs = Math.max(50, nextCaptureTime.getTime() - now.getTime());

  captureTimer = setTimeout(() => {
    captureTimer = null;
    void executeCaptureAndScheduleNext();
  }, delayMs);
}

async function executeCaptureAndScheduleNext(): Promise<void> {
  const context = resolveActiveCaptureContext();
  if (!context) {
    stopPeriodicCapture();
    return;
  }

  if (capturePaused) {
    return;
  }

  try {
    await captureAndSave(context);
  } catch (error) {
    console.error("Failed to capture periodic screenshot:", error);
  } finally {
    scheduleNextCapture();
  }
}

function setCapturePausedForContext(context: WindowContext, paused: boolean): void {
  if (activeCaptureWindowId !== context.window.id) {
    return;
  }

  const nextPaused = Boolean(paused);
  if (capturePaused === nextPaused) {
    return;
  }

  capturePaused = nextPaused;
  if (capturePaused) {
    clearCaptureTimer();
  } else {
    scheduleNextCapture();
  }
  emitCaptureStateChanged();
}

function togglePeriodicCapture(context: WindowContext): CaptureToggleResult {
  if (activeCaptureWindowId === null) {
    activeCaptureWindowId = context.window.id;
    capturePaused = context.tradingViewSuspended;
    if (!capturePaused) {
      scheduleNextCapture();
    }
    emitCaptureStateChanged();
    return { status: "started" };
  }

  if (activeCaptureWindowId === context.window.id) {
    stopPeriodicCapture();
    return { status: "stopped" };
  }

  return {
    status: "blocked",
    reason: "another-window"
  };
}

function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).protocol === "https:";
  } catch {
    return false;
  }
}

function resolveInitialTradingViewUrl(initialUrl?: string): string {
  return initialUrl && isAllowedExternalUrl(initialUrl) ? initialUrl : settings.siteUrl;
}

function loadTradingViewTarget(context: WindowContext, url: string): void {
  if (context.tradingView.webContents.isDestroyed()) {
    return;
  }

  void context.tradingView.webContents.loadURL(url).catch((error: unknown) => {
    console.error("Failed to load site URL:", error);
  });
}

function loadTradingViewTargets(url: string): void {
  for (const context of windowContexts.values()) {
    loadTradingViewTarget(context, url);
  }
}

function resolveWindowContext(event: IpcMainInvokeEvent): WindowContext | null {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow) {
    return null;
  }
  return windowContexts.get(senderWindow.id) ?? null;
}

function requireWindowContext(event: IpcMainInvokeEvent): WindowContext {
  const context = resolveWindowContext(event);
  if (!context) {
    throw new Error("Window context is not available.");
  }
  return context;
}

function resolveSourceContext(sourceWindowId?: number): WindowContext | null {
  if (typeof sourceWindowId === "number") {
    return windowContexts.get(sourceWindowId) ?? null;
  }

  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (!focusedWindow) {
    return null;
  }
  return windowContexts.get(focusedWindow.id) ?? null;
}

function updateWindowSizeInLocalSettings(context: WindowContext): void {
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

function updateWindowPositionInLocalSettings(context: WindowContext): void {
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

function captureWindowSnapshot(context: WindowContext): void {
  try {
    updateWindowSizeInLocalSettings(context);
    updateWindowPositionInLocalSettings(context);
    lastClosedLocalSnapshot = { ...context.local };
  } catch (error) {
    console.error("Failed to capture window snapshot:", error);
  }
}

function clampBoundsToDisplayWorkArea(bounds: Rectangle): Rectangle {
  const display = screen.getDisplayMatching(bounds);
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

function createAppWindow(sourceWindowId?: number, initialUrl?: string): BrowserWindow {
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

  const windowOptions: Electron.BrowserWindowConstructorOptions = {
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
      preload: path.join(__dirname, "renderer-preload.js"),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false
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

  const windowRef = new BrowserWindow(windowOptions);

  const tradingView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      partition: TRADINGVIEW_PARTITION
    }
  });

  const context: WindowContext = {
    window: windowRef,
    tradingView,
    local,
    latestLayout: null,
    tradingViewSuspended: false,
    allowCloseAfterCaptureConfirm: false
  };

  windowContexts.set(windowRef.id, context);
  windowRef.contentView.addChildView(tradingView);

  tradingView.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      loadTradingViewTarget(context, url);
    }
    return { action: "deny" };
  });

  loadTradingViewTarget(context, resolveInitialTradingViewUrl(initialUrl));
  void windowRef.loadFile(path.join(__dirname, "../renderer/index.html"));

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

  windowRef.on("close", (event) => {
    const captureEnabledOnThisWindow = activeCaptureWindowId === windowRef.id;
    if (captureEnabledOnThisWindow && !context.allowCloseAfterCaptureConfirm) {
      event.preventDefault();

      const choice = dialog.showMessageBoxSync(windowRef, {
        type: "question",
        buttons: ["No", "Yes"],
        defaultId: 0,
        cancelId: 0,
        textWidth: 360,
        message:
          "Periodic\u00a0Screen\u00a0Capture\u00a0is\u00a0enabled.\nDo\u00a0you\u00a0want\u00a0to\u00a0close\u00a0this\u00a0window\u00a0?"
      });

      if (choice !== 1) {
        return;
      }

      context.allowCloseAfterCaptureConfirm = true;
      stopPeriodicCapture({ emit: false });
      emitCaptureStateChanged();
      windowRef.close();
      return;
    }

    captureWindowSnapshot(context);
  });

  windowRef.on("closed", () => {
    const wasCaptureEnabledOnThisWindow = activeCaptureWindowId === windowRef.id;
    lastClosedLocalSnapshot = { ...context.local };
    windowContexts.delete(windowRef.id);

    if (wasCaptureEnabledOnThisWindow) {
      stopPeriodicCapture({ emit: false });
      emitCaptureStateChanged();
    }
  });

  windowRef.webContents.on("did-finish-load", () => {
    applyWindowAppearance(context, true);
    broadcastLayout(context);
    emitCaptureStateChanged();
  });

  return windowRef;
}

function createApplicationMenu(): void {
  const newWindowMenuItem: MenuItemConstructorOptions = {
    label: "New Window",
    accelerator: process.platform === "darwin" ? "Command+N" : "CommandOrControl+N",
    click: () => {
      const focusedWindow = BrowserWindow.getFocusedWindow();
      createAppWindow(focusedWindow?.id);
    }
  };

  const template: MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [
          { role: "appMenu" },
          {
            label: "File",
            submenu: [newWindowMenuItem, { type: "separator" }, { role: "close" }]
          },
          { role: "editMenu" },
          { role: "windowMenu" }
        ]
      : [
          {
            label: "File",
            submenu: [newWindowMenuItem, { type: "separator" }, { role: "quit" }]
          }
        ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc(): void {
  if (ipcRegistered) {
    return;
  }
  ipcRegistered = true;

  ipcMain.handle("window:create", (event) => {
    const source = resolveWindowContext(event);
    createAppWindow(source?.window.id);
  });

  ipcMain.handle("window:get-id", (event) => {
    const context = requireWindowContext(event);
    return context.window.id;
  });

  ipcMain.handle("settings:get", (event) => {
    const context = requireWindowContext(event);
    return composeSettings(context);
  });

  ipcMain.handle("settings:update", (event, patch: Partial<AppSettings>) => {
    const context = requireWindowContext(event);

    const nextTheme = sanitizeTheme(patch.theme, settings.theme);
    const nextSiteUrl = sanitizeSiteUrl(patch.siteUrl, settings.siteUrl);
    const nextCaptureIntervalMin = sanitizeCaptureIntervalMin(
      patch.captureIntervalMin,
      settings.captureIntervalMin
    );
    const nextCaptureFileName = sanitizeCaptureFileName(
      patch.captureFileName,
      settings.captureFileName
    );
    const nextCaptureDirectory = sanitizeCaptureDirectory(
      patch.captureDirectory,
      settings.captureDirectory
    );
    const nextDisplayModeWidths = sanitizeDisplayModeWidths(
      patch.wideModeWidth,
      patch.narrowModeWidth,
      settings.wideModeWidth,
      settings.narrowModeWidth
    );

    let globalChanged = false;
    let wideModeWidthChanged = false;
    let captureSettingsChanged = false;
    if (nextTheme !== settings.theme) {
      settings = { ...settings, theme: nextTheme };
      globalChanged = true;
    }

    const previousSiteUrl = settings.siteUrl;
    if (nextSiteUrl !== settings.siteUrl) {
      settings = { ...settings, siteUrl: nextSiteUrl };
      globalChanged = true;
    }

    if (nextCaptureIntervalMin !== settings.captureIntervalMin) {
      settings = { ...settings, captureIntervalMin: nextCaptureIntervalMin };
      globalChanged = true;
      captureSettingsChanged = true;
    }

    if (nextCaptureFileName !== settings.captureFileName) {
      settings = { ...settings, captureFileName: nextCaptureFileName };
      globalChanged = true;
      captureSettingsChanged = true;
    }

    if (nextCaptureDirectory !== settings.captureDirectory) {
      settings = { ...settings, captureDirectory: nextCaptureDirectory };
      globalChanged = true;
      captureSettingsChanged = true;
    }

    if (
      nextDisplayModeWidths.wideModeWidth !== settings.wideModeWidth ||
      nextDisplayModeWidths.narrowModeWidth !== settings.narrowModeWidth
    ) {
      wideModeWidthChanged = nextDisplayModeWidths.wideModeWidth !== settings.wideModeWidth;
      settings = {
        ...settings,
        wideModeWidth: nextDisplayModeWidths.wideModeWidth,
        narrowModeWidth: nextDisplayModeWidths.narrowModeWidth
      };
      globalChanged = true;
    }

    const localPatchProvided =
      typeof patch.alwaysOnTop === "boolean" ||
      patch.cardWidth !== undefined ||
      patch.cardHeight !== undefined ||
      patch.windowWidth !== undefined ||
      patch.windowHeight !== undefined ||
      patch.windowX !== undefined ||
      patch.windowY !== undefined ||
      patch.widthResizeOrigin !== undefined;

    let localChanged = false;
    if (localPatchProvided) {
      const nextLocal = sanitizeLocalSettings({
        alwaysOnTop:
          typeof patch.alwaysOnTop === "boolean" ? patch.alwaysOnTop : context.local.alwaysOnTop,
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
      if (!wideModeWidthChanged) {
        broadcastLayout(context);
      }
    }

    if (settings.siteUrl !== previousSiteUrl) {
      loadTradingViewTargets(settings.siteUrl);
    }

    if (captureSettingsChanged && activeCaptureWindowId !== null && !capturePaused) {
      scheduleNextCapture();
    }

    if (wideModeWidthChanged) {
      for (const windowContext of windowContexts.values()) {
        broadcastLayout(windowContext);
      }
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

  ipcMain.handle("card:resize", (event, payload: { width: number; height: number }) => {
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

  ipcMain.handle("layout:get", (event) => {
    const context = requireWindowContext(event);
    if (!context.latestLayout) {
      const [windowWidth, windowHeight] = context.window.getContentSize();
      context.latestLayout = computeLayout(windowWidth, windowHeight);
    }
    return context.latestLayout;
  });

  ipcMain.handle("trading-view:set-suspended", (event, suspended: boolean) => {
    const context = requireWindowContext(event);
    context.tradingViewSuspended = Boolean(suspended);
    setCapturePausedForContext(context, context.tradingViewSuspended);
    broadcastLayout(context);
  });

  ipcMain.handle("capture:directory:pick", async (event) => {
    const context = requireWindowContext(event);
    const { canceled, filePaths } = await dialog.showOpenDialog(context.window, {
      title: "Select Capture Directory",
      defaultPath: settings.captureDirectory,
      properties: ["openDirectory"]
    });

    if (canceled || filePaths.length === 0) {
      return null;
    }

    return sanitizeCaptureDirectory(filePaths[0], settings.captureDirectory);
  });

  ipcMain.handle("capture:toggle", (event) => {
    const context = requireWindowContext(event);
    return togglePeriodicCapture(context);
  });

  ipcMain.handle("capture:state:get", (event) => {
    requireWindowContext(event);
    return composeCaptureState();
  });

  ipcMain.handle(
    "window:set-width",
    (event, payload: { width: number; origin: WidthResizeOrigin }) => {
      const context = requireWindowContext(event);

      const requestedWidth = Math.round(safeNumber(payload?.width, 0));
      const origin = sanitizeWidthResizeOrigin(payload?.origin, context.local.widthResizeOrigin);
      const [minimumWidth] = context.window.getMinimumSize();
      const targetWidth = Math.max(minimumWidth, requestedWidth);
      const currentBounds = context.window.getContentBounds();
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

void app.whenReady().then(() => {
  migrateLegacySettingsIfNeeded();
  settings = sanitizeSettings(loadSettings(app.getPath("userData")));
  nativeTheme.themeSource = settings.theme;

  registerIpc();
  createApplicationMenu();
  createAppWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createAppWindow();
    }
  });
});

app.on("window-all-closed", () => {
  stopPeriodicCapture({ emit: false });

  if (lastClosedLocalSnapshot) {
    mergeLocalSettingsIntoDefaults(lastClosedLocalSnapshot, { includePosition: true });
    flushSettings();
  }
  lastClosedLocalSnapshot = null;

  if (process.platform !== "darwin") {
    app.quit();
  }
});
