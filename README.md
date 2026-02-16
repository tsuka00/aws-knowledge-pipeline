# Knowledge Pipeline

スプレッドシートを UI とした社内ナレッジ（FAQ）管理パイプライン。

ビジネスサイドがスプレッドシート上で自然言語で Q&A を管理し、GAS → API Gateway → Lambda の流れで Markdown に変換して S3 に格納、Amazon Bedrock Knowledge Bases でベクトル化・検索可能にする。

## アーキテクチャ

```
スプレッドシート (UI)
    ↓ カスタムメニュー操作
GAS (Google Apps Script)
    ↓ HTTP POST (JSON)
API Gateway (APIキー認証)
    ↓
Lambda (Python 3.12 / Markdown変換)
    ↓
S3 → Knowledge Bases → S3 Vectors
```

## ディレクトリ構成

```
.
├── gas/
│   ├── Code.gs          # メニュー、No生成、フロー制御
│   ├── api.gs           # API Gateway 呼び出し
│   └── config.gs        # API URL、APIキー等の設定
├── lambda/
│   ├── lambda_function.py   # ハンドラー + Markdown変換 + S3操作 + KB同期
│   ├── requirements.txt
│   └── events/              # ローカルテスト用イベントJSON
│       ├── event_add.json
│       ├── event_update.json
│       └── event_delete.json
└── docs/
    ├── PLAN.md          # 設計書
    ├── TODO.md          # タスク管理
    └── aws-setup.md     # AWSリソース構築手順書
```

## スプレッドシート列構成

| 列 | 内容 | 備考 |
|----|------|------|
| A | チェックボックス | 操作対象の行を選択 |
| B | No | `KB-{UUID8桁}` 形式（自動生成） |
| C | 質問 | 自然言語で入力 |
| D | 回答 | 自然言語で入力 |
| E | カテゴリ | メタデータフィルタリング用 |
| F | 参照URL | ソース元URL |
| G | 更新日 | 最終同期日時（自動） |
| H | ステータス | 未同期 / 同期済 / エラー / 削除済 |

## 操作方法

スプレッドシートの「ナレッジ同期」メニューから実行する。

| メニュー | 機能 | 対象 |
|----------|------|------|
| 追加 | チェック行を新規追加 | No が空の行 |
| 差分更新 | チェック行の内容を更新 | No がある行 |
| 削除 | S3 / KB から削除 | No がある行 |

## AWS リソース

| リソース | 命名規則 |
|----------|----------|
| S3 バケット | `kp-{env}-s3-data` |
| S3 Vectors | `kp-{env}-s3vectors-faq` |
| Lambda | `kp-{env}-lambda-handler` |
| API Gateway | `kp-{env}-apigw-knowledge` |
| Knowledge Base | `kp-{env}-kb-faq` |
| IAM ロール (Lambda) | `kp-{env}-iam-lambda-exec` |
| IAM ロール (KB) | `kp-{env}-iam-kb-exec` |

詳細な構築手順は [docs/aws-setup.md](docs/aws-setup.md) を参照。

## Lambda デプロイ

```bash
cd lambda
zip lambda.zip lambda_function.py
aws lambda update-function-code \
  --function-name kp-dev-lambda-handler \
  --zip-file fileb://lambda.zip
```

## GAS セットアップ

1. スプレッドシートの「拡張機能 > Apps Script」を開く
2. `Code.gs`、`api.gs`、`config.gs` の3ファイルを作成してコードを貼り付け
3. `config.gs` の `API_URL` と `API_KEY` を設定
4. 保存してスプレッドシートをリロード
