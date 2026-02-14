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
const themeSelect = mustQuery<HTMLSelectElement>("#theme-select");
const alwaysOnTopToggle = mustQuery<HTMLInputElement>("#always-on-top-toggle");
const cardFrame = mustQuery<HTMLElement>("#card-frame");
const resizeHandle = mustQuery<HTMLButtonElement>("#resize-handle");

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

  themeSelect.addEventListener("change", async () => {
    const theme: ThemeMode = themeSelect.value === "light" ? "light" : "dark";
    const updated = await window.desktopApi.updateSettings({ theme });
    applySettings(updated);
  });

  alwaysOnTopToggle.addEventListener("change", async () => {
    const updated = await window.desktopApi.updateSettings({
      alwaysOnTop: alwaysOnTopToggle.checked
    });
    applySettings(updated);
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
