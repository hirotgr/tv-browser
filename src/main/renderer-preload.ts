import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  CaptureState,
  CaptureToggleResult,
  LayoutMetrics,
  WidthResizeOrigin
} from "../shared/types";

type Unsubscribe = () => void;

function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => {
    callback(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld("desktopApi", {
  createWindow: (): Promise<void> => ipcRenderer.invoke("window:create"),
  getWindowId: (): Promise<number> => ipcRenderer.invoke("window:get-id"),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke("settings:update", patch),
  resizeCard: (size: { width: number; height: number }): Promise<AppSettings> =>
    ipcRenderer.invoke("card:resize", size),
  getLayout: (): Promise<LayoutMetrics | null> => ipcRenderer.invoke("layout:get"),
  setWindowWidth: (payload: {
    width: number;
    origin: WidthResizeOrigin;
  }): Promise<{ width: number; height: number }> => ipcRenderer.invoke("window:set-width", payload),
  setTradingViewSuspended: (suspended: boolean): Promise<void> =>
    ipcRenderer.invoke("trading-view:set-suspended", suspended),
  pickCaptureDirectory: (): Promise<string | null> => ipcRenderer.invoke("capture:directory:pick"),
  togglePeriodicCapture: (): Promise<CaptureToggleResult> => ipcRenderer.invoke("capture:toggle"),
  getCaptureState: (): Promise<CaptureState> => ipcRenderer.invoke("capture:state:get"),
  onLayoutChanged: (callback: (layout: LayoutMetrics) => void): Unsubscribe =>
    subscribe<LayoutMetrics>("layout:changed", callback),
  onSettingsChanged: (callback: (nextSettings: AppSettings) => void): Unsubscribe =>
    subscribe<AppSettings>("settings:changed", callback),
  onCaptureStateChanged: (callback: (state: CaptureState) => void): Unsubscribe =>
    subscribe<CaptureState>("capture:state:changed", callback)
});
