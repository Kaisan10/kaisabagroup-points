# かい鯖グループポイント 連携ガイド

言語非依存の汎用REST API連携ガイドです。curl例を中心に説明します。

---

## はじめに

- APIはJSON over HTTPです。どの言語・環境からでも利用できます
- 認証はAPIキー（`X-API-Key` ヘッダ）を使用します
- ベースURL: `https://points.bac0n.f5.si`

---

## Step 1: アプリ・サービスを登録する

1. `https://points.bac0n.f5.si/settings` にアクセス
2. 設定タブの「サービスアカウント」の作成ボタンを押す
3. アプリ名を入力して登録リクエストを送信
4. 発行された登録トークンを使ってWebページで承認
5. APIキー（`skp_` で始まる文字列）を取得・保存

> **注意**: APIキーは一度しか表示されません。必ず安全な場所に保存してください。

---

## Step 2: 認証

すべてのAPIリクエストに `X-API-Key` ヘッダを付与します。

```bash
curl -H "X-API-Key: skp_your_key_here" \
  https://points.bac0n.f5.si/api/server/balance
```

---

## エンドポイント一覧

### ユーザー残高確認

```bash
# Minecraftユーザー名で検索
GET /api/server/player/:minecraft_id

# フォーラムユーザー名で検索（認証不要）
GET /api/points/check?username=:username
```

**例: minecraft_id で検索**

```bash
curl -H "X-API-Key: skp_xxx" \
  https://points.bac0n.f5.si/api/server/player/Steve
```

```json
{
  "success": true,
  "data": {
    "username": "Steve123",
    "minecraft_id": "Steve",
    "points": 1500
  }
}
```

---

### 取引フロー（都度ポイント消費）

ポイント消費はユーザーのWeb承認が必要な2ステップフローです。

#### Step 1: 取引を開始する

```bash
POST /api/server/tx/initiate

{
  "mc_id": "Steve",
  "product_id": 1
}
```

```bash
curl -X POST \
  -H "X-API-Key: skp_xxx" \
  -H "Content-Type: application/json" \
  -d '{"mc_id":"Steve","product_id":1}' \
  https://points.bac0n.f5.si/api/server/tx/initiate
```

```json
{
  "success": true,
  "data": {
    "tx_token": "ABCD1234...",
    "amount": "500",
    "item_name": "VIPランク",
    "expires_at": "2026-01-01T00:05:00Z",
    "web_url": "https://points.bac0n.f5.si/dashboard",
    "message": "購入金額: 500pt / ダッシュボードから承認してください"
  }
}
```

ユーザーにダッシュボードへのアクセスを案内してください。

#### Step 2: ユーザー承認を待つ（ポーリング）

```bash
GET /api/server/tx/:tx_token
```

```bash
curl -H "X-API-Key: skp_xxx" \
  https://points.bac0n.f5.si/api/server/tx/ABCD1234
```

```json
{
  "success": true,
  "data": {
    "status": "pending_seller"
  }
}
```

- `pending_buyer`: ユーザーが未承認
- `pending_seller`: ユーザー承認済み → アイテム付与してから `/approve` を呼ぶ
- `completed`: 取引完了
- `rejected`: 拒否
- `expired`: 期限切れ

#### Step 3: アイテム付与後にポイントを確定する

```bash
POST /api/server/tx/:tx_token/approve
```

```bash
curl -X POST \
  -H "X-API-Key: skp_xxx" \
  -H "Content-Type: application/json" \
  https://points.bac0n.f5.si/api/server/tx/ABCD1234/approve
```

> アプリがアイテム等を付与した後に `/approve` を呼ぶことでポイントが確定します。
> 付与前にエラーになった場合は `/approve` を呼ばないでください。

---

### 商品一覧の確認

```bash
GET /api/server/products
```

```bash
curl -H "X-API-Key: skp_xxx" \
  https://points.bac0n.f5.si/api/server/products
```

```json
{
  "success": true,
  "data": [
    { "id": 1, "name": "VIPランク", "price": "500", "description": "..." }
  ]
}
```

---

## サブスクリプション（定期課金）

定期課金（サブスクリプション）の実装について説明します。

### 概要

- **初回のみ** ユーザーのWeb承認が必要（初回課金も承認時に即時実行）
- 以降の課金は **サービス（アプリ）側が `next_charge_at` を確認し、期限到来時に `/charge` を叩く** ことで実行される
- ポイントシステム側は**サービス側が明示的にリクエストしない限り自動でポイントを引かない**
- `next_charge_at` + `interval_days` 日を超えても課金されなかった場合は自動で `suspended` に移行

### フロー

```text
サービス(アプリ)                ポイントシステム              ユーザー
  |                               |                         |
  |-- POST /subscription/initiate -->|                      |
  |<-- subscription_id: 1 ---------|                      |
  |                               |-- ダッシュボードに通知 -->|
  |                               |                         |
  |-- GET /subscription/1 (ポーリング)                      |
  |<-- status: pending ------------|    [承認する]           |
  |                               |<-- POST .../approve ----|
  |<-- status: active ------------|  (初回課金も即時実行)    |
  |                               |                         |
  | (サービス側が next_charge_at を監視)                    |
  |                               |                         |
  |-- GET /subscription/1 ------->|  (next_charge_at 到来) |
  |<-- next_charge_at: 過去の日時 --|                        |
  |-- POST /subscription/1/charge -->|                     |
  |<-- status: active, next_charge_at: 新しい日時 ----------|
```

### サブスク関連エンドポイント

#### サブスク登録開始

> **Note:** サービスアカウントはリクエストヘッダーの `X-API-Key` から自動的に判別されるため、JSONボディに指定する必要はありません。

```bash
POST /api/server/subscription/initiate
X-API-Key: skp_xxx
Content-Type: application/json

{
  "username": "フォーラムのユーザー名",
  "product_id": 1,
  "interval_days": 30
}
```

```json
{
  "success": true,
  "data": {
    "subscription_id": 1,
    "username": "User123",
    "product_name": "月額プラン",
    "amount": "500",
    "interval_days": 30,
    "status": "pending",
    "web_url": "https://points.bac0n.f5.si/dashboard"
  }
}
```

#### ステータス確認（ポーリング）

`next_charge_at` を確認して課金タイミングを判断します。

```bash
GET /api/server/subscription/1
X-API-Key: skp_xxx
```

```json
{
  "success": true,
  "data": {
    "id": 1,
    "status": "active",
    "next_charge_at": "2026-02-01T00:00:00Z"
  }
}
```

| status | 意味 |
|--------|------|
| `pending` | ユーザー未承認 |
| `active` | 有効（次回課金待ち） |
| `suspended` | 課金失敗または猶予超過で停止中 |
| `cancelled` | キャンセル済み |

#### 課金実行（サービス側から呼び出す）

`next_charge_at` が過去になったらこのエンドポイントを叩きます。
`next_charge_at` がまだ未来の場合は `425 Too Early` が返ります（二重課金防止）。

```bash
POST /api/server/subscription/1/charge
X-API-Key: skp_xxx
```

**成功レスポンス（200）:**

```json
{
  "success": true,
  "data": {
    "status": "active",
    "amount": "500",
    "next_charge_at": "2026-03-01T00:00:00Z"
  }
}
```

**エラーケース:**

| HTTPステータス | 意味 | 対処 |
|--------------|------|------|
| `425 Too Early` | まだ課金時期でない | `next_charge_at` まで待つ |
| `402 Payment Required` | 残高不足（`suspended` に移行済み） | ユーザーにポイント不足を通知 |
| `409 Conflict` | `active` 以外のステータス（pending/suspended/cancelled） | ステータスを確認 |
| `404 Not Found` | サブスクが存在しない | IDを確認 |

#### サブスク一覧

```bash
GET /api/server/subscription
X-API-Key: skp_xxx
```

#### サービス側からキャンセル

```bash
DELETE /api/server/subscription/42
X-API-Key: skp_xxx
```

### ユーザー側の動作

- ダッシュボードにバナーが表示される
- 「○○日ごとに○○ポイント利用されます」が明示される
- **初回課金は承認時点で即時実行**
- 次回以降の課金は **サービス側が `/charge` を叩いたときのみ実行**（ポイントは自動では引かれない）
- `suspended` 時はダッシュボードおよびブラウザ通知でユーザーに通知
- ユーザーはダッシュボードからキャンセル可能

### 実装例（Python）

```python
import requests
import time
from datetime import datetime, timezone

API_KEY = "skp_your_key"
BASE_URL = "https://points.bac0n.f5.si"

headers = {
    "X-API-Key": API_KEY,
    "Content-Type": "application/json"
}

# ① サブスク登録開始
res = requests.post(f"{BASE_URL}/api/server/subscription/initiate", headers=headers, json={
    "username": "User123",
    "product_id": 1,
    "interval_days": 30
})
data = res.json()
sub_id = data["data"]["subscription_id"]

# ② ユーザー承認待ちポーリング
while True:
    r = requests.get(f"{BASE_URL}/api/server/subscription/{sub_id}", headers=headers)
    info = r.json()["data"]
    if info["status"] == "active":
        print(f"サブスク有効化! 次回課金: {info['next_charge_at']}")
        break
    elif info["status"] == "cancelled":
        print("キャンセルされました")
        break
    time.sleep(5)

# ③ 定期課金ループ（起動時・定期チェックで呼ぶ）
def check_and_charge(sub_id):
    r = requests.get(f"{BASE_URL}/api/server/subscription/{sub_id}", headers=headers)
    info = r.json()["data"]

    if info["status"] != "active":
        return info["status"]

    next_charge = datetime.fromisoformat(info["next_charge_at"].replace("Z", "+00:00"))
    if datetime.now(timezone.utc) >= next_charge:
        charge_res = requests.post(
            f"{BASE_URL}/api/server/subscription/{sub_id}/charge",
            headers=headers
        )
        if charge_res.status_code == 200:
            data = charge_res.json()["data"]
            print(f"課金完了! 次回: {data['next_charge_at']}")
        elif charge_res.status_code == 402:
            print("残高不足 → suspended")
        else:
            print(f"課金エラー: {charge_res.status_code} {charge_res.text}")
    return info["status"]
```

### 注意事項

- **ポイントは `/charge` を叩いたときのみ引かれます。** サービスが落ちていても自動では引かれません。
- `next_charge_at` はドリフト防止のため前回の値に `interval_days` を加算して更新されます（遅れて叩いても次回が早まることはありません）。
- 猶予期間（`interval_days` 分）を過ぎても `/charge` が呼ばれなかった場合、ポイントシステム側のジョブが自動で `suspended` に変更します。
- サービス再起動時は必ず全サブスクの `next_charge_at` を確認し、過去になっているものに `/charge` を叩いてください。

---

## 信頼モード (Trusted Mode)

システム管理者がサービスアカウントに対して「信頼モード」を有効にすると、以下の拡張機能が利用できます。

### 1. IPアドレス制限
許可されたIPアドレスからのみAPIアクセスを受け付けるようになり、APIキー流出時のリスクを軽減できます。

### 2. 取引の自動承認 (Auto Approve)
ユーザー側がダッシュボード設定で「信頼サーバーの自動承認」をオンにしている場合、ポイント消費フローにおける「ユーザーのWeb承認 (pending_buyer)」プロセスをスキップできます。
取引開始（`POST /api/server/tx/initiate`）後、ステータスはすぐに `pending_seller` になり、即座にアイテムを付与して `/approve` を呼び出すことが可能になります。

### 3. 取引上限額制限 (Transaction Limit)
自動承認を安全に運用するため、1回の取引でのポイント消費上限額（`tx_limit`）を設定できます。上限を超える取引リクエストはエラー（403）となります。

> **注意**: 信頼モードの有効化やIP制限の設定は、システム管理者に依頼する必要があります。

---

## エラーレスポンス

すべてのエラーは以下の形式で返されます。

```json
{
  "success": false,
  "error": "エラーメッセージ"
}
```

| ステータス | 意味 |
|-----------|------|
| 401 | APIキーが無効または未指定 |
| 402 | 残高不足 |
| 404 | リソースが見つからない |
| 409 | 状態が不正（既に完了済みなど） |
| 429 | リクエスト過多 |
| 500 | サーバーエラー |
