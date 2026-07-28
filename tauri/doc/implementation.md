# TV Browser Tauri 実装ドキュメント

## 概要

Tauri 2のローカルWebViewを操作UIとして使用し、同じネイティブウィンドウへTradingView用の子WebViewを追加しています。Electron版の`BrowserWindow + WebContentsView`に対応する構成です。

実装はすべて`tauri/`内にあり、既存Electron版のファイルには依存しません。

## 構成

- `src/main.ts`: 操作UI、設定モーダル、幅切替、キャプチャ状態・エラー表示
- `src/styles.css`: Dark/Lightテーマと操作UI
- `src-tauri/src/lib.rs`: ウィンドウ、子WebView、設定、キャプチャ、Tauri Commands
- `src-tauri/tauri.conf.json`: アプリ名、Bundle ID、CSP、ビルド設定

## ウィンドウと子WebView

各ウィンドウは一意な`main-N`ラベルを持ちます。ローカルWebViewがヘッダーと設定画面を表示し、`main-N-tradingview`子WebViewがTradingViewを表示します。

子WebViewは固定の16バイトデータストア識別子`tvbrowser-store1`を使用し、ウィンドウ間でCookieやログイン状態を共有します。移動先は`https:`だけを許可し、`window.open`は同じTradingView子WebViewへ遷移させます。

macOSでは子WebViewの実座標へタイトルバー高を加えてローカル操作ツールバーとの重なりを防ぎ、同じ高さを子WebViewの表示高から差し引いて下端をコンテンツ領域内へ収めます。初期作成と再レイアウトは同じ物理座標・サイズ変換を使用します。

カード配置はElectron版と同じ計算です。

- ヘッダー高: 38px
- ウィンドウ余白: 2px
- カード内余白: 8px
- カード幅: ウィンドウ表示幅とwide mode設定値の大きい方
- narrow modeではカードを右寄せし、左側をウィンドウ外へはみ出させる

設定モーダルを開く前にTradingView子WebViewを隠してキャプチャを一時停止し、非表示処理が成功した場合だけモーダルを表示します。表示切替はPromiseキューで直列化し、Cancel、Save、Escを含むすべてのClose後に復帰処理を実行します。先行する表示切替が失敗しても後続処理を継続し、復帰失敗は未処理Promiseにせず記録します。保存先選択は二重起動を防ぎ、キャンセルとプラグインエラーを分けて処理します。

## 設定

設定はTauriの`app_config_dir/settings.json`へ一時ファイル経由で保存します。新保存先がない場合は、Electron版の`~/Library/Application Support/tv-browser/settings.json`を読み込めます。

設定ファイルが存在しない場合だけ初期値をそのまま使用します。JSONの構文・型が不正、またはファイルを読み込めない場合は、元ファイルを同じディレクトリの`settings.invalid-<Unix時刻>.json`へ退避してから初期値で起動し、退避先と原因を起動時の警告ダイアログへ表示します。退避に失敗した場合は元ファイルの上書きを防ぐため起動を中止します。将来の項目追加に対しては、欠けている項目だけを初期値で補います。

操作画面の初期化では、イベント監視とClose確認を初期IPC取得より先に登録します。独立した登録処理と`get_settings`、`get_layout`、`get_capture_state`はそれぞれ`Promise.allSettled`で実行し、1件の失敗で後続処理を中断しません。初期キャプチャ状態が未取得の間にCloseが要求された場合はCloseを保留し、その場で状態を再取得できた場合だけ処理を継続します。

全ウィンドウ共通:

- Theme
- Site URL
- wide/narrow mode幅
- キャプチャ間隔、ファイル名、保存先

ウィンドウローカル:

- Always on Top
- 幅変更起点
- 現在のサイズと位置

最後に操作したウィンドウのローカル値を次回起動時の初期値として保存します。

保存位置を復元する場合は、ウィンドウ作成後の実際の外枠と、接続中モニターのメニューバー・Dockを除く作業領域を物理座標で比較します。最も重なるモニター、完全に画面外の場合は最も近いモニターを選び、ウィンドウを作業領域内へ補正します。ウィンドウが作業領域より大きい場合は左上を作業領域へ合わせます。補正後の座標は設定へ保存し直します。`N`でずらして作成するウィンドウにも同じ補正を適用します。

ウィンドウのサイズ・位置を保存する際は、実ウィンドウから次の設定候補を作成し、設定ファイルへの保存成功後だけ全体設定とウィンドウローカル設定を同時に更新します。移動・リサイズイベントの保存失敗は`settings-save-error`イベントで通知し、コミット済みメモリ状態を変更しません。`W`による幅切替で保存に失敗した場合は、実ウィンドウのサイズと位置も変更前へ戻します。

## 定期キャプチャ

開始できるのは一度に1ウィンドウだけです。スケジューラーはRust側のTauri非同期ランタイムで動作するため、操作用WebViewのバックグラウンドタイマー抑制には依存しません。JSTにおける次の設定間隔の区切り時刻に5秒を加えた時刻で取得し、毎回次の時刻を再計算します。240分間隔は`00:00 / 04:00 / 08:00 ...`を境界とします。

Cによる開始・停止、設定モーダルによる一時停止・再開、キャプチャ間隔変更、対象ウィンドウ破棄のたびに、既存タスクをキャンセルして必要な場合だけ新しいタスクを生成します。キャプチャ失敗は`capture-error`イベントで対象ウィンドウへ通知します。

キャプチャ先を含む設定の保存時とCによるキャプチャ開始時には、保存先ディレクトリ内で一意な検証ファイルの作成・書き込み・削除を行います。既存の出力先PNGがある場合は、そのファイルも通常ファイルかつ書き込み可能であることを確認します。検証に失敗した場合は設定全体を変更せず、キャプチャも開始しません。

既存の出力先はシンボリックリンクを追跡しないメタデータで検査し、通常ファイル以外とシンボリックリンクを拒否します。実際の保存時にもUnixの`O_NOFOLLOW`で出力ファイルを開き、開いたファイルハンドルが通常ファイルであることを確認してから切り詰め・書き込みを行うため、検証後のリンク差し替えでもリンク先を上書きしません。

Rust側はTauriの`with_webview`から`WKWebView`を取得し、`takeSnapshotWithConfiguration`を呼びます。返された`NSImage`を`NSBitmapImageRep`でPNGへ変換し、`captureDirectory/captureFileName.png`へ上書きします。

この実装はmacOS専用です。ウィンドウが最小化または完全に隠れている場合のWebKit更新停止についてはElectron版と同じ制約があるため、正しい最新表示を取得するにはAlways on Topか画面上への一部表示を推奨します。

## Tauri Commands

- `get_settings`
- `take_startup_warning`
- `update_settings`
- `get_layout`
- `set_trading_view_suspended`
- `set_window_width`
- `create_window`
- `get_capture_state`
- `toggle_periodic_capture`
- `capture_now`

イベント:

- `settings-changed`
- `layout-changed`
- `capture-state-changed`
- `capture-error`
- `settings-save-error`
