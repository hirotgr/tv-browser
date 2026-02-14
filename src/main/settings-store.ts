import fs from "node:fs";
import path from "node:path";
import type { AppSettings } from "../shared/types";

const SETTINGS_FILE_NAME = "settings.json";

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  alwaysOnTop: false,
  cardWidth: 980,
  cardHeight: 680,
  windowWidth: 1320,
  windowHeight: 920,
  widthResizeOrigin: "right"
};

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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

function sanitize(raw: Partial<AppSettings>): AppSettings {
  return {
    theme: asTheme(raw.theme, DEFAULT_SETTINGS.theme),
    alwaysOnTop: asBoolean(raw.alwaysOnTop, DEFAULT_SETTINGS.alwaysOnTop),
    cardWidth: asFiniteNumber(raw.cardWidth, DEFAULT_SETTINGS.cardWidth),
    cardHeight: asFiniteNumber(raw.cardHeight, DEFAULT_SETTINGS.cardHeight),
    windowWidth: asFiniteNumber(raw.windowWidth, DEFAULT_SETTINGS.windowWidth),
    windowHeight: asFiniteNumber(raw.windowHeight, DEFAULT_SETTINGS.windowHeight),
    widthResizeOrigin: asWidthResizeOrigin(raw.widthResizeOrigin, DEFAULT_SETTINGS.widthResizeOrigin)
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
