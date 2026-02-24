import type {
  AppSettings,
  CaptureIntervalMin,
  CaptureState,
  LayoutMetrics,
  ThemeMode,
  WidthResizeOrigin
} from "../shared/types";

function mustQuery<TElement extends Element>(selector: string): TElement {
  const found = document.querySelector<TElement>(selector);
  if (!found) {
    throw new Error(`Renderer UI bootstrap failed: missing element ${selector}`);
  }
  return found;
}

const clockElement = mustQuery<HTMLSpanElement>("#clock");
const periodicCaptureButton = mustQuery<HTMLButtonElement>("#periodic-capture-button");
const captureBlockedTooltip = mustQuery<HTMLSpanElement>("#capture-blocked-tooltip");
const newWindowButton = mustQuery<HTMLButtonElement>("#new-window-button");
const toggleWidthButton = mustQuery<HTMLButtonElement>("#toggle-width-button");
const widthOriginSelect = mustQuery<HTMLSelectElement>("#width-origin-select");
const openSettingsButton = mustQuery<HTMLButtonElement>("#open-settings-button");
const settingsDialog = mustQuery<HTMLDialogElement>("#settings-dialog");
const settingsForm = mustQuery<HTMLFormElement>("#settings-form");
const settingsCancelButton = mustQuery<HTMLButtonElement>("#settings-cancel-button");
const themeSelect = mustQuery<HTMLSelectElement>("#theme-select");
const alwaysOnTopToggle = mustQuery<HTMLInputElement>("#always-on-top-toggle");
const siteUrlInput = mustQuery<HTMLInputElement>("#site-url-input");
const wideModeWidthInput = mustQuery<HTMLInputElement>("#wide-mode-width-input");
const narrowModeWidthInput = mustQuery<HTMLInputElement>("#narrow-mode-width-input");
const siteUrlError = mustQuery<HTMLParagraphElement>("#site-url-error");
const displayWidthError = mustQuery<HTMLParagraphElement>("#display-width-error");
const captureFileNameInput = mustQuery<HTMLInputElement>("#capture-file-name-input");
const captureFileNameError = mustQuery<HTMLParagraphElement>("#capture-file-name-error");
const captureDirectoryInput = mustQuery<HTMLInputElement>("#capture-directory-input");
const captureDirectoryBrowseButton = mustQuery<HTMLButtonElement>("#capture-directory-browse-button");
const captureDirectoryError = mustQuery<HTMLParagraphElement>("#capture-directory-error");
const cardFrame = mustQuery<HTMLElement>("#card-frame");
const captureIntervalInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="capture-interval-min"]')
);

if (captureIntervalInputs.length === 0) {
  throw new Error('Renderer UI bootstrap failed: missing capture interval radios "capture-interval-min".');
}

const SITE_URL_MAX_LENGTH = 64;
const BLOCKED_TOOLTIP_DURATION_MS = 2_000;
const INVALID_CAPTURE_FILE_NAME_PATTERN = /[<>:"/\\|?*\u0000-\u001f]/;
const CAPTURE_INTERVAL_OPTIONS: readonly CaptureIntervalMin[] = [1, 5, 15, 30, 60, 240];
const DEFAULT_WIDE_MODE_WIDTH = 1920;
const DEFAULT_NARROW_MODE_WIDTH = 425;
const MIN_DISPLAY_MODE_WIDTH = 320;

const jstFormatter = new Intl.DateTimeFormat("ja-JP", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Tokyo"
});

let currentSettings: AppSettings | null = null;
let currentWindowId: number | null = null;
let blockedTooltipTimer: number | null = null;

function setTheme(theme: ThemeMode): void {
  document.body.dataset.theme = theme;
}

function setSiteUrlError(message: string): void {
  siteUrlError.textContent = message;
}

function setDisplayWidthError(message: string): void {
  displayWidthError.textContent = message;
}

function setCaptureFileNameError(message: string): void {
  captureFileNameError.textContent = message;
}

function setCaptureDirectoryError(message: string): void {
  captureDirectoryError.textContent = message;
}

function normalizeCaptureFileName(rawValue: string): string {
  return rawValue.trim().replace(/(?:\.png)+$/i, "").trim();
}

function validateSiteUrl(rawValue: string): { ok: true; value: string } | { ok: false; message: string } {
  const value = rawValue.trim();
  if (value.length === 0) {
    return { ok: false, message: "Site URL is required." };
  }

  if (value.length > SITE_URL_MAX_LENGTH) {
    return { ok: false, message: `Site URL must be ${SITE_URL_MAX_LENGTH} characters or fewer.` };
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") {
      return { ok: false, message: "Site URL must start with https://." };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, message: "Site URL must be a valid URL." };
  }
}

function validateCaptureFileName(
  rawValue: string
): { ok: true; value: string } | { ok: false; message: string } {
  const normalized = normalizeCaptureFileName(rawValue);
  if (normalized.length === 0) {
    return { ok: false, message: "File Name is required." };
  }

  if (INVALID_CAPTURE_FILE_NAME_PATTERN.test(normalized)) {
    return { ok: false, message: "File Name contains invalid characters." };
  }

  return { ok: true, value: normalized };
}

function validateDisplayWidths(
  rawWideValue: string,
  rawNarrowValue: string
):
  | { ok: true; wideModeWidth: number; narrowModeWidth: number }
  | { ok: false; message: string } {
  const wideText = rawWideValue.trim();
  const narrowText = rawNarrowValue.trim();

  if (wideText.length === 0 || narrowText.length === 0) {
    return { ok: false, message: "Display Width values are required." };
  }

  if (!/^\d+$/.test(wideText) || !/^\d+$/.test(narrowText)) {
    return { ok: false, message: "Display Width values must be integers." };
  }

  const wideModeWidth = Number(wideText);
  const narrowModeWidth = Number(narrowText);
  if (!Number.isSafeInteger(wideModeWidth) || !Number.isSafeInteger(narrowModeWidth)) {
    return { ok: false, message: "Display Width values must be valid integers." };
  }

  if (wideModeWidth < MIN_DISPLAY_MODE_WIDTH || narrowModeWidth < MIN_DISPLAY_MODE_WIDTH) {
    return {
      ok: false,
      message: `Display Width values must be ${MIN_DISPLAY_MODE_WIDTH}px or greater.`
    };
  }

  if (wideModeWidth <= narrowModeWidth) {
    return { ok: false, message: "wide mode must be greater than narrow mode." };
  }

  return { ok: true, wideModeWidth, narrowModeWidth };
}

function normalizeDirectoryForCompare(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed === "/" || trimmed.length === 0) {
    return trimmed;
  }
  return trimmed.replace(/[\\/]+$/, "");
}

async function setSettingsModalOpen(isOpen: boolean): Promise<void> {
  try {
    await window.desktopApi.setTradingViewSuspended(isOpen);
  } catch (error) {
    console.error("Failed to toggle trading view visibility:", error);
  }
}

function updateClock(): void {
  clockElement.textContent = `${jstFormatter.format(new Date())} JST`;
}

function startClockTicker(): void {
  updateClock();

  const scheduleNextTick = (): void => {
    const now = new Date();
    const delayUntilNextMinute = 60_000 - (now.getSeconds() * 1_000 + now.getMilliseconds());
    setTimeout(() => {
      updateClock();
      scheduleNextTick();
    }, Math.max(100, delayUntilNextMinute));
  };

  scheduleNextTick();
}

function selectedWidthOrigin(): WidthResizeOrigin {
  return widthOriginSelect.value === "left" ? "left" : "right";
}

function selectedCaptureInterval(): CaptureIntervalMin {
  const selected = captureIntervalInputs.find((input) => input.checked);
  const numericValue = Number(selected?.value ?? DEFAULT_CAPTURE_INTERVAL);
  return CAPTURE_INTERVAL_OPTIONS.includes(numericValue as CaptureIntervalMin)
    ? (numericValue as CaptureIntervalMin)
    : DEFAULT_CAPTURE_INTERVAL;
}

const DEFAULT_CAPTURE_INTERVAL: CaptureIntervalMin = 5;

function currentDisplayWidthPresets(): { wideModeWidth: number; narrowModeWidth: number } {
  return {
    wideModeWidth: currentSettings?.wideModeWidth ?? DEFAULT_WIDE_MODE_WIDTH,
    narrowModeWidth: currentSettings?.narrowModeWidth ?? DEFAULT_NARROW_MODE_WIDTH
  };
}

function resolveWidthToggleTarget(windowWidth: number): number {
  const { wideModeWidth, narrowModeWidth } = currentDisplayWidthPresets();
  return windowWidth === wideModeWidth ? narrowModeWidth : wideModeWidth;
}

function currentWindowWidthForToggle(): number {
  const actualWidth = Math.round(window.innerWidth);
  if (actualWidth > 0) {
    return actualWidth;
  }
  const { narrowModeWidth } = currentDisplayWidthPresets();
  return currentSettings?.windowWidth ?? narrowModeWidth;
}

function applyWidthToggleButtonState(windowWidth: number): void {
  const { wideModeWidth } = currentDisplayWidthPresets();
  const isWide = windowWidth === wideModeWidth;
  const nextWidth = resolveWidthToggleTarget(windowWidth);
  const title = `Set width to ${nextWidth}`;

  toggleWidthButton.setAttribute("aria-pressed", isWide ? "true" : "false");
  toggleWidthButton.title = title;
  toggleWidthButton.setAttribute("aria-label", `Toggle Window Width (${title})`);
}

function applySettings(nextSettings: AppSettings): void {
  currentSettings = nextSettings;
  setTheme(nextSettings.theme);
  widthOriginSelect.value = nextSettings.widthResizeOrigin;
  themeSelect.value = nextSettings.theme;
  alwaysOnTopToggle.checked = nextSettings.alwaysOnTop;
  siteUrlInput.value = nextSettings.siteUrl;
  wideModeWidthInput.value = String(nextSettings.wideModeWidth);
  narrowModeWidthInput.value = String(nextSettings.narrowModeWidth);
  captureFileNameInput.value = nextSettings.captureFileName;
  captureDirectoryInput.value = nextSettings.captureDirectory;

  for (const input of captureIntervalInputs) {
    input.checked = Number(input.value) === nextSettings.captureIntervalMin;
  }

  applyWidthToggleButtonState(nextSettings.windowWidth);
}

function applyCaptureState(nextState: CaptureState): void {
  const activeOnThisWindow = currentWindowId !== null && nextState.activeWindowId === currentWindowId;
  periodicCaptureButton.setAttribute("aria-pressed", activeOnThisWindow ? "true" : "false");
}

function showCaptureBlockedTooltip(message: string): void {
  captureBlockedTooltip.textContent = message;
  captureBlockedTooltip.dataset.visible = "true";
  captureBlockedTooltip.setAttribute("aria-hidden", "false");

  if (blockedTooltipTimer !== null) {
    window.clearTimeout(blockedTooltipTimer);
  }

  blockedTooltipTimer = window.setTimeout(() => {
    captureBlockedTooltip.dataset.visible = "false";
    captureBlockedTooltip.setAttribute("aria-hidden", "true");
    blockedTooltipTimer = null;
  }, BLOCKED_TOOLTIP_DURATION_MS);
}

function clearSettingsErrors(): void {
  setSiteUrlError("");
  setDisplayWidthError("");
  setCaptureFileNameError("");
  setCaptureDirectoryError("");
}

function applyLayout(layout: LayoutMetrics): void {
  cardFrame.style.left = `${layout.cardX}px`;
  cardFrame.style.top = `${layout.cardY}px`;
  cardFrame.style.width = `${layout.cardWidth}px`;
  cardFrame.style.height = `${layout.cardHeight}px`;
}

function installEvents(): void {
  periodicCaptureButton.addEventListener("click", async () => {
    try {
      const result = await window.desktopApi.togglePeriodicCapture();
      if (result.status === "blocked") {
        showCaptureBlockedTooltip("Capturing on another window");
        return;
      }

      applyCaptureState(await window.desktopApi.getCaptureState());
    } catch (error) {
      console.error("Failed to toggle periodic capture:", error);
    }
  });

  newWindowButton.addEventListener("click", () => {
    void window.desktopApi.createWindow();
  });

  toggleWidthButton.addEventListener("click", () => {
    const width = resolveWidthToggleTarget(currentWindowWidthForToggle());
    void window.desktopApi.setWindowWidth({
      width,
      origin: selectedWidthOrigin()
    });
  });

  widthOriginSelect.addEventListener("change", async () => {
    const updated = await window.desktopApi.updateSettings({
      widthResizeOrigin: selectedWidthOrigin()
    });
    applySettings(updated);
  });

  alwaysOnTopToggle.addEventListener("change", async () => {
    const updated = await window.desktopApi.updateSettings({
      alwaysOnTop: alwaysOnTopToggle.checked
    });
    applySettings(updated);
  });

  openSettingsButton.addEventListener("click", () => {
    if (!settingsDialog.open) {
      if (currentSettings) {
        applySettings(currentSettings);
      }
      clearSettingsErrors();
      void setSettingsModalOpen(true).then(() => {
        try {
          settingsDialog.showModal();
        } catch {
          void setSettingsModalOpen(false);
        }
      });
    }
  });

  settingsCancelButton.addEventListener("click", () => {
    settingsDialog.close();
  });

  settingsDialog.addEventListener("close", () => {
    void setSettingsModalOpen(false);
    clearSettingsErrors();
    if (currentSettings) {
      applySettings(currentSettings);
    }
  });

  window.addEventListener("focus", () => {
    updateClock();
  });

  window.addEventListener("resize", () => {
    applyWidthToggleButtonState(currentWindowWidthForToggle());
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      updateClock();
    }
  });

  siteUrlInput.addEventListener("input", () => {
    if (siteUrlError.textContent) {
      setSiteUrlError("");
    }
  });

  wideModeWidthInput.addEventListener("input", () => {
    if (displayWidthError.textContent) {
      setDisplayWidthError("");
    }
  });

  narrowModeWidthInput.addEventListener("input", () => {
    if (displayWidthError.textContent) {
      setDisplayWidthError("");
    }
  });

  captureFileNameInput.addEventListener("input", () => {
    if (captureFileNameError.textContent) {
      setCaptureFileNameError("");
    }
  });

  captureDirectoryInput.addEventListener("input", () => {
    if (captureDirectoryError.textContent) {
      setCaptureDirectoryError("");
    }
  });

  captureDirectoryBrowseButton.addEventListener("click", async () => {
    const selected = await window.desktopApi.pickCaptureDirectory();
    if (!selected) {
      return;
    }

    captureDirectoryInput.value = selected;
    setCaptureDirectoryError("");
  });

  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const siteUrlResult = validateSiteUrl(siteUrlInput.value);
    if (!siteUrlResult.ok) {
      setSiteUrlError(siteUrlResult.message);
      return;
    }

    const displayWidthsResult = validateDisplayWidths(wideModeWidthInput.value, narrowModeWidthInput.value);
    if (!displayWidthsResult.ok) {
      setDisplayWidthError(displayWidthsResult.message);
      return;
    }

    const captureFileNameResult = validateCaptureFileName(captureFileNameInput.value);
    if (!captureFileNameResult.ok) {
      setCaptureFileNameError(captureFileNameResult.message);
      return;
    }

    const captureDirectory = captureDirectoryInput.value.trim();
    if (captureDirectory.length === 0) {
      setCaptureDirectoryError("Download directory is required.");
      return;
    }
    if (!captureDirectory.startsWith("/")) {
      setCaptureDirectoryError("Download directory must be an absolute path.");
      return;
    }

    try {
      clearSettingsErrors();
      const theme: ThemeMode = themeSelect.value === "light" ? "light" : "dark";
      const updated = await window.desktopApi.updateSettings({
        theme,
        siteUrl: siteUrlResult.value,
        wideModeWidth: displayWidthsResult.wideModeWidth,
        narrowModeWidth: displayWidthsResult.narrowModeWidth,
        captureIntervalMin: selectedCaptureInterval(),
        captureFileName: captureFileNameResult.value,
        captureDirectory
      });

      const requestedDirectory = normalizeDirectoryForCompare(captureDirectory);
      const updatedDirectory = normalizeDirectoryForCompare(updated.captureDirectory);
      if (requestedDirectory !== updatedDirectory) {
        setCaptureDirectoryError("Download directory must be an existing directory.");
        applySettings(updated);
        return;
      }

      if (updated.captureFileName !== captureFileNameResult.value) {
        setCaptureFileNameError("File Name contains invalid characters.");
        applySettings(updated);
        return;
      }

      applySettings(updated);
      settingsDialog.close();
    } catch {
      setSiteUrlError("Failed to save settings.");
    }
  });
}

async function bootstrap(): Promise<void> {
  installEvents();
  startClockTicker();

  const [windowId, settings, layout, captureState] = await Promise.all([
    window.desktopApi.getWindowId(),
    window.desktopApi.getSettings(),
    window.desktopApi.getLayout(),
    window.desktopApi.getCaptureState()
  ]);

  currentWindowId = windowId;
  applySettings(settings);
  applyCaptureState(captureState);

  if (layout) {
    applyLayout(layout);
  }

  window.desktopApi.onLayoutChanged((nextLayout) => {
    applyLayout(nextLayout);
  });

  window.desktopApi.onSettingsChanged((nextSettings) => {
    applySettings(nextSettings);
  });

  window.desktopApi.onCaptureStateChanged((nextState) => {
    applyCaptureState(nextState);
  });
}

void bootstrap();
