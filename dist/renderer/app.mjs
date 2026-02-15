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
var openSettingsButton = mustQuery("#open-settings-button");
var settingsDialog = mustQuery("#settings-dialog");
var settingsForm = mustQuery("#settings-form");
var settingsCancelButton = mustQuery("#settings-cancel-button");
var themeSelect = mustQuery("#theme-select");
var alwaysOnTopToggle = mustQuery("#always-on-top-toggle");
var siteUrlInput = mustQuery("#site-url-input");
var siteUrlError = mustQuery("#site-url-error");
var cardFrame = mustQuery("#card-frame");
var resizeHandle = mustQuery("#resize-handle");
var SITE_URL_MAX_LENGTH = 64;
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
function setSiteUrlError(message) {
  siteUrlError.textContent = message;
}
function validateSiteUrl(rawValue) {
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
async function setSettingsModalOpen(isOpen) {
  try {
    await window.desktopApi.setTradingViewSuspended(isOpen);
  } catch (error) {
    console.error("Failed to toggle trading view visibility:", error);
  }
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
  siteUrlInput.value = nextSettings.siteUrl;
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
      const theme = themeSelect.value === "light" ? "light" : "dark";
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