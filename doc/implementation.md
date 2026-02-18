# TV Browser 実装ドキュメント

## 1. 概要

`TV Browser` は Electron + TypeScript で実装した macOS 向けデスクトップアプリです。
各ウィンドウは 1 枚のカード領域を持ち、その内部に `Site URL`（既定: `https://www.tradingview.com`）を表示します。

主な特徴:

- TradingView を各ウィンドウ 1 カードで表示
- `N` ボタン / `Cmd+N` で新規ウィンドウを追加
- カード右下ハンドルでリサイズ
- カードはウィンドウ右上基準で配置（ウィンドウが狭い場合は左にはみ出し許容）
- ヘッダー右側に `HH:MM JST` 時計と操作 UI（`N` / `X+` / `X-` / `Right|Left` / `AoT` / `gear`）
- `Settings` モーダルで `Theme` / `Site URL` を設定
- 全ウィンドウで `persist:tradingview` を共有し Cookie / ストレージ / ログイン状態を共有
- `Theme` / `Site URL` は全ウィンドウ共通、`AoT` / `Display Mode` / 幅サイズ操作はウィンドウローカル
- 設定値は永続化され、次回起動時の初期値として復元
- 終了時の最後に閉じたウィンドウの `x/y` 座標を保存し、起動時は画面外をクランプして復元
- 外部リンクは `https:` のみ外部ブラウザで許可

---

## 2. 技術スタック

- Electron: `^33.2.1`
- TypeScript: `^5.7.3`
- Bundler: `tsup`
- 実行環境: Node 20 ターゲット（main/preload）、ES2020（renderer）

主要設定:

- `main`: `dist/main/main.js`
- ビルド: `npm run build`
- 開発起動: `npm run start`（build 後に `electron .`）

---

## 3. ディレクトリ構成

```text
src/
  main/
    main.ts                # メインプロセス（BrowserWindow / WebContentsView / IPC / レイアウト）
    renderer-preload.ts    # Renderer 向け contextBridge API
    settings-store.ts      # settings.json の読み書き
  renderer/
    index.html             # UI 構造
    app.ts                 # UI ロジック（時計、設定操作、カードリサイズ）
    styles.css             # 見た目
    global.d.ts            # window.desktopApi 型
  shared/
    types.ts               # 共有型（AppSettings / LayoutMetrics など）

dist/
  main/                    # main, preload のビルド成果物
  renderer/                # renderer のビルド成果物

release/
  TV-Browser-darwin-arm64/TV Browser.app
```

---

## 4. アーキテクチャ

### 4.1 メインプロセス

実装: `src/main/main.ts`

責務:

- 複数 `BrowserWindow` の作成と管理
- 各ウィンドウの `WebContentsView`（TradingView表示）の管理
- レイアウト計算と反映
- IPC ハンドラ提供
- 設定永続化（デバウンス + flush）

ウィンドウ生成の要点:

- `useContentSize: true`
- `minWidth: 320`, `minHeight: 640`
- タイトル: `TV Browser`
- Renderer preload: `renderer-preload.js`

TradingView View の要点:

- URL: 設定値 `siteUrl`（既定 `https://www.tradingview.com`）
- すべてのウィンドウで `partition: "persist:tradingview"` を共有（ログイン状態維持）
- `sandbox: true`
- `setWindowOpenHandler` で `https:` のみ `shell.openExternal` 許可

### 4.2 Renderer

実装: `src/renderer/index.html`, `src/renderer/app.ts`, `src/renderer/styles.css`

責務:

- 時計表示（`HH:MM JST`）
- UI操作（幅変更、起点切替、Settings モーダル）
- カードリサイズ操作
- メインから通知された `LayoutMetrics` の反映

### 4.3 Preload

実装: `src/main/renderer-preload.ts`

`contextBridge` で `window.desktopApi` を公開し、Renderer から必要最小限の IPC 操作のみ許可。

---

## 5. レイアウト仕様

### 5.1 固定値

`src/main/main.ts`:

- `HEADER_HEIGHT = 38`
- `WINDOW_PADDING = 2`
- `CARD_PADDING = 8`
- `HANDLE_SIZE = 18`
- `MIN_CONTENT_WIDTH = 320`
- `MIN_CONTENT_HEIGHT = 220`
- `MIN_CARD_WIDTH = 336`
- `MIN_CARD_HEIGHT = 236`

### 5.2 カード配置ロジック

`computeLayout(windowWidth)` で以下を計算:

- `cardX = windowWidth - WINDOW_PADDING - cardWidth`
- `cardY = HEADER_HEIGHT + WINDOW_PADDING`

このためカードは「右上固定」で配置され、ウィンドウ幅がカード幅より小さい場合は左側にはみ出します（仕様どおり）。

---

## 6. 設定モデルと永続化

### 6.1 設定型

`src/shared/types.ts`:

```ts
interface AppSettings {
  theme: "dark" | "light";
  alwaysOnTop: boolean;
  siteUrl: string;
  cardWidth: number;
  cardHeight: number;
  windowWidth: number;
  windowHeight: number;
  windowX: number | null;
  windowY: number | null;
  widthResizeOrigin: "right" | "left";
}
```

### 6.2 保存先

`src/main/settings-store.ts`:

- ファイル: `${app.getPath("userData")}/settings.json`
- 名称変更移行: 初回起動時に新保存先が未作成で、旧 `~/Library/Application Support/tv-watchlist/settings.json` が存在する場合は `tv-browser` 側へ自動コピーして引き継ぐ（既存新保存先は上書きしない）
- デフォルト値:
  - `theme: "dark"`
  - `alwaysOnTop: false`
  - `siteUrl: "https://www.tradingview.com"`
  - `cardWidth: 980`
  - `cardHeight: 680`
  - `windowWidth: 1320`
  - `windowHeight: 920`
  - `windowX: null`
  - `windowY: null`
  - `widthResizeOrigin: "right"`

### 6.3 保存タイミング

- 通常更新: `250ms` デバウンス (`scheduleSettingsSave`)
- 通常更新で即時保存されるローカル値: `alwaysOnTop`, `widthResizeOrigin`, `windowWidth/windowHeight`, `cardWidth/cardHeight`（`windowX/windowY` は除外）
- `windowX/windowY` は最後のウィンドウ `close` / `Cmd+Q` 到達後の `window-all-closed` でのみ保存
- 終了系の最終スナップショット: 各ウィンドウ `move/moved` で座標をメモリ追従し、`close`（必要時 `closed`）で `windowWidth/windowHeight/windowX/windowY` を確定して `flushSettings()`

### 6.4 マルチウィンドウ時の適用範囲

- 全ウィンドウ共通: `theme`, `siteUrl`
- ウィンドウローカル（実行中）: `alwaysOnTop`, `widthResizeOrigin`, `windowWidth/windowHeight`, `windowX/windowY`, `cardWidth/cardHeight`
- ローカル値も `settings.json` には 1 セット保存され、次回起動時の初期値として使われる
- `windowX/windowY` が画面外でも、起動時に `screen.workArea` 内へクランプして表示する

### 6.5 例外安全

`saveSettings` は `try/catch` で保護。書き込み失敗時は `console.error` のみでアプリを落としません。

---

## 7. IPC インターフェース

### 7.1 Renderer から呼び出す API

`window.desktopApi`:

- `getSettings(): Promise<AppSettings>`
- `updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>`
- `resizeCard(size: { width: number; height: number }): Promise<AppSettings>`
- `getLayout(): Promise<LayoutMetrics | null>`
- `setWindowWidth(payload: { width: number; origin: "right" | "left" }): Promise<{ width: number; height: number }>`
- `createWindow(): Promise<void>`
- `onLayoutChanged(callback)`
- `onSettingsChanged(callback)`

### 7.2 幅変更の起点

`window:set-width` 実装:

- `origin = "right"`: 左端固定（右方向に伸縮）
- `origin = "left"`: 右端固定（左方向に伸縮）

`X+` は `1920`、`X-` は `425` を指定して呼び出します。

---

## 8. UI仕様（現行実装）

上部右寄せコントロール:

- `HH:MM JST` 時計
- `N` ボタン（新規ウィンドウ）
- `X+` ボタン（幅 1920）
- `X-` ボタン（幅 425）
- `Right/Left` セレクト（幅変更起点）
- `AoT` チェックボックス（Always on Top）
- `gear` ボタン（Settings モーダルを開く）

Settings モーダル:

- `Theme` セレクト（Dark / Light）
- `Site URL` テキスト入力（最大 64 文字）
- `Cancel` / `Save` ボタン
- Save 時に `Theme` / `Site URL` を一括反映
- `Site URL` は `https:` のみ許可（空文字、64文字超、非URL、`http:` はエラー）
- モーダル表示中にウィンドウを閉じても、次回起動時はモーダル状態を持ち越さず通常表示で開始

時計:

- `Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Tokyo" })`
- 表示形式: `HH:MM JST`

カードリサイズ:

- 右下ハンドルのポインタイベントでサイズ変更
- リサイズ要求はキュー化し、過剰 IPC を抑制

---

## 9. セキュリティ実装

- TradingView は `WebContentsView` + `sandbox: true`
- 外部 URL 起動は `new URL(url).protocol === "https:"` のみ許可
- `setWindowOpenHandler` は常に `deny` を返し、アプリ内で新規ウィンドウを開かない
- アプリ本体の新規ウィンドウは `Cmd+N` / `N` ボタン経由でメインプロセスが作成
- Renderer 側は `contextIsolation: true` + preload 経由 API のみ

---

## 10. ビルド / 実行 / 配布

### 10.1 開発

```bash
npm install
npm run typecheck
npm run start
```

### 10.2 ビルド

```bash
npm run build
```

成果物:

- `dist/main/main.js`
- `dist/main/renderer-preload.js`
- `dist/renderer/app.mjs`
- `dist/renderer/index.html`
- `dist/renderer/styles.css`

### 10.3 `.app` 生成（現行運用）

このリポジトリには packager の固定スクリプトは未定義のため、Electron 配布物をベースに `release/TV-Browser-darwin-arm64/TV Browser.app` を構成して作成しています。

現在の `.app` メタ情報:

- `CFBundleIdentifier = com.hirotgr.tvbrowser`
- `NSHumanReadableCopyright = 2026 hirotgr`

---

## 11. 既知の制約

- 対応OSは実質 macOS 前提で運用
- 各ウィンドウのカードは 1 枚固定（移動は非対応）
- TradingView 側の UI 変更により見え方が変わる可能性はある
- スクロール同期機能（旧 X/Y スライダー機能）は削除済み

---

## 12. 今後の拡張候補

- `.app` 生成手順の `npm script` 化（再現性向上）
- 署名 / notarization 対応
- 画面サイズ復元の多ディスプレイ考慮
- 設定項目（フォントサイズ、初期URLなど）の追加
