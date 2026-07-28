# TV Browser (Tauri)

Electron版TV BrowserをTauri 2へ移植したmacOS Apple Silicon向けアプリです。

## 必要環境

- macOS 10.15以降
- Xcode Command Line Tools
- Rust stable (`rustup`)
- Node.js / npm

## 開発

```sh
source "$HOME/.cargo/env"
npm install
npm run tauri dev
```

型検査とフロントエンドビルド:

```sh
npm run build
```

Rust検査:

```sh
cd src-tauri
cargo check
```

## アプリのビルド

```sh
npm run tauri build -- --bundles app
```

生成先:

```text
src-tauri/target/release/bundle/macos/TV Browser.app
```

## 主な機能

- ローカル操作UIとTradingView子WebViewの同一ウィンドウ表示
- Wide/Narrow幅切替とLeft/Right伸縮起点
- Always on Top
- `N`ボタン / `Cmd+N`による複数ウィンドウ
- テーマ、URL、表示幅、キャプチャ設定の永続化
- macOS `WKWebView.takeSnapshot`を使った定期PNGキャプチャ
- 複数ウィンドウ間のTradingViewデータストア共有

詳しい構成は[implementation.md](./doc/implementation.md)を参照してください。
