import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, type CloseRequestedEvent } from "@tauri-apps/api/window";
import { confirm, message, open } from "@tauri-apps/plugin-dialog";

type ThemeMode = "dark" | "light";
type WidthResizeOrigin = "right" | "left";
type CaptureInterval = 1 | 5 | 15 | 30 | 60 | 240;

interface AppSettings {
  theme: ThemeMode;
  alwaysOnTop: boolean;
  siteUrl: string;
  cardWidth: number;
  cardHeight: number;
  windowWidth: number;
  windowHeight: number;
  windowX: number | null;
  windowY: number | null;
  widthResizeOrigin: WidthResizeOrigin;
  captureIntervalMin: CaptureInterval;
  captureFileName: string;
  captureDirectory: string;
  wideModeWidth: number;
  narrowModeWidth: number;
}

interface LayoutMetrics {
  headerHeight: number;
  cardX: number;
  cardY: number;
  cardWidth: number;
  cardHeight: number;
}

interface CaptureState {
  activeWindowLabel: string | null;
  paused: boolean;
}

interface CaptureToggleResult {
  status: "started" | "stopped" | "blocked";
  reason?: "another-window";
}

interface InitializationTask {
  name: string;
  run: () => Promise<unknown>;
}

const appWindow = getCurrentWindow();
const CAPTURE_INTERVALS: readonly CaptureInterval[] = [1, 5, 15, 30, 60, 240];
const INVALID_FILE_NAME = /[<>:"/\\|?*\u0000-\u001f]/;

function element<T extends Element>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return result;
}

const clock = element<HTMLElement>("#clock");
const cardFrame = element<HTMLElement>("#card-frame");
const captureButton = element<HTMLButtonElement>("#capture-button");
const captureTooltip = element<HTMLElement>("#capture-tooltip");
const newWindowButton = element<HTMLButtonElement>("#new-window-button");
const widthButton = element<HTMLButtonElement>("#width-button");
const widthOrigin = element<HTMLSelectElement>("#width-origin");
const alwaysOnTop = element<HTMLInputElement>("#always-on-top");
const settingsButton = element<HTMLButtonElement>("#settings-button");
const settingsDialog = element<HTMLDialogElement>("#settings-dialog");
const settingsForm = element<HTMLFormElement>("#settings-form");
const cancelButton = element<HTMLButtonElement>("#cancel-button");
const theme = element<HTMLSelectElement>("#theme");
const siteUrl = element<HTMLInputElement>("#site-url");
const wideModeWidth = element<HTMLInputElement>("#wide-mode-width");
const narrowModeWidth = element<HTMLInputElement>("#narrow-mode-width");
const captureFileName = element<HTMLInputElement>("#capture-file-name");
const captureDirectory = element<HTMLInputElement>("#capture-directory");
const browseButton = element<HTMLButtonElement>("#browse-button");
const siteUrlError = element<HTMLElement>("#site-url-error");
const displayWidthError = element<HTMLElement>("#display-width-error");
const captureFileNameError = element<HTMLElement>("#capture-file-name-error");
const captureDirectoryError = element<HTMLElement>("#capture-directory-error");
const intervalInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="captureInterval"]'),
);

let currentSettings: AppSettings | null = null;
let currentCaptureState: CaptureState = {
  activeWindowLabel: null,
  paused: false,
};
let captureStateInitialized = false;
let tooltipTimer: number | null = null;
let allowClose = false;
let settingsOpening = false;
let tradingViewTransition: Promise<void> = Promise.resolve();

const jstFormatter = new Intl.DateTimeFormat("ja-JP", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Tokyo",
});

function updateClock(): void {
  clock.textContent = `${jstFormatter.format(new Date())} JST`;
}

function scheduleClock(): void {
  updateClock();
  const now = new Date();
  const delay = 60_000 - (now.getSeconds() * 1_000 + now.getMilliseconds());
  window.setTimeout(scheduleClock, Math.max(100, delay));
}

function clearErrors(): void {
  siteUrlError.textContent = "";
  displayWidthError.textContent = "";
  captureFileNameError.textContent = "";
  captureDirectoryError.textContent = "";
}

function normalizeFileName(raw: string): string {
  return raw.trim().replace(/(?:\.png)+$/i, "").trim();
}

function selectedInterval(): CaptureInterval {
  const value = Number(intervalInputs.find((input) => input.checked)?.value ?? 5);
  return CAPTURE_INTERVALS.includes(value as CaptureInterval) ? (value as CaptureInterval) : 5;
}

function applyLayout(layout: LayoutMetrics): void {
  cardFrame.style.left = `${layout.cardX}px`;
  cardFrame.style.top = `${layout.cardY}px`;
  cardFrame.style.width = `${layout.cardWidth}px`;
  cardFrame.style.height = `${layout.cardHeight}px`;
}

function updateWidthButton(): void {
  if (!currentSettings) {
    return;
  }
  const currentWidth = Math.round(window.innerWidth);
  const isWide = currentWidth === Math.round(currentSettings.wideModeWidth);
  const target = isWide ? currentSettings.narrowModeWidth : currentSettings.wideModeWidth;
  widthButton.setAttribute("aria-pressed", String(isWide));
  widthButton.title = `Set width to ${target}`;
  widthButton.setAttribute("aria-label", `Toggle Window Width (Set width to ${target})`);
}

function applySettings(settings: AppSettings): void {
  currentSettings = settings;
  document.body.dataset.theme = settings.theme;
  theme.value = settings.theme;
  alwaysOnTop.checked = settings.alwaysOnTop;
  widthOrigin.value = settings.widthResizeOrigin;
  siteUrl.value = settings.siteUrl;
  wideModeWidth.value = String(Math.round(settings.wideModeWidth));
  narrowModeWidth.value = String(Math.round(settings.narrowModeWidth));
  captureFileName.value = settings.captureFileName;
  captureDirectory.value = settings.captureDirectory;
  for (const input of intervalInputs) {
    input.checked = Number(input.value) === settings.captureIntervalMin;
  }
  updateWidthButton();
}

function showCaptureTooltip(message: string): void {
  captureTooltip.textContent = message;
  captureTooltip.dataset.visible = "true";
  captureTooltip.setAttribute("aria-hidden", "false");
  if (tooltipTimer !== null) {
    window.clearTimeout(tooltipTimer);
  }
  tooltipTimer = window.setTimeout(() => {
    captureTooltip.dataset.visible = "false";
    captureTooltip.setAttribute("aria-hidden", "true");
    tooltipTimer = null;
  }, 2_000);
}

function applyCaptureState(state: CaptureState): void {
  currentCaptureState = state;
  const activeHere = state.activeWindowLabel === appWindow.label;
  captureButton.setAttribute("aria-pressed", String(activeHere));
}

async function suspendTradingView(suspended: boolean): Promise<void> {
  await invoke("set_trading_view_suspended", { suspended });
}

function queueTradingViewSuspension(suspended: boolean): Promise<void> {
  const operation = tradingViewTransition.then(() => suspendTradingView(suspended));
  tradingViewTransition = operation.catch(() => undefined);
  return operation;
}

async function restoreTradingViewAfterSettings(): Promise<void> {
  try {
    await queueTradingViewSuspension(false);
  } catch (error) {
    console.error("Failed to restore TradingView after Settings closed:", error);
  }
}

function validateSettings(): {
  theme: ThemeMode;
  siteUrl: string;
  wideModeWidth: number;
  narrowModeWidth: number;
  captureIntervalMin: CaptureInterval;
  captureFileName: string;
  captureDirectory: string;
} | null {
  clearErrors();
  let valid = true;
  const trimmedUrl = siteUrl.value.trim();
  try {
    const parsed = new URL(trimmedUrl);
    if (parsed.protocol !== "https:") {
      throw new Error();
    }
  } catch {
    siteUrlError.textContent = "Site URL must be a valid https:// URL.";
    valid = false;
  }

  const wideText = wideModeWidth.value.trim();
  const narrowText = narrowModeWidth.value.trim();
  const wide = Number(wideText);
  const narrow = Number(narrowText);
  if (
    !/^\d+$/.test(wideText) ||
    !/^\d+$/.test(narrowText) ||
    !Number.isSafeInteger(wide) ||
    !Number.isSafeInteger(narrow) ||
    narrow < 320 ||
    wide <= narrow
  ) {
    displayWidthError.textContent =
      "Use integers of 320px or greater, with wide mode greater than narrow mode.";
    valid = false;
  }

  const fileName = normalizeFileName(captureFileName.value);
  if (!fileName || INVALID_FILE_NAME.test(fileName)) {
    captureFileNameError.textContent = "File Name is required and must not contain invalid characters.";
    valid = false;
  }

  const directory = captureDirectory.value.trim();
  if (!directory) {
    captureDirectoryError.textContent = "Download destination is required.";
    valid = false;
  }

  if (!valid) {
    return null;
  }
  return {
    theme: theme.value === "light" ? "light" : "dark",
    siteUrl: trimmedUrl,
    wideModeWidth: wide,
    narrowModeWidth: narrow,
    captureIntervalMin: selectedInterval(),
    captureFileName: fileName,
    captureDirectory: directory,
  };
}

async function openSettings(): Promise<void> {
  if (!currentSettings || settingsDialog.open || settingsOpening) {
    return;
  }
  settingsOpening = true;
  settingsButton.disabled = true;
  try {
    applySettings(currentSettings);
    clearErrors();
    await queueTradingViewSuspension(true);
    settingsDialog.showModal();
  } catch (error) {
    console.error("Failed to open Settings safely:", error);
    await restoreTradingViewAfterSettings();
  } finally {
    settingsOpening = false;
    settingsButton.disabled = false;
  }
}

function reportToolbarError(action: string, error: unknown): void {
  console.error(`${action} failed:`, error);
}

async function toggleCapture(): Promise<void> {
  try {
    const result = await invoke<CaptureToggleResult>("toggle_periodic_capture");
    if (result.status === "blocked") {
      showCaptureTooltip("Capturing on another window");
    }
  } catch (error) {
    reportToolbarError("Periodic capture toggle", error);
    showCaptureTooltip(String(error));
  }
}

async function createNewWindow(): Promise<void> {
  try {
    await invoke("create_window");
  } catch (error) {
    reportToolbarError("New window creation", error);
  }
}

async function toggleWindowWidth(): Promise<void> {
  if (!currentSettings) {
    return;
  }
  const isWide = Math.round(window.innerWidth) === Math.round(currentSettings.wideModeWidth);
  const width = isWide ? currentSettings.narrowModeWidth : currentSettings.wideModeWidth;
  try {
    const updated = await invoke<AppSettings>("set_window_width", {
      width,
      origin: widthOrigin.value === "left" ? "left" : "right",
    });
    applySettings(updated);
  } catch (error) {
    reportToolbarError("Window width toggle", error);
  }
}

captureButton.addEventListener("click", () => {
  void toggleCapture();
});

newWindowButton.addEventListener("click", () => {
  void createNewWindow();
});

widthButton.addEventListener("click", () => {
  void toggleWindowWidth();
});

widthOrigin.addEventListener("change", async () => {
  const previousOrigin = currentSettings?.widthResizeOrigin ?? "right";
  try {
    const updated = await invoke<AppSettings>("update_settings", {
      patch: {
        widthResizeOrigin: widthOrigin.value === "left" ? "left" : "right",
      },
    });
    applySettings(updated);
  } catch (error) {
    widthOrigin.value = previousOrigin;
    reportToolbarError("Width resize origin update", error);
  }
});

alwaysOnTop.addEventListener("change", async () => {
  const previousValue = currentSettings?.alwaysOnTop ?? !alwaysOnTop.checked;
  try {
    const updated = await invoke<AppSettings>("update_settings", {
      patch: { alwaysOnTop: alwaysOnTop.checked },
    });
    applySettings(updated);
  } catch (error) {
    alwaysOnTop.checked = previousValue;
    reportToolbarError("Always on Top update", error);
  }
});

settingsButton.addEventListener("click", () => {
  void openSettings();
});

cancelButton.addEventListener("click", () => {
  settingsDialog.close();
});

settingsDialog.addEventListener("close", () => {
  void restoreTradingViewAfterSettings();
});

async function chooseCaptureDirectory(): Promise<void> {
  if (browseButton.disabled) {
    return;
  }
  browseButton.disabled = true;
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: captureDirectory.value.trim() || undefined,
      title: "Select Capture Directory",
    });
    if (typeof selected === "string" && settingsDialog.open) {
      captureDirectory.value = selected;
      captureDirectoryError.textContent = "";
    }
  } catch (error) {
    console.error("Failed to open capture directory picker:", error);
    if (settingsDialog.open) {
      captureDirectoryError.textContent = `Could not open directory picker: ${String(error)}`;
    }
  } finally {
    browseButton.disabled = false;
  }
}

browseButton.addEventListener("click", () => {
  void chooseCaptureDirectory();
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = validateSettings();
  if (!values) {
    return;
  }
  try {
    const updated = await invoke<AppSettings>("update_settings", { patch: values });
    if (updated.captureDirectory !== values.captureDirectory) {
      captureDirectoryError.textContent = "Download destination must be an existing directory.";
      return;
    }
    applySettings(updated);
    settingsDialog.close();
  } catch (error) {
    captureDirectoryError.textContent = String(error);
  }
});

window.addEventListener("resize", updateWidthButton);
window.addEventListener("keydown", (event) => {
  if (event.metaKey && event.key.toLowerCase() === "n") {
    event.preventDefault();
    void createNewWindow();
  }
});

async function runInitializationTasks(group: string, tasks: InitializationTask[]): Promise<void> {
  const results = await Promise.allSettled(
    tasks.map((task) => Promise.resolve().then(task.run)),
  );
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(`${group} failed (${tasks[index].name}):`, result.reason);
    }
  });
}

async function refreshCaptureState(): Promise<CaptureState> {
  const state = await invoke<CaptureState>("get_capture_state");
  applyCaptureState(state);
  captureStateInitialized = true;
  return state;
}

async function handleAppExitRequested(): Promise<void> {
  let shouldQuit = false;
  try {
    shouldQuit = await confirm(
      "Periodic Screen Capture is enabled.\nDo you want to quit the application?",
      {
        title: "TV Browser",
        kind: "warning",
        okLabel: "Yes",
        cancelLabel: "No",
      },
    );
  } catch (error) {
    console.error("Failed to show application exit confirmation:", error);
  }

  try {
    await invoke("resolve_app_exit", { shouldQuit });
  } catch (error) {
    console.error("Failed to resolve application exit request:", error);
  }
}

async function handleCloseRequested(event: CloseRequestedEvent): Promise<void> {
  if (allowClose) {
    return;
  }
  event.preventDefault();
  try {
    if (!captureStateInitialized) {
      await refreshCaptureState();
    }
    if (currentCaptureState.activeWindowLabel !== appWindow.label) {
      allowClose = true;
      try {
        await appWindow.close();
      } catch (error) {
        allowClose = false;
        throw error;
      }
      return;
    }
    const shouldClose = await confirm(
      "Periodic Screen Capture is enabled.\nDo you want to close this window?",
      {
        title: "TV Browser",
        kind: "warning",
        okLabel: "Yes",
        cancelLabel: "No",
      },
    );
    if (shouldClose) {
      await invoke("toggle_periodic_capture");
      allowClose = true;
      try {
        await appWindow.close();
      } catch (error) {
        allowClose = false;
        throw error;
      }
    }
  } catch (error) {
    console.error("Failed to handle window close request:", error);
  }
}

async function registerRuntimeHandlers(): Promise<void> {
  await runInitializationTasks("Runtime handler registration", [
    {
      name: "layout-changed",
      run: () =>
        listen<LayoutMetrics>("layout-changed", (event) => {
          applyLayout(event.payload);
        }),
    },
    {
      name: "settings-changed",
      run: () =>
        listen<AppSettings>("settings-changed", (event) => {
          applySettings(event.payload);
        }),
    },
    {
      name: "capture-state-changed",
      run: () =>
        listen<CaptureState>("capture-state-changed", (event) => {
          applyCaptureState(event.payload);
          captureStateInitialized = true;
        }),
    },
    {
      name: "capture-error",
      run: () =>
        listen<string>("capture-error", (event) => {
          console.error("Periodic capture failed:", event.payload);
        }),
    },
    {
      name: "settings-save-error",
      run: () =>
        listen<string>("settings-save-error", (event) => {
          console.error("Window settings save failed:", event.payload);
        }),
    },
    {
      name: "app-exit-requested",
      run: () => listen("app-exit-requested", handleAppExitRequested),
    },
    {
      name: "window-close-requested",
      run: () => appWindow.onCloseRequested(handleCloseRequested),
    },
  ]);
}

async function loadInitialState(): Promise<void> {
  await runInitializationTasks("Initial state loading", [
    {
      name: "startup warning",
      run: async () => {
        const warning = await invoke<string | null>("take_startup_warning");
        if (warning) {
          await message(warning, {
            title: "TV Browser",
            kind: "warning",
          });
        }
      },
    },
    {
      name: "settings",
      run: async () => {
        applySettings(await invoke<AppSettings>("get_settings"));
      },
    },
    {
      name: "layout",
      run: async () => {
        applyLayout(await invoke<LayoutMetrics>("get_layout"));
      },
    },
    {
      name: "capture state",
      run: refreshCaptureState,
    },
  ]);
}

async function initialize(): Promise<void> {
  try {
    scheduleClock();
  } catch (error) {
    console.error("Clock initialization failed:", error);
  }
  await registerRuntimeHandlers();
  await loadInitialState();
}

initialize().catch((error) => {
  console.error("TV Browser initialization failed:", error);
});
