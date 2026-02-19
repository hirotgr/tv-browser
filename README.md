TradingVewを見るためのブラウザアプリです。
<br>
おまけ機能として定期的にチャートのスクリーンショットを(上書き)保存でき、それを画像解析してトレード判断に利用できます。 \
素人がCodexで作成したものなのでソフトウェアとしての品質は知らん。

* WebContentsViewでカードを作ってTradingViewを表示 (カードはリサイズ可能)
* **常に前面に表示** に対応 (AoT: Always on Top)
* `X-` ボタンで Watchlist だけを表示できる程度に横幅を変更
* `X+` ボタンで全体を表示できる程度に横幅を変更
* アプリをディスプレイの右端に配置して `X+` ボタンで左にウィンドウを広げたい場合は `Left` モードを選択
* アプリをディスプレイの左端に配置して `X+` ボタンで右にウィンドウを広げたい場合は `Right` モードを選択
* `N` (New Window) ポダンで新規ウィンドウを開く
* `C` (Periodic Screen Capture) ボタンでWebContentsView部分の画像を指定ディレクトリに定期的に保存
  * 注: WebContentsViewが一部でもディスプレイに表示されていないとElectron(Chromium)がコンテンツ更新を止めてしまうので AoT有効またはWebContentsView部分の一部だけでもディスプレイに表示させ、ウィンドウの最小化または完全オクルージョンは避ける必要があります。

細かな実装は [./doc/implementation.md](./doc/implementation.md) を参照

---

Watchlistだけを表示した状態 (`X-` ボタン)

![](./doc/watchlist-view.png)

---

全体をを表示した状態 (`X+` ボタン) \
`C` ボタンをクリックし、ボタンが白バックになっている間は指定した分数で定期的にスクリーンショットを上書き保存

![](./doc/full-view.png)

この画像の場合、日足〜5分足のローソクチャートに GMMA (Guppy Multi Moving Average) を表示しており、短期EMAグループと長期EMAグループの傾きと広がりを評価してトレンド判断する、といったことが考えられます。

![](./doc/gmma.png)