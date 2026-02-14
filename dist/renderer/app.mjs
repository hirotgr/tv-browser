// src/renderer/app.ts
function mustQuery(selector) {
  const found = document.querySelector(selector);
  if (!found) {
    throw new Error(`Renderer UI bootstrap failed: missing element ${selector}`);
  }
  return found;
}
var clockElement = mustQuery("#clock");
var expandWidthButton = mustQuery("#expand-width-button");
var shrinkWidthButton = mustQuery("#shrink-width-button");
var widthOriginSelect = mustQuery("#width-origin-select");
var themeSelect = mustQuery("#theme-select");
var alwaysOnTopToggle = mustQuery("#always-on-top-toggle");
var cardFrame = mustQuery("#card-frame");
var resizeHandle = mustQuery("#resize-handle");
var jstFormatter = new Intl.DateTimeFormat("ja-JP", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Tokyo"
});
var currentSettings = null;
var currentLayout = null;
var dragState = null;
var resizeInFlight = false;
var queuedResize = null;
function setTheme(theme) {
  document.body.dataset.theme = theme;
}
function updateClock() {
  clockElement.textContent = `${jstFormatter.format(/* @__PURE__ */ new Date())} JST`;
}
function startClockTicker() {
  updateClock();
  const now = /* @__PURE__ */ new Date();
  const delayUntilNextMinute = (60 - now.getSeconds()) * 1e3 - now.getMilliseconds();
  setTimeout(() => {
    updateClock();
    setInterval(updateClock, 6e4);
  }, Math.max(100, delayUntilNextMinute));
}
function applySettings(nextSettings) {
  currentSettings = nextSettings;
  setTheme(nextSettings.theme);
  widthOriginSelect.value = nextSettings.widthResizeOrigin;
  themeSelect.value = nextSettings.theme;
  alwaysOnTopToggle.checked = nextSettings.alwaysOnTop;
}
function selectedWidthOrigin() {
  return widthOriginSelect.value === "left" ? "left" : "right";
}
function applyLayout(layout) {
  currentLayout = layout;
  cardFrame.style.left = `${layout.cardX}px`;
  cardFrame.style.top = `${layout.cardY}px`;
  cardFrame.style.width = `${layout.cardWidth}px`;
  cardFrame.style.height = `${layout.cardHeight}px`;
  resizeHandle.style.width = `${layout.handleSize}px`;
  resizeHandle.style.height = `${layout.handleSize}px`;
}
async function submitQueuedResize() {
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
function queueResize(width, height) {
  queuedResize = {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height))
  };
  void submitQueuedResize();
}
function startResize(event) {
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
function continueResize(event) {
  if (!dragState || dragState.pointerId !== event.pointerId) {
    return;
  }
  const width = dragState.startWidth + (event.clientX - dragState.startX);
  const height = dragState.startHeight + (event.clientY - dragState.startY);
  queueResize(width, height);
}
function endResize(event) {
  if (!dragState || dragState.pointerId !== event.pointerId) {
    return;
  }
  dragState = null;
  resizeHandle.releasePointerCapture(event.pointerId);
}
function installEvents() {
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
    const theme = themeSelect.value === "light" ? "light" : "dark";
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
async function bootstrap() {
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
//# sourceMappingURL=app.mjs.map