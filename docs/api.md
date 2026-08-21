# かい鯖グループポイントシステム — API リファレンス

> **Base URL**: `https://points.bac0n.f5.si`
>
> **注意**: このドキュメントは内部・外部向け実装者のためのリファレンスです。

---

## 目次

1. [認証方式](#1-認証方式)
2. [共通レスポンス形式](#2-共通レスポンス形式)
3. [サービス自己登録 API](#3-サービス自己登録-api)
4. [プラグイン向け API (`/api/server`)](#4-プラグイン向け-api-apiserver)
5. [ユーザー向け取引 API (`/api/user`)](#5-ユーザー向け取引-api-apiuser)
6. [運営者向け API (`/api/operator`)](#6-運営者向け-api-apioperator)
7. [サブスクリプション API (`/api/server/subscription`)](#7-サブスクリプション-api-apiserversubscription)
8. [OAuth 2.0 (`/oauth`)](#8-oauth-20-oauth)
9. [通報 API (`/api/report`)](#9-通報-api-apireport)
10. [管理者 API (`/admin`)](#10-管理者-api-admin)
11. [エラーコード一覧](#11-エラーコード一覧)

---

## 1. 認証方式

すべての `/api/server/*` エンドポイント（登録系を除く）は API キーによる認証が必須です。

```
X-API-Key: <API_KEY>
```

- API キーは `skp_` で始まります（例: `skp_1a2b3c...`）
- API キーは **サービスアカウント登録完了時に一度だけ** Web UI に表示されます
- DB にはハッシュのみ保存（平文は保存されません）
- キーを紛失した場合は管理者に再発行を依頼してください

### 1-B. セッション認証（ユーザー向け）

`/api/user/*` と `/api/report` は Discourse OAuth ログイン後のセッション認証を使用します。  
ブラウザからのアクセスを想定しており、`Cookie` ヘッダーを自動送信します。

---

## 2. 共通レスポンス形式

```json
{
  "success": true,
  "data": { ... }
}
```

失敗時:

```json
{
  "success": false,
  "error": "エラーメッセージ"
}
```

---

## 3. サービス自己登録 API

管理者に依頼せず、プラグインが起動時に自動登録リクエストを発行し、  
サービス管理者が Web で承認するフローです。

```
POST   /api/server/register-request   (認証不要・IP レートリミット)
GET    /api/server/register-status/:token
POST   /api/server/register-confirm   (セッション認証必須)
```

### POST `/api/server/register-request`

プラグイン起動時に呼び出し、登録確認 URL を取得します。  
認証不要。IP 単位で 1 分 5 回のレートリミット。

**リクエスト Body** (JSON):

| フィールド    | 型      | 必須 | 説明                         |
| ------------- | ------- | ---- | ---------------------------- |
| `server_name` | string  | ✅   | サービスの表示名（最大100文字）|

**レスポンス** (200):

```json
{
  "success": true,
  "data": {
    "registration_url": "https://points.bac0n.f5.si/register-server?token=abc123...",
    "expires_in": 600
  }
}
```

**curl 例**:
```bash
curl -s -X POST https://points.bac0n.f5.si/api/server/register-request \
  -H 'Content-Type: application/json' \
  -d '{"server_name": "MyServer"}'
```

---

### GET `/api/server/register-status/:token`

プラグインがポーリングしてオーナーの承認完了を検知します。

**パラメータ**: `token` — 64 文字の小文字 16 進文字列

**レスポンス**:

```json
{
  "success": true,
  "data": {
    "status": "pending",       // "pending" | "completed" | "expired"
    "server_name": "MyServer"
  }
}
```

> `status === "completed"` になったら登録完了。プラグインはポーリングを停止し、APIキーを設定ファイルに書き込んでください（APIキーはWeb画面にのみ表示されます）。

---

### POST `/api/server/register-confirm`

オーナーが Web 画面でクリックする承認エンドポイント。  
**セッション認証必須**（ブラウザからのみ呼び出し）。

**リクエスト Body** (JSON):

| フィールド | 型     | 必須 | 説明                              |
| ---------- | ------ | ---- | --------------------------------- |
| `token`    | string | ✅   | 登録トークン（64 文字 16 進）     |

**レスポンス** (201):

```json
{
  "success": true,
  "data": {
    "server_name": "MyServer",
    "api_key": "skp_xxxxxxxxxxxxxxxx",
    "api_key_prefix": "skp_xxxx",
    "message": "このAPIキーは二度と表示されません。今すぐコピーしてプラグインの設定ファイルに保存してください。"
  }
}
```

> ⚠️ `api_key` はこのレスポンスでのみ返されます。再表示は不可能です。

---

### 4. プラグイン向け API (`/api/server`)

すべてのエンドポイントで `X-API-Key: <API_KEY>` が必須。

### GET `/api/server/balance`

自サービスの残高を返します。

```json
{ "success": true, "data": { "server_name": "MyServer", "balance": 12500 } }
```

---

### GET `/api/server/player/:mc_id`

プレイヤーのポイント残高を取得します（購入前の残高確認用）。

**レスポンス**:
```json
{
  "success": true,
  "data": {
    "username": "Player1",
    "minecraft_id": "Player1",
    "points": 800
  }
}
```

---

### GET `/api/server/products`

このサービスに登録された有効な商品一覧を返します。

```json
{
  "success": true,
  "data": [
    { "id": 1, "name": "ダイヤモンド×64", "price": 500, "description": "..." }
  ]
}
```

---

### POST `/api/server/tx/initiate`

購入フローを開始します（プレイヤーが `/buy` コマンドを実行したタイミング）。

> **重要**: 確認コードは廃止されました。プレイヤーは Web（ダッシュボード）で承認します。

**リクエスト Body** (JSON):

購入者の指定は以下の **いずれか 1 つのみ** 必須です。

| フィールド                | 型     | 必須   | 説明                                                                      |
| ------------------------- | ------ | ------ | ------------------------------------------------------------------------- |
| `mc_id`                   | string | ※1つ | 購入者の Minecraft ID（2〜16 文字、英数字・アンダースコア）               |
| `buyer_token`             | string | ※1つ | OAuth アクセストークン（`transaction` スコープ必須）。**ウェブアプリ向け** |
| `buyer_discourse_username`| string | ※1つ | 購入者の Discourse ユーザー名。サーバー間連携向け                         |
| `product_id`              | number | ✅     | 商品 ID（正の整数）                                                        |
| `recipient_mc_id`         | string | ❌     | 受取人の Minecraft ID（別ユーザーに商品を届ける場合）                     |
| `recipient_user_id`       | number | ❌     | 受取人のユーザー ID                                                        |
| `return_url`              | string | ❌     | 承認後にリダイレクトする URL（`http://` / `https://` のみ許可）。指定すると `web_url` にクエリパラメータとして埋め込まれます |

**価格はクライアントから受け取りません。サービス側の商品マスタから取得します。**

> **ウェブアプリからの取引フロー**: `buyer_token` を使用する場合は、先に OAuth 2.0 で `transaction` スコープのアクセストークンを取得してから渡してください（[Section 8 参照](#8-oauth-20-oauth)）。

**レスポンス** (201):

```json
{
  "success": true,
  "data": {
    "tx_token":   "ABC123...",
    "amount":     500,
    "item_name":  "ダイヤモンド×64",
    "expires_at": "2025-01-01T00:05:00Z",
    "web_url":    "https://points.bac0n.f5.si/dashboard?return_url=https%3A%2F%2Fyourapp.example.com%2Fcallback&service_name=MyServer",
    "message":    "購入金額: 500pt / https://points.bac0n.f5.si/dashboard?... から承認してください"
  }
}
```

> `return_url` を省略した場合、`web_url` は `https://points.bac0n.f5.si/dashboard` になります。

**`web_url` の動作**:
- ユーザーが `web_url` を開くと、ポイントダッシュボードに承認バナーが表示されます
- `service_name` パラメータが含まれる場合、バナーにそのサービス名が表示されます
- ユーザーが「承認する」を押すと、`return_url` に自動でリダイレクトされます（`return_url` 指定時のみ）
- `return_url` に戻るタイミングはユーザーの **承認後** です（拒否した場合はリダイレクトしません）

**実装例**（プラグイン側の動作）:
1. `/buy <商品名>` コマンドを受信
2. `/api/server/tx/initiate` を呼ぶ
3. プレイヤーにチャットメッセージを送信: `"[ポイント] ダッシュボードで承認してください: https://points.bac0n.f5.si/dashboard"`
4. `tx_token` でポーリング（`/api/server/tx/:tx_token`）し、`status === "pending_seller"` になったら商品を付与して `POST /api/server/tx/:tx_token/approve` を呼ぶ
5. レスポンスの `status === "completed"` を確認して取引完了

**curl 例**:
```bash
curl -s -X POST https://points.bac0n.f5.si/api/server/tx/initiate \
  -H 'X-API-Key: <API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{"mc_id": "Player1", "product_id": 1, "return_url": "https://yourapp.example.com/purchase-done"}'
```

**`return_url` を使った購入フロー（ウェブアプリ向け）**:

```
あなたのWebアプリ                  ポイントサーバー              ユーザー（ブラウザ）
   │                                │                             │
   │  1. POST /api/server/tx/initiate│                             │
   │     { return_url: "https://yourapp.example.com/done" }       │
   │ ─────────────────────────────→  │                             │
   │  ← web_url: /dashboard?return_url=...&service_name=MyServer   │
   │                                │                             │
   │  2. ユーザーを web_url へ案内  │                             │
   │ ─────────────────────────────────────────────────────────→  │
   │                                │  承認バナーを表示           │
   │                                │ ←────────────────────────── │
   │                                │  「承認する」をクリック      │
   │                                │ ←────────────────────────── │
   │  3. yourapp.example.com/done へリダイレクト                  │
   │ ←────────────────────────────────────────────────────────── │
   │                                │                             │
   │  4. GET /api/server/tx/:tx_token で完了確認                  │
   │ ─────────────────────────────→  │                             │
```

---

### GET `/api/server/tx/:tx_token`

取引の現在の状態を取得します（プラグイン側ポーリング用）。

**ステータス一覧**:

| status           | 意味                                                              |
| ---------------- | ----------------------------------------------------------------- |
| `pending_buyer`  | ユーザーの Web 承認待ち                                           |
| `pending_seller` | ユーザー承認済み・プラグイン側の `approve` 呼び出し待ち           |
| `completed`      | 取引完了・商品付与可                                              |
| `rejected`       | 取引拒否                                                          |
| `expired`        | 有効期限切れ（5分）                                               |

---

### POST `/api/server/tx/cancel`

プラグイン側からキャンセルします。

**Body**: `{ "tx_token": "ABC123..." }`

---

## 5. ユーザー向け取引 API (`/api/user`)

セッション認証（Cookie）が必須。ブラウザ（ダッシュボード）からのみ使用。

### GET `/api/user/tx/pending`

自分宛の承認待ち取引一覧（ダッシュボードのポーリング用、10秒間隔推奨）。

```json
{
  "success": true,
  "data": [
    {
      "id": 42,
      "tx_token": "ABC123",
      "amount": 500,
      "item_name": "ダイヤモンド×64",
      "status": "pending_buyer",
      "expires_at": "2025-01-01T00:05:00Z",
      "created_at": "2025-01-01T00:00:00Z",
      "server_name": "MyServer"
    }
  ]
}
```

---

### POST `/api/user/tx/:id/buyer-approve`

買い手（ユーザー）が Web から承認します（確認コード不要）。  
セッションの `user.id` が `buyer_user_id` と一致することでなりすましを防止。

**レスポンス**:
```json
{ "success": true, "data": { "status": "pending_seller" } }
```

---

### POST `/api/user/tx/:id/reject`

買い手が取引を断ります。

**レスポンス**:
```json
{ "success": true, "data": { "status": "rejected" } }
```

---

## 6. 運営者向け API (`/api/operator`)

セッション認証（Cookie）が必須。自分が **オーナー** のサービスアカウントを操作します。

### GET `/api/operator/me`

自分が所有するサービスアカウント一覧を返します。

```json
{
  "success": true,
  "data": [
    { "id": 1, "name": "MyServer", "balance": 500, "is_active": true }
  ]
}
```

---

### GET `/api/operator/tx/pending`

自分のサービスアカウントへの承認待ち取引一覧（`pending_seller` 状態）。

**クエリパラメータ**: `?server_id=<number>` — 複数サーバーを持つ場合に絞り込み（省略時は全サービスアカウント）

```json
{
  "success": true,
  "data": [
    {
      "id": 42,
      "tx_token": "ABC123",
      "amount": 500,
      "item_name": "ダイヤモンド×64",
      "status": "pending_seller",
      "server_name": "MyServer",
      "created_at": "2025-01-01T00:00:00Z"
    }
  ]
}
```

---

### POST `/api/operator/tx/:id/approve`

運営者が取引を承認します（商品付与完了後に呼ぶ）。

**レスポンス**:
```json
{ "success": true, "data": { "status": "completed", "amount": 500, "item_name": "ダイヤモンド×64", "message": "取引が完了しました" } }
```

---

### POST `/api/operator/tx/:id/reject`

運営者が取引を拒否します。

**レスポンス**:
```json
{ "success": true, "data": { "status": "rejected" } }
```

---

### GET `/api/operator/products`

自分のサービスアカウントの商品一覧。`?server_id=<number>` 必須。

---

### POST `/api/operator/products`

商品を追加します。

**リクエスト Body** (JSON):

| フィールド    | 型     | 必須 | 説明                           |
| ------------- | ------ | ---- | ------------------------------ |
| `server_id`   | number | ✅   | サービスアカウント ID          |
| `name`        | string | ✅   | 商品名（最大 200 文字）        |
| `price`       | number | ✅   | 価格（正の整数、最大 1,000,000）|
| `description` | string | ❌   | 説明（最大 500 文字）          |

**レスポンス** (201): 作成した商品オブジェクト

---

### PATCH `/api/operator/products/:id`

商品を更新します。Body は POST と同じ形式（変更したいフィールドのみ）。`is_active` で有効/無効切替可能。

---

### DELETE `/api/operator/products/:id`

商品を無効化します（物理削除はしません。取引履歴との整合性保持のため）。

**Body**: `{ "server_id": <number> }`

---

### POST `/api/operator/service-accounts`

サービスアカウントを新規作成します。**1 ユーザー 1 アカウントまで**。

**Body**: `{ "name": "MyServer" }`

**レスポンス** (201):
```json
{
  "success": true,
  "data": {
    "account": { "id": 1, "name": "MyServer" },
    "api_key": "skp_xxxxxxxxxxxxxxxx"
  }
}
```

> ⚠️ `api_key` はこのレスポンスでのみ返されます。再表示は不可能です。

---

### PATCH `/api/operator/service-accounts/:id`

サービスアカウントを更新します（OAuth のコールバック URL 設定など）。

**Body**: `{ "redirect_uris": ["https://yourapp.example.com/callback"] }`

---

### DELETE `/api/operator/service-accounts/:id`

サービスアカウントを削除します（取引履歴がある場合は論理削除）。

---

### POST `/api/operator/service-accounts/:id/withdraw`

サービスアカウントの残高をオーナーの個人ポイントに引き出します。

**Body**: `{ "amount": 500 }`

**レスポンス**:
```json
{ "success": true, "message": "500pt を個人の残高に引き出しました" }
```

---

## 7. サブスクリプション API (`/api/server/subscription`)

すべてのエンドポイントで `X-API-Key: <API_KEY>` が必須。  
定期課金（月額など）を実装するための API です。

### フロー概要

```
プラグイン                      ポイントサーバー                  ユーザー（Web）
   │  POST /initiate              │                                │
   │ ─────────────────────────→  │                                │
   │  ← subscription_id          │  ダッシュボードに通知          │
   │                              │ ──────────────────────────→   │
   │  GET /:id (ポーリング)       │    POST /subscription/:id/approve
   │ ─────────────────────────→  │  ←────────────────────────── │
   │  ← status: active           │                                │
   │
   │  （次回課金日到来後）
   │  POST /:id/charge
   │ ─────────────────────────→  │
   │  ← status: active / suspended
```

---

### POST `/api/server/subscription/initiate`

サブスクリプションを登録開始します。ユーザーのダッシュボードに承認待ちが表示されます。

**リクエスト Body** (JSON):

| フィールド     | 型     | 必須 | 説明                                     |
| -------------- | ------ | ---- | ---------------------------------------- |
| `username`     | string | ✅   | 購入者の Discourse ユーザー名            |
| `product_id`   | number | ✅   | 商品 ID（正の整数）                      |
| `interval_days`| number | ✅   | 課金間隔（日数、正の整数）               |

**レスポンス** (201):
```json
{
  "success": true,
  "data": {
    "subscription_id": 1,
    "username": "Player1",
    "product_name": "月額プラン",
    "amount": 1000,
    "interval_days": 30,
    "status": "pending_user",
    "web_url": "https://points.bac0n.f5.si/dashboard",
    "message": "ダッシュボードからユーザーの承認を待っています"
  }
}
```

---

### GET `/api/server/subscription`

自サーバーのサブスク一覧を返します。

---

### GET `/api/server/subscription/:id`

特定サブスクの状態確認（ポーリング用）。

**ステータス一覧**:

| status         | 意味                               |
| -------------- | ---------------------------------- |
| `pending_user` | ユーザーの初回承認待ち             |
| `active`       | 有効（課金継続中）                 |
| `suspended`    | 残高不足で停止中                   |
| `cancelled`    | キャンセル済み                     |

---

### POST `/api/server/subscription/:id/charge`

課金を実行します。`next_charge_at` が到来していない場合は **HTTP 425** を返します（二重課金防止）。  
残高不足の場合は **HTTP 402** を返し、ステータスが `suspended` に変わります。

**レスポンス**:
```json
{
  "success": true,
  "data": {
    "status": "active",
    "amount": 1000,
    "next_charge_at": "2025-02-01T00:00:00Z"
  }
}
```

---

### DELETE `/api/server/subscription/:id`

サーバー側からサブスクをキャンセルします。

---

## 8. OAuth 2.0 (`/oauth`)

外部ウェブアプリがポイントシステムのユーザー情報や取引機能を利用するための **OAuth 2.0 Authorization Code フロー**です。  
主な用途: **ウェブアプリからの取引開始**（`tx/initiate` の `buyer_token` として使用）。

### スコープ一覧

| スコープ      | 権限                                                         |
| ------------- | ------------------------------------------------------------ |
| `identity`    | ユーザー名・ポイント残高の読み取り                           |
| `transaction` | ユーザーの同意のもとで取引を開始する権限（`buyer_token` 用）|

---

### フロー概要

```
外部Webアプリ                     ポイントサーバー              ユーザー（ブラウザ）
   │                               │                             │
   │  1. リダイレクト              │                             │
   │ ─────────────────────────────────────────────────────→     │
   │  GET /oauth/authorize?...     │                             │
   │                               │  2. 同意画面を表示          │
   │                               │ ←─────────────────────────  │
   │                               │  3. POST /oauth/authorize   │
   │                               │    (action=allow)           │
   │  4. リダイレクト: ?code=...   │                             │
   │ ←─────────────────────────────────────────────────────── │
   │  5. POST /api/oauth/token     │                             │
   │ ─────────────────────────→   │                             │
   │  ← access_token + refresh_token                            │
```

---

### GET `/oauth/authorize`

ユーザーを同意画面にリダイレクトさせます。ログイン未済の場合は Discourse 認証へ誘導されます。

**クエリパラメータ**:

| パラメータ    | 必須 | 説明                                               |
| ------------- | ---- | -------------------------------------------------- |
| `client_id`   | ✅   | サービスアカウント ID（数値）                      |
| `redirect_uri`| ✅   | 登録済みコールバック URL                           |
| `scope`       | ✅   | スペース区切りスコープ（例: `identity transaction`）|
| `state`       | ❌   | CSRF 防止用ランダム文字列（推奨）                  |

**ユーザーが同意すると**: `redirect_uri?code=<認可コード>&state=<state>` にリダイレクト  
**ユーザーが拒否すると**: `redirect_uri?error=access_denied&state=<state>` にリダイレクト

---

### POST `/api/oauth/token`

認可コードをアクセストークンに交換します。またはリフレッシュトークンで更新します。

**Body** (JSON または `application/x-www-form-urlencoded`):

| フィールド      | 必須                    | 説明                                              |
| --------------- | ----------------------- | ------------------------------------------------- |
| `grant_type`    | ✅                      | `authorization_code` または `refresh_token`       |
| `client_id`     | ✅                      | サービスアカウント ID                             |
| `client_secret` | ✅                      | APIキー（`skp_...`）                              |
| `code`          | ✅ (authorization_code) | 認可コード                                        |
| `redirect_uri`  | ✅ (authorization_code) | 申請時と同一の URL                                |
| `refresh_token` | ✅ (refresh_token)      | リフレッシュトークン                              |

**レスポンス**:
```json
{
  "access_token":  "<アクセストークン>",
  "token_type":    "Bearer",
  "expires_in":    3600,
  "refresh_token": "<リフレッシュトークン>",
  "scope":         "identity transaction"
}
```

---

### POST `/api/oauth/revoke`

トークン（アクセス or リフレッシュ）を失効させます。RFC 7009 準拠。

**Body** (JSON):

| フィールド      | 必須 | 説明                  |
| --------------- | ---- | --------------------- |
| `token`         | ✅   | 失効させるトークン    |
| `client_id`     | ✅   | サービスアカウント ID |
| `client_secret` | ✅   | APIキー（`skp_...`）  |

**レスポンス**: `{ "success": true }` （存在しないトークンでもエラーにしません）

---

### ウェブアプリからの取引実装例

```bash
# 1. ユーザーを同意画面へリダイレクト
#    https://points.bac0n.f5.si/oauth/authorize
#      ?client_id=1&redirect_uri=https://yourapp.example.com/callback
#      &scope=transaction&state=random_state

# 2. コールバックで認可コードを受け取り、トークンと交換
curl -s -X POST https://points.bac0n.f5.si/api/oauth/token \
  -H 'Content-Type: application/json' \
  -d '{
    "grant_type":    "authorization_code",
    "client_id":     1,
    "client_secret": "skp_xxxxxxxxxxxxxxxx",
    "code":          "<認可コード>",
    "redirect_uri":  "https://yourapp.example.com/callback"
  }'
# → access_token を取得

# 3. buyer_token として tx/initiate に渡す
curl -s -X POST https://points.bac0n.f5.si/api/server/tx/initiate \
  -H 'X-API-Key: skp_xxxxxxxxxxxxxxxx' \
  -H 'Content-Type: application/json' \
  -d '{
    "buyer_token": "<access_token>",
    "product_id":  1
  }'
```

---

## 9. 通報 API (`/api/report`)

セッション認証必須。1 時間に 5 件超で自動アカウント停止。

### POST `/api/report`

**リクエスト Body** (JSON):

| フィールド    | 型     | 必須 | 説明                                                              |
| ------------- | ------ | ---- | ----------------------------------------------------------------- |
| `category`    | string | ✅   | `scam` / `other`                                                  |
| `description` | string | ✅   | 20〜2000 文字の詳細説明                                          |

**レスポンス**:
```json
{ "success": true, "message": "通報を受け付けました。ご協力ありがとうございます。" }
```

---

## 10. 管理者 API (`/admin`)

`Authorization: Bearer <ADMIN_TOKEN>` が必須。

### GET `/admin/reports`

全通報一覧（未処理が先頭）。

### PATCH `/admin/reports/:id/dismiss`

通報を処理済みにする。

### PATCH `/admin/users/:id/unsuspend`

アカウント停止を解除する。

**レスポンス**:
```json
{ "success": true, "data": { "id": 5, "username": "Player1" } }
```

### POST `/admin/test/purchase-flow`

**Minecraft なしで購入フロー全体をテスト**します。開発・デバッグ用。  
指定した `buyer_mc_id` で initiate → buyer-approve → seller-approve を連続実行し、残高の保全 (conservation) を検証します。

**リクエスト Body** (JSON):

| フィールド         | 型     | 必須 | 説明               |
| ------------------ | ------ | ---- | ------------------ |
| `buyer_mc_id`      | string | ✅   | 購入者 Minecraft ID |
| `seller_server_id` | number | ✅   | サービスアカウント ID |
| `product_id`       | number | ✅   | 商品 ID             |

**レスポンス**:
```json
{
  "success": true,
  "data": {
    "tx_id":              42,
    "status":             "completed",
    "amount":             500,
    "buyer_before":       1000,
    "buyer_after":        500,
    "server_before":      0,
    "server_after":       500,
    "conservation_check": true
  }
}
```

**curl 例**:
```bash
curl -s -X POST https://points.bac0n.f5.si/admin/test/purchase-flow \
  -H 'Authorization: Bearer <ADMIN_API_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "buyer_mc_id":      "Player1",
    "seller_server_id": 1,
    "product_id":       1
  }'
```

---

## 11. エラーコード一覧

| HTTP | 意味                                               |
| ---- | -------------------------------------------------- |
| 400  | リクエストバリデーションエラー                     |
| 401  | 未認証（ログイン必要・API キー未設定）             |
| 402  | ポイント残高不足                                   |
| 403  | アカウント停止中 / 権限なし                        |
| 404  | リソースが見つからない                             |
| 409  | 状態の競合（すでに承認済み等）                     |
| 410  | 有効期限切れ                                       |
| 429  | レートリミット超過                                 |
| 500  | サーバー内部エラー                                 |

---

## 12. 補足: 公開・その他 API

### GET `/api/points/check`

誰でも利用可能なポイント確認 API です。認証不要。

**クエリパラメータ**:
- `username` or `minecraft_id`

**レスポンス**:
```json
{
  "success": true,
  "data": {
    "username": "Player1",
    "points": 1000,
    "minecraft_id": "Player1"
  }
}
```

### GET `/api/points/history`

ログイン中のユーザーのポイント履歴を取得します。**セッション認証必須**。

**クエリパラメータ**:
- `limit`: 取得件数（デフォルト 50, 最大 200）

### GET `/api/user`

ログイン中のユーザー情報を取得します。**セッション認証必須**。
