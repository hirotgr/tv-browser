import type { AppSettings, LayoutMetrics, ThemeMode, WidthResizeOrigin } from "../shared/types";

function mustQuery<TElement extends Element>(selector: string): TElement {
  const found = document.querySelector<TElement>(selector);
  if (!found) {
    throw new Error(`Renderer UI bootstrap failed: missing element ${selector}`);
  }
  return found;
}

const clockElement = mustQuery<HTMLSpanElement>("#clock");
const expandWidthButton = mustQuery<HTMLButtonElement>("#expand-width-button");
const shrinkWidthButton = mustQuery<HTMLButtonElement>("#shrink-width-button");
const widthOriginSelect = mustQuery<HTMLSelectElement>("#width-origin-select");
const openSettingsButton = mustQuery<HTMLButtonElement>("#open-settings-button");
const settingsDialog = mustQuery<HTMLDialogElement>("#settings-dialog");
const settingsForm = mustQuery<HTMLFormElement>("#settings-form");
const settingsCancelButton = mustQuery<HTMLButtonElement>("#settings-cancel-button");
const themeSelect = mustQuery<HTMLSelectElement>("#theme-select");
const alwaysOnTopToggle = mustQuery<HTMLInputElement>("#always-on-top-toggle");
const siteUrlInput = mustQuery<HTMLInputElement>("#site-url-input");
const siteUrlError = mustQuery<HTMLParagraphElement>("#site-url-error");
const cardFrame = mustQuery<HTMLElement>("#card-frame");
const resizeHandle = mustQuery<HTMLButtonElement>("#resize-handle");
const SITE_URL_MAX_LENGTH = 64;

const jstFormatter = new Intl.DateTimeFormat("ja-JP", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Tokyo"
});

let currentSettings: AppSettings | null = null;
let currentLayout: LayoutMetrics | null = null;

interface ResizeDragState {
  pointerId: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
}

let dragState: ResizeDragState | null = null;
let resizeInFlight = false;
let queuedResize: { width: number; height: number } | null = null;

function setTheme(theme: ThemeMode): void {
  document.body.dataset.theme = theme;
}

function setSiteUrlError(message: string): void {
  siteUrlError.textContent = message;
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
  const now = new Date();
  const delayUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
  setTimeout(() => {
    updateClock();
    setInterval(updateClock, 60_000);
  }, Math.max(100, delayUntilNextMinute));
}

function applySettings(nextSettings: AppSettings): void {
  currentSettings = nextSettings;
  setTheme(nextSettings.theme);
  widthOriginSelect.value = nextSettings.widthResizeOrigin;
  themeSelect.value = nextSettings.theme;
  alwaysOnTopToggle.checked = nextSettings.alwaysOnTop;
  siteUrlInput.value = nextSettings.siteUrl;
}

function selectedWidthOrigin(): WidthResizeOrigin {
  return widthOriginSelect.value === "left" ? "left" : "right";
}

function applyLayout(layout: LayoutMetrics): void {
  currentLayout = layout;

  cardFrame.style.left = `${layout.cardX}px`;
  cardFrame.style.top = `${layout.cardY}px`;
  cardFrame.style.width = `${layout.cardWidth}px`;
  cardFrame.style.height = `${layout.cardHeight}px`;

  resizeHandle.style.width = `${layout.handleSize}px`;
  resizeHandle.style.height = `${layout.handleSize}px`;
}

async function submitQueuedResize(): Promise<void> {
  if (resizeInFlight || !queuedResize) {
    return;
  }

  resizeInFlight = true;
  const payload = queuedResize;
  queuedResize = null;

  try {
    const updatedSettings = await window.desktopApi.resizeCard(payload);
    applySettings(updatedSettings);
  } finally {
    resizeInFlight = false;
    if (queuedResize) {
      void submitQueuedResize();
    }
  }
}

function queueResize(width: number, height: number): void {
  queuedResize = {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height))
  };
  void submitQueuedResize();
}

function startResize(event: PointerEvent): void {
  if (!currentLayout) {
    return;
  }

  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startWidth: currentLayout.cardWidth,
    startHeight: currentLayout.cardHeight
  };
  resizeHandle.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function continueResize(event: PointerEvent): void {
  if (!dragState || dragState.pointerId !== event.pointerId) {
    return;
  }

  const width = dragState.startWidth + (event.clientX - dragState.startX);
  const height = dragState.startHeight + (event.clientY - dragState.startY);
  queueResize(width, height);
}

function endResize(event: PointerEvent): void {
  if (!dragState || dragState.pointerId !== event.pointerId) {
    return;
  }
  dragState = null;
  resizeHandle.releasePointerCapture(event.pointerId);
}

function installEvents(): void {
  expandWidthButton.addEventListener("click", () => {
    void window.desktopApi.setWindowWidth({
      width: 1920,
      origin: selectedWidthOrigin()
    });
  });

  shrinkWidthButton.addEventListener("click", () => {
    void window.desktopApi.setWindowWidth({
      width: 425,
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
      setSiteUrlError("");
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
    setSiteUrlError("");
    if (currentSettings) {
      applySettings(currentSettings);
    }
  });

  siteUrlInput.addEventListener("input", () => {
    if (siteUrlError.textContent) {
      setSiteUrlError("");
    }
  });

  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const siteUrlResult = validateSiteUrl(siteUrlInput.value);
    if (!siteUrlResult.ok) {
      setSiteUrlError(siteUrlResult.message);
      return;
    }

    try {
      setSiteUrlError("");
      const theme: ThemeMode = themeSelect.value === "light" ? "light" : "dark";
      const updated = await window.desktopApi.updateSettings({
        theme,
        siteUrl: siteUrlResult.value
      });
      applySettings(updated);
      settingsDialog.close();
    } catch {
      setSiteUrlError("Failed to save settings.");
    }
  });

  resizeHandle.addEventListener("pointerdown", startResize);
  resizeHandle.addEventListener("pointermove", continueResize);
  resizeHandle.addEventListener("pointerup", endResize);
  resizeHandle.addEventListener("pointercancel", endResize);
}

async function bootstrap(): Promise<void> {
  installEvents();
  startClockTicker();

  const [settings, layout] = await Promise.all([
    window.desktopApi.getSettings(),
    window.desktopApi.getLayout()
  ]);

  applySettings(settings);
  if (layout) {
    applyLayout(layout);
  }

  window.desktopApi.onLayoutChanged((nextLayout) => {
    applyLayout(nextLayout);
  });

  window.desktopApi.onSettingsChanged((nextSettings) => {
    applySettings(nextSettings);
  });
}

void bootstrap();
