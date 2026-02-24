export type ThemeMode = "dark" | "light";
export type WidthResizeOrigin = "right" | "left";
export type CaptureIntervalMin = 1 | 5 | 15 | 30 | 60 | 240;

export interface CaptureState {
  activeWindowId: number | null;
}

export interface CaptureToggleResult {
  status: "started" | "stopped" | "blocked";
  reason?: "another-window";
}

export interface AppSettings {
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
  captureIntervalMin: CaptureIntervalMin;
  captureFileName: string;
  captureDirectory: string;
  wideModeWidth: number;
  narrowModeWidth: number;
}

export interface LayoutMetrics {
  headerHeight: number;
  cardX: number;
  cardY: number;
  cardWidth: number;
  cardHeight: number;
  contentX: number;
  contentY: number;
  contentWidth: number;
  contentHeight: number;
  handleSize: number;
  cardPadding: number;
}
