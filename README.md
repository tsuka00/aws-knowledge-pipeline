# Knowledge Pipeline

スプレッドシートを UI とした社内ナレッジ（FAQ）管理パイプライン。

ビジネスサイドがスプレッドシート上で自然言語で Q&A を管理し、GAS → API Gateway → Lambda の流れで Markdown に変換・統一してから S3 に格納、Amazon Bedrock Knowledge Bases でベクトル化・検索可能にする。

## アーキテクチャ

```
スプレッドシート (UI) ← ビジネスサイドが自然言語で入力
    ↓ カスタムメニュー操作
GAS (Google Apps Script) ← No自動生成、バリデーション
    ↓ HTTP POST (JSON / 自然言語のまま)
API Gateway (kp-{env}-apigw-knowledge / APIキー認証)
    ↓
Lambda (kp-{env}-lambda-handler / Python 3.12) ← 自然言語 → Markdown 変換
    ↓
S3 (kp-{env}-s3-data) → Knowledge Bases (kp-{env}-kb-faq) → S3 Vectors (kp-{env}-s3vectors-faq)
```

## ディレクトリ構成

```
.
├── gas/
│   ├── Code.gs              # メニュー、No生成、フロー制御
│   ├── api.gs               # API Gateway 呼び出し
│   └── config.gs            # API URL、APIキー等の設定
├── lambda/
│   ├── lambda_function.py   # ハンドラー + Markdown変換 + S3操作 + KB同期
│   ├── requirements.txt
│   └── events/              # ローカルテスト用イベントJSON
│       ├── event_add.json
│       ├── event_update.json
│       └── event_delete.json
└── docs/
    ├── PLAN.md              # 設計書
    ├── TODO.md              # タスク管理
    └── aws-setup.md         # AWSリソース構築手順書
```

## 命名規則

フォーマット: `{project}-{env}-{resource}-{role}`

- **project**: `kp`
- **env**: `prod`, `dev`

## AWS リソース

| リソース | 命名 | 説明 |
|----------|------|------|
| S3 バケット | `kp-{env}-s3-data` | ナレッジ Markdown 格納用 |
| S3 Vectors | `kp-{env}-s3vectors-faq` | ベクトルストア |
| Lambda | `kp-{env}-lambda-handler` | ナレッジ管理ハンドラー |
| API Gateway | `kp-{env}-apigw-knowledge` | REST API エンドポイント |
| API Gateway APIキー | `kp-{env}-apigw-key` | GAS からのアクセス用 |
| API Gateway 使用量プラン | `kp-{env}-apigw-plan` | レート制限用 |
| Knowledge Base | `kp-{env}-kb-faq` | FAQ ナレッジベース |
| IAM ユーザー | `kp-{env}-iam-deploy` | デプロイ・運用用 |
| IAM ロール (Lambda) | `kp-{env}-iam-lambda-exec` | Lambda 実行ロール |
| IAM ロール (KB) | `kp-{env}-iam-kb-exec` | Knowledge Base 実行ロール |

### dev 環境の実リソース ID

| リソース | ID / ARN |
|----------|----------|
| API Gateway | `w6mmssb4jl` |
| Knowledge Base | `XKAQUQ91SM` |
| Data Source | `0B2RFUVWUR` |
| API エンドポイント | `https://w6mmssb4jl.execute-api.ap-northeast-1.amazonaws.com/prod/knowledge` |

詳細な構築手順は [docs/aws-setup.md](docs/aws-setup.md) を参照。

## スプレッドシート

### 列構成

| 列 | 内容 | 備考 |
|----|------|------|
| A | チェックボックス | 操作対象の行を選択 |
| B | No | `KB-{UUID8桁}` 形式。GAS で自動生成。シート保護で手動編集不可 |
| C | 質問 | 自然言語で入力 |
| D | 回答 | 自然言語で入力 |
| E | カテゴリ | メタデータフィルタリング用 |
| F | 参照URL | ソース元URL |
| G | 更新日 | 最終同期日時（自動セット） |
| H | ステータス | 未同期 / 同期済 / エラー / 削除済 |

1行目はヘッダー行。B列はシート保護（GUI操作）で手動編集不可にする。

### 操作方法

スプレッドシートの「ナレッジ同期」メニューから実行する。

| メニュー | 機能 | 対象 | ガード条件 |
|----------|------|------|------------|
| 追加 | チェック行を新規追加 | No が空の行 | 確認ダイアログあり。No 生成後に API 呼び出し |
| 差分更新 | チェック行の内容を更新 | No がある行 | No がない行はスキップ（警告表示） |
| 削除 | S3 / KB から削除 | No がある行 | 削除は注意喚起付き確認ダイアログ |

### 処理フロー（追加の場合）

1. チェックボックスが ON かつ No が空の行を収集
2. 対象行数を確認ダイアログで表示 → キャンセル可
3. 各行に `KB-{UUID8桁}` を生成し B列に即座に書き込み
4. 行データ（自然言語のまま）を JSON に変換し API Gateway へ POST
5. レスポンスを元に更新日 / ステータスを更新
6. 処理後、チェックボックスを OFF に戻す

## API 仕様

### リクエスト

```
POST /knowledge
x-api-key: {APIキー}
Content-Type: application/json
```

```json
{
  "action": "add" | "update" | "delete",
  "items": [
    {
      "no": "KB-a1b2c3d4",
      "question": "自然言語の質問文",
      "answer": "自然言語の回答文",
      "category": "カテゴリ名",
      "source_url": "https://..."
    }
  ]
}
```

### レスポンス

```json
{
  "results": [
    {
      "no": "KB-a1b2c3d4",
      "status": "success" | "error",
      "message": "Success",
      "updated_at": "2026-02-16T12:00:00+09:00"
    }
  ]
}
```

## S3 ファイル構成

```
s3://kp-{env}-s3-data/
└── knowledge/
    ├── KB-a1b2c3d4.md              # Markdown変換済みナレッジ本文
    ├── KB-a1b2c3d4.metadata.json   # メタデータ（KB S3フィルタリング規約準拠）
    └── ...
```

### Markdown 変換ルール（Lambda 側で実行）

- 質問 → `# {質問文}` (H1 見出し)
- 回答 → 本文として整形（改行の正規化、段落分け）
- カテゴリ / 参照URL → `.metadata.json` に格納

## セットアップ

### GAS

1. スプレッドシートの「拡張機能 > Apps Script」を開く
2. `Code.gs`、`api.gs`、`config.gs` の 3 ファイルを作成してコードを貼り付け
3. `config.gs` の `API_URL` と `API_KEY` を実際の値に書き換え
4. 保存してスプレッドシートをリロード → メニュー「ナレッジ同期」が表示される

### Lambda デプロイ

`kp-dev-iam-deploy` ユーザーのクレデンシャルを使用する。

```bash
cd lambda
zip lambda.zip lambda_function.py
aws lambda update-function-code \
  --function-name kp-dev-lambda-handler \
  --zip-file fileb://lambda.zip
```

### AWS リソース構築

[docs/aws-setup.md](docs/aws-setup.md) を参照。
