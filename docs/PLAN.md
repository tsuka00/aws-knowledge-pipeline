# ナレッジパイプライン設計書（v2 — フィードバック反映版）

## Context
LayerXの事例を参考に、スプレッドシートをUIとした社内ナレッジ(FAQ)管理パイプラインを構築する。
ビジネスサイドがスプレッドシート上で自然言語で Q&A を管理し、GAS → API Gateway → Lambda の流れで Lambda 側で Markdown に変換・統一してから S3 に格納、Knowledge Bases でベクトル化・検索可能にする。

### v2 での主な変更点（フィードバック反映）
1. No 形式を `KB-{UUID8桁}` → `KB-{UUIDv4フル36桁}` に変更（衝突リスク排除）
2. API に `job_id` + `items[].row_number` を追加（書き戻しの安全性確保）
3. Markdown テンプレートを `## Question` / `## Answer` の構造化形式に変更
4. `.metadata.json` のスキーマを明示的に定義（キー名・型・制約）
5. 削除ステータスを `deleting` → `deleted` の2段階管理に変更
6. 将来改善パス（ingestion分離、追加メニュー分離、認証強化）を明記

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
GAS (Google Apps Script) ← No自動生成(UUIDv4フル)、バリデーション
    ↓ HTTP POST (JSON / job_id + row_number 付き)
API Gateway (kp-{env}-apigw-knowledge / APIキー認証)
    ↓
Lambda (kp-{env}-lambda-handler / Python 3.12) ← 自然言語 → Markdown 変換（構造化テンプレ）
    ↓
S3 (kp-{env}-s3-data) → Knowledge Bases (kp-{env}-kb-faq) → S3 Vectors (kp-{env}-s3vectors-faq)
```

## 1. スプレッドシート列構成

| 列 | 内容 | 備考 |
|----|------|------|
| A  | チェックボックス | 操作対象の行を選択 |
| B  | No | `KB-{UUIDv4}` 形式（例: `KB-550e8400-e29b-41d4-a716-446655440000`）。GAS側で生成。列はシート保護 |
| C  | 質問 | **自然言語**（ビジネスサイドが入力） |
| D  | 回答 | **自然言語**（ビジネスサイドが入力） |
| E  | カテゴリ | メタデータフィルタリング用 |
| F  | 参照URL | ソース元URL |
| G  | 更新日 | 最終同期日時（自動セット） |
| H  | ステータス | 同期状態: 未同期 / 同期済 / deleting / deleted / エラー |

- 1行目はヘッダー行
- B列（No）はシート保護（GUI操作）で手動編集不可にする
- C列・D列は自然言語で入力。Markdown変換はLambda側で行う

### ステータス遷移

```
(新規入力) → 未同期
未同期 → [追加成功] → 同期済
未同期 → [追加失敗] → エラー
同期済 → [差分更新成功] → 同期済（更新日が更新）
同期済 → [差分更新失敗] → エラー
同期済 → [削除実行] → deleting
deleting → [ingestion完了確認] → deleted
エラー → [再同期成功] → 同期済
```

## 2. GAS (Google Apps Script)

### No 自動生成ロジック（事故防止設計）
- 形式: `KB-{UUIDv4}` (例: `KB-550e8400-e29b-41d4-a716-446655440000`)
- `Utilities.getUuid()` で UUIDv4 を生成し、**フルの36桁をそのまま使用**（衝突リスク排除）
- **追加時のみ** No を生成。以下のガードを入れる:
  - B列（No）に値がある行は追加対象から除外（二重生成防止）
  - 追加前に確認ダイアログを表示（`ui.alert`で対象行数を表示）
  - 生成した No は即座にシートに書き込み、API呼び出し失敗時もNoは維持（ステータスを「エラー」にする）
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
3. 各行に `KB-{UUIDv4}` を生成しB列に即座に書き込み
4. `job_id`（UUID）を生成し、各行データに `row_number` を付与
5. JSON に変換し API Gateway へ POST
6. レスポンスの `row_number` を使って対応する行の更新日 / ステータスを更新
7. 処理後、チェックボックスを OFF に戻す

### 処理フロー（差分更新の場合）
1. チェックボックスが ON かつ No がある行を収集
2. 対象行数を確認ダイアログで表示 → キャンセル可
3. `job_id` を生成し、各行データに `row_number` を付与
4. JSON に変換し API Gateway へ POST
5. レスポンスの `row_number` を使って対応する行の更新日 / ステータスを更新
6. 処理後、チェックボックスを OFF に戻す

### 処理フロー（削除の場合）
1. チェックボックスが ON かつ No がある行を収集
2. 対象行数を確認ダイアログで表示（削除は特に注意喚起）→ キャンセル可
3. `job_id` を生成し、各行データに `row_number` を付与
4. API Gateway へ POST
5. 成功した行のステータスを `deleting` に更新、No はそのまま残す
6. 処理後、チェックボックスを OFF に戻す

※ `deleting` → `deleted` の遷移は、ingestion完了後に手動確認 or 将来的に自動化

### ファイル構成
```
gas/
├── Code.gs          # メイン（メニュー、共通関数、No生成）
├── api.gs           # API呼び出し
└── config.gs        # API URL、APIキーなどの設定
```

## 3. Lambda (Python)

### Markdown 変換ロジック（構造化テンプレート）
GAS から自然言語で受け取った質問・回答を Lambda 側で **構造化された Markdown テンプレート** に変換・統一する。
`# 質問` だけの単純なH1形式だと、検索時に質問文が過度に重み付けされたり、同一質問が増えた際に見出しが汚れる問題がある。
`## Question` / `## Answer` のセクション分けにより、質問と回答を均等に検索対象にできる。

#### テンプレート
```markdown
# FAQ

## Question
{question}

## Answer
{answer}

---
no: {no}
category: {category}
source: {source_url}
```

#### 変換例
入力:
- 質問: `有給休暇の申請方法を教えてください`
- 回答: `社内ポータルの「勤怠管理」メニューから「休暇申請」を選択してください。申請は希望日の3営業日前までに行う必要があります。`

出力:
```markdown
# FAQ

## Question
有給休暇の申請方法を教えてください

## Answer
社内ポータルの「勤怠管理」メニューから「休暇申請」を選択してください。

申請は希望日の3営業日前までに行う必要があります。

---
no: KB-550e8400-e29b-41d4-a716-446655440000
category: 人事
source: https://...
```

※ 回答テキストの正規化（改行コード統一、連続空行の圧縮、行末空白除去）も行う

### エンドポイント設計（単一Lambda、action パラメータで分岐）

```json
POST /knowledge
{
  "job_id": "uuid-for-this-request",
  "action": "add" | "update" | "delete",
  "items": [
    {
      "row_number": 2,
      "no": "KB-550e8400-e29b-41d4-a716-446655440000",
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
  "job_id": "uuid-for-this-request",
  "results": [
    {
      "row_number": 2,
      "no": "KB-550e8400-e29b-41d4-a716-446655440000",
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
    ├── KB-550e8400-e29b-41d4-a716-446655440000.md
    ├── KB-550e8400-e29b-41d4-a716-446655440000.metadata.json
    └── ...
```

### `.metadata.json` スキーマ定義

| キー | 型 | 必須 | 説明 | 例 |
|------|----|----|------|-----|
| `no` | string | Yes | ナレッジID（`KB-{UUIDv4}`） | `"KB-550e8400-..."` |
| `category` | string | Yes | カテゴリ名（検索フィルタ用） | `"人事"` |
| `source_url` | string | No | ソース元URL | `"https://..."` |
| `updated_at` | string | Yes | ISO 8601 形式の更新日時 | `"2026-02-16T12:00:00+09:00"` |
| `active` | string | Yes | 論理削除フラグ。`"true"` / `"false"` | `"true"` |

**注意事項:**
- `metadataAttributes` の直下にフラットなキーバリューで配置（ネスト不可）
- Knowledge Bases のメタデータフィルタリングでサポートされる型は `string`、`number`、`boolean`（文字列として格納）
- `id` 等の予約語的なキー名は避ける
- `active` フィールドで論理削除を実現。検索時に `active = "true"` でフィルタリング

```json
{
  "metadataAttributes": {
    "no": "KB-550e8400-e29b-41d4-a716-446655440000",
    "category": "人事",
    "source_url": "https://...",
    "updated_at": "2026-02-16T12:00:00+09:00",
    "active": "true"
  }
}
```

### 処理概要
- **add**: 自然言語→構造化Markdown変換 → `.md`（`active: "true"`）と `.metadata.json` を S3 に PUT → KB 同期開始
- **update**: 自然言語→構造化Markdown変換 → 既存ファイルを上書き → KB 同期開始
- **delete**: `.metadata.json` の `active` を `"false"` に更新（論理削除）→ KB 同期開始。S3 からファイル自体は削除しない
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
5. 削除後に `deleting` → `deleted` のステータス遷移を確認
6. メタデータフィルタリング（`active = "true"` + `category` フィルタ）の検証

## 7. 将来改善パス

### Phase 2: ingestion job の分離
現状は Lambda 内で `start_ingestion_job()` を同期的に呼んでいるが、更新件数が増えると以下の問題が発生する:
- Lambda のタイムアウトリスク
- 短時間に複数回 ingestion が走る無駄

**改善案:**
- Lambda A（S3書き込み）→ SQS / EventBridge → Lambda B（ingestion起動）の分離
- DynamoDB で `last_started_at` を管理し、デバウンス（一定間隔以内の重複起動を防止）

### Phase 3: 追加メニューの分離（採番と同期の分離）
現状の「追加」は No 採番 + API 呼び出しを一気に行う。途中失敗で「No だけ発番済み」が残るリスクがある。

**改善案:**
- 追加 = No 採番のみ（ローカル操作）
- 同期（差分更新）で初回も含めて upsert
- 操作が単純になり、失敗時の再実行も楽

### Phase 4: 認証強化
現状は API キーのみ。漏洩時のリスクが高い。

**改善案:**
- Google ID token + Lambda Authorizer（GAS から Google の ID トークンを取得し、Lambda Authorizer で検証）
- IP 制限は GAS 経由では IP 固定が難しいため注意が必要
