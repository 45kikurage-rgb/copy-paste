# 自己利用分クーポン管理 — Cloudflare設定

このリポジトリには、GitHub Pagesで表示する画面と、D1/R2を利用するCloudflare Worker APIが含まれています。
Cloudflare上のD1・R2・Bindingはコードから自動作成しません。以下の作業をCloudflare側で行ってください。

## 必要なBinding名

| 種類 | Binding名 | 用途 |
|---|---|---|
| D1 Database | `COUPON_DB` | クーポン、期限、URL、予約、画像メタデータ |
| R2 Bucket | `COUPON_IMAGES` | 代表画像、利用用クーポン画像 |

Binding名は大文字・小文字を含めて上記と完全に一致させてください。

## 必要な環境変数

| 名前 | 必須 | 設定値 |
|---|---|---|
| `ALLOWED_ORIGINS` | 必須 | `https://45kikurage-rgb.github.io` |
| `COUPON_ANALYZER_API` | 任意 | `https://coupon-capture.45kikurage.workers.dev/api/analyze-detail`（未設定時もこの既定値を使用） |

複数originを許可する場合はカンマ区切りにします。APIキーやSecretは不要で、ソースコードにも記載していません。

## D1へ最初に実行するSQL

初回だけ [`worker/schema.sql`](./worker/schema.sql) の全SQLを、作成済みD1のConsoleで実行してください。

Wranglerを使う場合の例:

```bash
cd worker
npx wrangler d1 execute YOUR_D1_DATABASE_NAME --remote --file=./schema.sql
```

`YOUR_D1_DATABASE_NAME` は自分で作成したD1名に置き換えます。

## Cloudflare側で行う作業

1. D1 Databaseを1つ作成する。
2. R2 Bucketを1つ作成する。
3. `worker/schema.sql` をD1で実行する。
4. Workerを作成し、`worker/src/index.js` をエントリーポイントとしてデプロイする。
5. WorkerのD1 Bindingを `COUPON_DB`、R2 Bindingを `COUPON_IMAGES` という名前で設定する。
6. Workerの環境変数 `ALLOWED_ORIGINS` に `https://45kikurage-rgb.github.io` を設定する。
7. Workerの公開URLを確認する。
8. ルートの `coupon-config.js` にある `window.COUPON_API_BASE` を、手順7のURLへ書き換えてGitHubへ反映する。

`worker/wrangler.toml.example` は設定例です。使用する場合は `wrangler.toml` にコピーし、D1名・D1 ID・R2名を自分の値へ置き換えます。実際のIDをGitへ保存したくない場合はCloudflare DashboardでBindingしてください。

## 画面とデータの動き

- ホームの「自己利用分」は同じGitHub Pages内の `coupons.html` を開きます。
- 一覧は期限が早い順です。残り0件の期限とカードはAPIから返しません。
- URL型は1件、画像型は指定枚数を10分予約します。
- 予約はD1の1つの条件付き `UPDATE ... RETURNING` で確保するため、同時操作でも同じアイテムは二重予約されません。
- 10分経過した予約は、次のAPIアクセス時に解放されます。一覧・予約処理では期限切れ予約を利用可能として扱うため、時間経過後に再利用できます。
- 「利用した」では削除せず、「確認」でD1の対象行を削除します。画像型は同時にR2の対象画像も削除します。
- 画像型は指定枚数をZIPにまとめてダウンロードします。
- URLは正規化後のSHA-256、画像はファイル内容のSHA-256をD1の一意キーにし、入力内・DB内・同時登録時の重複を保存しません。

## 動作確認

Worker単体の構文・補助処理テスト:

```bash
cd worker
npm install
npm run check
```

Cloudflare設定後は、次の順で実機確認してください。

1. `GET /api/health` が `{"ok":true,"reservationMinutes":10}` を返す。
2. ホーム → 自己利用分へ移動できる。
3. URL型・画像型を登録し、期限順・期限ごとの枚数が正しい。
4. 2台から同時に利用し、同じURL/画像が割り当てられない。
5. キャンセル直後と予約開始10分後に再利用できる。
6. 「利用した」だけでは枚数が減らず、「確認」で減る。
7. 最後の1件を確認すると期限行とカードが消え、後続カードが詰まる。
8. 同じURL・同じ画像を再登録し、「新規 0件 / 重複 1件」になる。

## 補足

- 1回の登録上限は100件、画像1枚の上限は10MBです。
- 利用用画像は公開URLを持ちません。正しい予約IDと端末内に保存した予約トークンがある間だけZIP取得できます。
- 予約トークンはブラウザのlocalStorageに保存し、確認・キャンセル・10分経過で削除します。


## 共有からの自動登録

PWAのWeb Share Targetを使い、Androidの共有メニューからクーポンURLを受信できます。

処理順:
1. `share-coupon.html` が共有URLを受信
2. 共有画面はURLだけを `/api/coupons/register-auto` へ送信
3. 自己利用分Workerが `coupon-capture` Worker の `/api/analyze-detail` を呼び、商品名・引換先・利用期限・商品画像を解析
4. 同じ商品名＋引換先は同じカードにまとめ、同じ期限ならその期限に1件追加
5. 同じURLは fingerprint で重複登録しない
6. 商品画像を取得できた場合はR2へ保存。取得できない場合は自動生成の仮画像を表示

画面側はクーポン判定サイトを開きません。解析機能はWorker APIとして直接利用するため、判定用の画面サイトを削除してもAPIが残っていれば自動登録は継続できます。

既存D1に `redeem_place` 列がない場合はWorkerが初回アクセス時に自動追加します。新規D1では `worker/schema.sql` に最初から含まれます。

現時点ではHTTP/API解析を優先し、Browser Renderingは使用していません。取得できないクーポンが出た場合のみフォールバック追加を検討します。

## 既存URLカードの自動整理

自己利用分を開いたとき、既存のセブン/ファミマURL型カードを少数ずつ再解析します。商品名・引換先を正規化し、同じ商品＋同じ引換先のカードが複数に分かれている場合は、期限と個別URLを保持したまま1カードへ統合します。対応外URLや解析失敗URLは既存データを変更しません。
