import type { AppSettings, LayoutMetrics, WidthResizeOrigin } from "../shared/types";

interface DesktopApi {
  createWindow(): Promise<void>;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  resizeCard(size: { width: number; height: number }): Promise<AppSettings>;
  getLayout(): Promise<LayoutMetrics | null>;
  setWindowWidth(payload: { width: number; origin: WidthResizeOrigin }): Promise<{
    width: number;
    height: number;
  }>;
  setTradingViewSuspended(suspended: boolean): Promise<void>;
  onLayoutChanged(callback: (layout: LayoutMetrics) => void): () => void;
  onSettingsChanged(callback: (settings: AppSettings) => void): () => void;
}

declare global {
  interface Window {
    desktopApi: DesktopApi;
  }
}

export {};
