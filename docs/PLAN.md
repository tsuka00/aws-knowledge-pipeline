# ナレッジパイプライン設計書

## Context
LayerXの事例を参考に、スプレッドシートをUIとした社内ナレッジ(FAQ)管理パイプラインを構築する。
ビジネスサイドがスプレッドシート上で自然言語で Q&A を管理し、GAS → API Gateway → Lambda の流れで Lambda 側で Markdown に変換・統一してから S3 に格納、Knowledge Bases でベクトル化・検索可能にする。

## 命名規則

フォーマット: `{project}-{env}-{resource}-{role}`

- **project**: `kp`
- **env**: `prod`, `dev`

### AWS リソース命名一覧

| リソース | 命名 | 説明 |
|----------|------|------|
| S3 バケット | `kp-{env}-s3-data` | ナレッジMarkdown格納用 |
| Lambda 関数 | `kp-{env}-lambda-handler` | ナレッジ管理ハンドラー |
| API Gateway | `kp-{env}-apigw-knowledge` | REST API エンドポイント |
| Knowledge Base | `kp-{env}-kb-faq` | FAQ ナレッジベース |
| S3 Vectors | `kp-{env}-s3vectors-faq` | ベクトルストア |
| IAM ロール (Lambda) | `kp-{env}-iam-lambda-exec` | Lambda 実行ロール |
| IAM ユーザー | `kp-{env}-iam-deploy` | デプロイ・運用用 IAM ユーザー |
| API Gateway APIキー | `kp-{env}-apigw-key` | GAS からのアクセス用 |
| API Gateway 使用量プラン | `kp-{env}-apigw-plan` | レート制限用 |

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

## 1. スプレッドシート列構成

| 列 | 内容 | 備考 |
|----|------|------|
| A  | チェックボックス | 操作対象の行を選択 |
| B  | No | `KB-{UUID8桁}` 形式。GAS側で生成。列はシート保護 |
| C  | 質問 | **自然言語**（ビジネスサイドが入力） |
| D  | 回答 | **自然言語**（ビジネスサイドが入力） |
| E  | カテゴリ | メタデータフィルタリング用 |
| F  | 参照URL | ソース元URL |
| G  | 更新日 | 最終同期日時（自動セット） |
| H  | ステータス | 同期状態: 未同期 / 同期済 / エラー |

- 1行目はヘッダー行
- B列（No）はシート保護（GUI操作）で手動編集不可にする
- C列・D列は自然言語で入力。Markdown変換はLambda側で行う

## 2. GAS (Google Apps Script)

### No 自動生成ロジック（事故防止設計）
- 形式: `KB-{UUID先頭8桁}` (例: `KB-a1b2c3d4`)
- `Utilities.getUuid()` で UUID を生成し、先頭8桁を使用
- **追加時のみ** No を生成。以下のガードを入れる:
  - B列（No）に値がある行は追加対象から除外（二重生成防止）
  - 追加前に確認ダイアログを表示（`ui.alert`で対象行数を表示）
  - 生成した No は即座にシートに書き込み、API呼び出し失敗時もNoは維持（S3側にはまだ存在しないのでステータスを「エラー」にする）
- **差分更新/削除**: B列に No がない行はスキップ（警告表示）

### カスタムメニュー
`onOpen()` で以下の3つのメニューを追加:

| メニュー | 機能 | ガード条件 |
|----------|------|------------|
| ナレッジ同期 > 追加 | チェック行を新規追加 | No が空の行のみ対象 |
| ナレッジ同期 > 差分更新 | チェック行の内容を更新 | No がある行のみ対象 |
| ナレッジ同期 > 削除 | S3 / KB から削除 | No がある行のみ対象 |

### 処理フロー（追加の場合）
1. チェックボックスが ON かつ No が空の行を収集
2. 対象行数を確認ダイアログで表示 → キャンセル可
3. 各行に `KB-{UUID8桁}` を生成しB列に即座に書き込み
4. 行データ（自然言語のまま）を JSON に変換し API Gateway へ POST
5. レスポンスを元に更新日 / ステータスを更新
6. 処理後、チェックボックスを OFF に戻す

### 処理フロー（差分更新の場合）
1. チェックボックスが ON かつ No がある行を収集
2. 対象行数を確認ダイアログで表示 → キャンセル可
3. 行データ（自然言語のまま）を JSON に変換し API Gateway へ POST
4. レスポンスを元に更新日 / ステータスを更新
5. 処理後、チェックボックスを OFF に戻す

### 処理フロー（削除の場合）
1. チェックボックスが ON かつ No がある行を収集
2. 対象行数を確認ダイアログで表示（削除は特に注意喚起）→ キャンセル可
3. API Gateway へ DELETE リクエスト POST
4. 成功した行のステータスを「削除済」に更新、No はそのまま残す（履歴として）
5. 処理後、チェックボックスを OFF に戻す

### ファイル構成
```
gas/
├── Code.gs          # メイン（メニュー、共通関数、No生成）
├── api.gs           # API呼び出し
└── config.gs        # API URL、APIキーなどの設定
```

## 3. Lambda (Python)

### Markdown 変換ロジック
GAS から自然言語で受け取った質問・回答を Lambda 側で Markdown に変換・統一する。
フォーマットの違いによるノイズを排除し、安定した検索性能を実現する。

変換ルール:
- 質問 → `# {質問文}` (H1見出し)
- 回答 → 本文として整形（改行の正規化、段落分け）
- カテゴリ → メタデータファイルに格納
- 参照URL → メタデータファイルに格納

### エンドポイント設計（単一Lambda、action パラメータで分岐）

```json
POST /knowledge
{
  "action": "add" | "update" | "delete",
  "items": [
    {
      "no": "KB-a1b2c3d4",
      "question": "自然言語の質問文",
      "answer": "自然言語の回答文",
      "category": "...",
      "source_url": "..."
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
      "message": "...",
      "updated_at": "2026-02-16T12:00:00+09:00"
    }
  ]
}
```

### S3 ファイル構成
```
s3://kp-{env}-s3-data/
└── knowledge/
    ├── KB-a1b2c3d4.md              # Markdown変換済みナレッジ本文
    ├── KB-a1b2c3d4.metadata.json   # メタデータ
    ├── KB-e5f6g7h8.md
    ├── KB-e5f6g7h8.metadata.json
    └── ...
```

### Markdown ファイル形式 (例: `KB-a1b2c3d4.md`)
Lambda が自然言語から変換して生成:
```markdown
# 有給休暇の申請方法を教えてください

有給休暇を申請するには、社内ポータルの「勤怠管理」メニューから「休暇申請」を選択してください。

申請は希望日の3営業日前までに行う必要があります。上長の承認後、人事部で処理されます。
```

### メタデータファイル形式 (例: `KB-a1b2c3d4.metadata.json`)
```json
{
  "metadataAttributes": {
    "no": "KB-a1b2c3d4",
    "category": "人事",
    "source_url": "https://...",
    "updated_at": "2026-02-16T12:00:00+09:00"
  }
}
```
※ Knowledge Bases の S3 メタデータフィルタリング規約に準拠

### 処理概要
- **add**: 自然言語→Markdown変換 → `.md` と `.metadata.json` を S3 に PUT → KB 同期開始
- **update**: 自然言語→Markdown変換 → 既存ファイルを上書き → KB 同期開始
- **delete**: `.md` と `.metadata.json` を S3 から DELETE → KB 同期開始
- KB 同期: `bedrock_agent.start_ingestion_job()` を呼び出し（バッチで1回のみ）

### ファイル構成
```
lambda/
├── lambda_function.py   # ハンドラー + ビジネスロジック + Markdown変換
└── requirements.txt     # boto3 は Lambda ランタイムに含まれるため基本不要
```

## 4. AWS インフラ

### IAM ユーザー: `kp-{env}-iam-deploy`
プロジェクト単位で作成する IAM ユーザー。Lambda デプロイおよび S3 / Bedrock 操作用。

#### 付与するポリシー（カスタムポリシー推奨）
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:GetFunction",
        "lambda:InvokeFunction"
      ],
      "Resource": "arn:aws:lambda:*:*:function:kp-*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::kp-*",
        "arn:aws:s3:::kp-*/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:StartIngestionJob",
        "bedrock:GetIngestionJob",
        "bedrock:GetKnowledgeBase"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "apigateway:GET",
        "apigateway:POST"
      ],
      "Resource": "arn:aws:apigateway:*::/restapis/*"
    }
  ]
}
```

### IAM ロール (Lambda 実行): `kp-{env}-iam-lambda-exec`
Lambda が S3 / Bedrock にアクセスするためのロール。

#### 信頼ポリシー
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

#### 実行ポリシー
- `AWSLambdaBasicExecutionRole`（CloudWatch Logs）
- カスタムポリシー: S3 (kp-*) の読み書き削除 + Bedrock の StartIngestionJob

### 必要リソースまとめ

| リソース | 名前 | 備考 |
|----------|------|------|
| IAM ユーザー | `kp-{env}-iam-deploy` | デプロイ・運用用 |
| IAM ロール | `kp-{env}-iam-lambda-exec` | Lambda 実行ロール |
| S3 バケット | `kp-{env}-s3-data` | ナレッジ格納 |
| Lambda | `kp-{env}-lambda-handler` | Python 3.12 |
| API Gateway | `kp-{env}-apigw-knowledge` | REST API + APIキー |
| Knowledge Base | `kp-{env}-kb-faq` | S3 データソース |
| S3 Vectors | `kp-{env}-s3vectors-faq` | ベクトルストア |

## 5. 実装順序

| Step | 内容 | 成果物 |
|------|------|--------|
| 1 | Lambda 関数の実装 | `lambda/lambda_function.py` |
| 2 | GAS コードの実装 | `gas/Code.gs`, `gas/api.gs`, `gas/config.gs` |
| 3 | AWS リソース構築手順書 | `docs/aws-setup.md` |

## 6. 検証方法
1. Lambda をローカルでテスト（イベント JSON を使った単体テスト）
2. AWS にデプロイ後、API Gateway 経由で curl テスト
3. スプレッドシートからカスタムメニューで E2E テスト
4. Knowledge Bases で検索クエリを実行し、結果を確認
