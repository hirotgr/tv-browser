import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppSettings, CaptureIntervalMin } from "../shared/types";

const SETTINGS_FILE_NAME = "settings.json";
const MAX_SITE_URL_LENGTH = 64;
const CAPTURE_INTERVAL_VALUES: readonly CaptureIntervalMin[] = [1, 5, 15, 30, 60, 240];
const INVALID_CAPTURE_FILE_NAME_PATTERN = /[<>:"/\\|?*\u0000-\u001f]/;
const DEFAULT_CAPTURE_DIRECTORY = path.join(os.homedir(), "Downloads");

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  alwaysOnTop: false,
  siteUrl: "https://www.tradingview.com",
  cardWidth: 980,
  cardHeight: 680,
  windowWidth: 1320,
  windowHeight: 920,
  windowX: null,
  windowY: null,
  widthResizeOrigin: "right",
  captureIntervalMin: 5,
  captureFileName: "capture",
  captureDirectory: DEFAULT_CAPTURE_DIRECTORY
};

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNullableCoordinate(value: unknown, fallback: number | null): number | null {
  if (value === null || value === undefined) {
    return fallback;
  }

  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asTheme(value: unknown, fallback: AppSettings["theme"]): AppSettings["theme"] {
  return value === "dark" || value === "light" ? value : fallback;
}

function asWidthResizeOrigin(
  value: unknown,
  fallback: AppSettings["widthResizeOrigin"]
): AppSettings["widthResizeOrigin"] {
  return value === "right" || value === "left" ? value : fallback;
}

function asCaptureIntervalMin(
  value: unknown,
  fallback: AppSettings["captureIntervalMin"]
): AppSettings["captureIntervalMin"] {
  return CAPTURE_INTERVAL_VALUES.includes(value as CaptureIntervalMin) ? (value as CaptureIntervalMin) : fallback;
}

function normalizeCaptureFileName(value: string): string {
  return value.trim().replace(/(?:\.png)+$/i, "").trim();
}

function asCaptureFileName(value: unknown, fallback: AppSettings["captureFileName"]): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = normalizeCaptureFileName(value);
  if (normalized.length === 0 || INVALID_CAPTURE_FILE_NAME_PATTERN.test(normalized)) {
    return fallback;
  }

  return normalized;
}

function asCaptureDirectory(value: unknown, fallback: AppSettings["captureDirectory"]): string {
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

function asSiteUrl(value: unknown, fallback: string): string {
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

function sanitize(raw: Partial<AppSettings>): AppSettings {
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
    widthResizeOrigin: asWidthResizeOrigin(raw.widthResizeOrigin, DEFAULT_SETTINGS.widthResizeOrigin),
    captureIntervalMin: asCaptureIntervalMin(raw.captureIntervalMin, DEFAULT_SETTINGS.captureIntervalMin),
    captureFileName: asCaptureFileName(raw.captureFileName, DEFAULT_SETTINGS.captureFileName),
    captureDirectory: asCaptureDirectory(raw.captureDirectory, DEFAULT_SETTINGS.captureDirectory)
  };
}

function resolveSettingsPath(userDataPath: string): string {
  return path.join(userDataPath, SETTINGS_FILE_NAME);
}

export function loadSettings(userDataPath: string): AppSettings {
  const settingsPath = resolveSettingsPath(userDataPath);
  if (!fs.existsSync(settingsPath)) {
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    return sanitize(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(userDataPath: string, settings: AppSettings): void {
  const settingsPath = resolveSettingsPath(userDataPath);
  const safeSettings = sanitize(settings);
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(safeSettings, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save settings:", error);
  }
}
