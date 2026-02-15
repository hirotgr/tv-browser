export type ThemeMode = "dark" | "light";
export type WidthResizeOrigin = "right" | "left";

export interface AppSettings {
  theme: ThemeMode;
  alwaysOnTop: boolean;
  siteUrl: string;
  cardWidth: number;
  cardHeight: number;
  windowWidth: number;
  windowHeight: number;
  widthResizeOrigin: WidthResizeOrigin;
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
