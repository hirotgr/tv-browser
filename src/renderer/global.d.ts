import type {
  AppSettings,
  CaptureState,
  CaptureToggleResult,
  LayoutMetrics,
  WidthResizeOrigin
} from "../shared/types";

interface DesktopApi {
  createWindow(): Promise<void>;
  getWindowId(): Promise<number>;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  resizeCard(size: { width: number; height: number }): Promise<AppSettings>;
  getLayout(): Promise<LayoutMetrics | null>;
  setWindowWidth(payload: { width: number; origin: WidthResizeOrigin }): Promise<{
    width: number;
    height: number;
  }>;
  setTradingViewSuspended(suspended: boolean): Promise<void>;
  pickCaptureDirectory(): Promise<string | null>;
  togglePeriodicCapture(): Promise<CaptureToggleResult>;
  getCaptureState(): Promise<CaptureState>;
  onLayoutChanged(callback: (layout: LayoutMetrics) => void): () => void;
  onSettingsChanged(callback: (settings: AppSettings) => void): () => void;
  onCaptureStateChanged(callback: (state: CaptureState) => void): () => void;
}

declare global {
  interface Window {
    desktopApi: DesktopApi;
  }
}

export {};
