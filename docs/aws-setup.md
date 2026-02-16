# AWS リソース構築手順書

本手順では `dev` 環境を例に記載する。`prod` 環境では `dev` を `prod` に読み替えること。

## 前提条件
- AWS CLI がインストール・設定済み
- AWS マネジメントコンソールにアクセス可能
- リージョン: `ap-northeast-1` (東京)

---

## 1. IAM ユーザー: `kp-dev-iam-deploy`

デプロイ・運用用の IAM ユーザーを作成する。

### 1.1 ユーザー作成

```bash
aws iam create-user --user-name kp-dev-iam-deploy
```

### 1.2 カスタムポリシー作成・アタッチ

以下の内容で `kp-dev-deploy-policy.json` を作成:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LambdaManagement",
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
      "Sid": "S3Access",
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
      "Sid": "BedrockAccess",
      "Effect": "Allow",
      "Action": [
        "bedrock:StartIngestionJob",
        "bedrock:GetIngestionJob",
        "bedrock:GetKnowledgeBase"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ApiGatewayAccess",
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

```bash
aws iam create-policy \
  --policy-name kp-dev-deploy-policy \
  --policy-document file://kp-dev-deploy-policy.json

# 出力された Policy ARN を使ってアタッチ
aws iam attach-user-policy \
  --user-name kp-dev-iam-deploy \
  --policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/kp-dev-deploy-policy
```

### 1.3 アクセスキー発行

```bash
aws iam create-access-key --user-name kp-dev-iam-deploy
```

出力された `AccessKeyId` と `SecretAccessKey` を安全に保管する。

---

## 2. S3 バケット: `kp-dev-s3-data`

```bash
aws s3 mb s3://kp-dev-s3-data --region ap-northeast-1
```

### バケットポリシー（パブリックアクセスブロック確認）

```bash
aws s3api put-public-access-block \
  --bucket kp-dev-s3-data \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

### knowledge/ プレフィックス確認

S3 にはプレフィックスを事前作成する必要はない。Lambda がファイルを PUT する際に自動的に作成される。

---

## 3. IAM ロール (Lambda 実行): `kp-dev-iam-lambda-exec`

### 3.1 信頼ポリシーの作成

`trust-policy.json`:

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

```bash
aws iam create-role \
  --role-name kp-dev-iam-lambda-exec \
  --assume-role-policy-document file://trust-policy.json
```

### 3.2 マネージドポリシーのアタッチ

```bash
aws iam attach-role-policy \
  --role-name kp-dev-iam-lambda-exec \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

### 3.3 カスタमポリシーの作成・アタッチ

`lambda-exec-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3Access",
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
      "Sid": "BedrockAccess",
      "Effect": "Allow",
      "Action": [
        "bedrock:StartIngestionJob",
        "bedrock:GetIngestionJob"
      ],
      "Resource": "*"
    }
  ]
}
```

```bash
aws iam create-policy \
  --policy-name kp-dev-lambda-exec-policy \
  --policy-document file://lambda-exec-policy.json

aws iam attach-role-policy \
  --role-name kp-dev-iam-lambda-exec \
  --policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/kp-dev-lambda-exec-policy
```

---

## 4. Lambda 関数: `kp-dev-lambda-handler`

### 4.1 デプロイパッケージ作成

```bash
cd lambda
zip lambda.zip lambda_function.py
```

### 4.2 Lambda 作成

```bash
aws lambda create-function \
  --function-name kp-dev-lambda-handler \
  --runtime python3.12 \
  --role arn:aws:iam::<ACCOUNT_ID>:role/kp-dev-iam-lambda-exec \
  --handler lambda_function.lambda_handler \
  --zip-file fileb://lambda.zip \
  --timeout 30 \
  --memory-size 128 \
  --environment "Variables={S3_BUCKET=kp-dev-s3-data,S3_PREFIX=knowledge/,KNOWLEDGE_BASE_ID=<KB_ID>,DATA_SOURCE_ID=<DS_ID>}"
```

### 4.3 コード更新（再デプロイ時）

```bash
cd lambda
zip lambda.zip lambda_function.py
aws lambda update-function-code \
  --function-name kp-dev-lambda-handler \
  --zip-file fileb://lambda.zip
```

---

## 5. API Gateway: `kp-dev-apigw-knowledge`

### 5.1 REST API 作成

```bash
aws apigateway create-rest-api \
  --name kp-dev-apigw-knowledge \
  --endpoint-configuration types=REGIONAL
```

出力された `id` を `<API_ID>` として以降で使用。

### 5.2 リソース・メソッド作成

```bash
# ルートリソース ID を取得
aws apigateway get-resources --rest-api-id <API_ID>
# 出力された id を <ROOT_ID> として使用

# /knowledge リソース作成
aws apigateway create-resource \
  --rest-api-id <API_ID> \
  --parent-id <ROOT_ID> \
  --path-part knowledge

# 出力された id を <RESOURCE_ID> として使用

# POST メソッド作成（API キー必須）
aws apigateway put-method \
  --rest-api-id <API_ID> \
  --resource-id <RESOURCE_ID> \
  --http-method POST \
  --authorization-type NONE \
  --api-key-required
```

### 5.3 Lambda 統合

```bash
aws apigateway put-integration \
  --rest-api-id <API_ID> \
  --resource-id <RESOURCE_ID> \
  --http-method POST \
  --type AWS_PROXY \
  --integration-http-method POST \
  --uri arn:aws:apigateway:ap-northeast-1:lambda:path/2015-03-31/functions/arn:aws:lambda:ap-northeast-1:<ACCOUNT_ID>:function:kp-dev-lambda-handler/invocations
```

### 5.4 Lambda パーミッション追加

```bash
aws lambda add-permission \
  --function-name kp-dev-lambda-handler \
  --statement-id apigateway-invoke \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:ap-northeast-1:<ACCOUNT_ID>:<API_ID>/*/POST/knowledge"
```

### 5.5 デプロイ

```bash
aws apigateway create-deployment \
  --rest-api-id <API_ID> \
  --stage-name prod
```

### 5.6 API キー・使用量プラン作成

```bash
# 使用量プラン作成
aws apigateway create-usage-plan \
  --name kp-dev-apigw-plan \
  --throttle burstLimit=10,rateLimit=5 \
  --api-stages apiId=<API_ID>,stage=prod

# 出力された id を <PLAN_ID> として使用

# API キー作成
aws apigateway create-api-key \
  --name kp-dev-apigw-key \
  --enabled

# 出力された id を <KEY_ID>、value を GAS の config.gs に設定

# API キーを使用量プランに紐付け
aws apigateway create-usage-plan-key \
  --usage-plan-id <PLAN_ID> \
  --key-id <KEY_ID> \
  --key-type API_KEY
```

### 5.7 エンドポイント URL

```
https://<API_ID>.execute-api.ap-northeast-1.amazonaws.com/prod/knowledge
```

この URL を GAS の `config.gs` の `API_URL` に設定する。

---

## 6. Knowledge Base: `kp-dev-kb-faq`

Knowledge Base はマネジメントコンソールから作成する。

### 6.1 作成手順

1. AWS コンソール > Amazon Bedrock > Knowledge bases > Create knowledge base
2. 設定:
   - Name: `kp-dev-kb-faq`
   - IAM role: 新規作成（自動生成）
   - Data source: Amazon S3
     - S3 URI: `s3://kp-dev-s3-data/knowledge/`
   - Embeddings model: `Titan Embeddings V2`（またはお好みのモデル）
   - Vector database: S3 Vectors
     - バケット名: `kp-dev-s3vectors-faq`
3. メタデータフィールドの設定:
   - `category` (String, Filterable)
   - `no` (String, Filterable)
   - `source_url` (String)
   - `updated_at` (String)
   - `active` (String, Filterable) ← **v2 で追加。検索時に `active = "true"` でフィルタリング**

### 6.2 Knowledge Base ID と Data Source ID の取得

作成後、コンソールまたは CLI で ID を取得し、Lambda の環境変数に設定する。

```bash
# Knowledge Base 一覧
aws bedrock-agent list-knowledge-bases

# Data Source 一覧
aws bedrock-agent list-data-sources --knowledge-base-id <KB_ID>
```

取得した ID を Lambda の環境変数に反映:

```bash
aws lambda update-function-configuration \
  --function-name kp-dev-lambda-handler \
  --environment "Variables={S3_BUCKET=kp-dev-s3-data,S3_PREFIX=knowledge/,KNOWLEDGE_BASE_ID=<KB_ID>,DATA_SOURCE_ID=<DS_ID>}"
```

---

## 7. 動作確認

### curl でのテスト（v2 形式: job_id + row_number 付き）

```bash
curl -X POST \
  https://<API_ID>.execute-api.ap-northeast-1.amazonaws.com/prod/knowledge \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_KEY>" \
  -d '{
    "job_id": "test-job-001",
    "action": "add",
    "items": [
      {
        "row_number": 2,
        "no": "KB-550e8400-e29b-41d4-a716-446655440000",
        "question": "テスト質問です",
        "answer": "テスト回答です",
        "category": "テスト",
        "source_url": ""
      }
    ]
  }'
```

### レスポンス例

```json
{
  "job_id": "test-job-001",
  "results": [
    {
      "row_number": 2,
      "no": "KB-550e8400-e29b-41d4-a716-446655440000",
      "status": "success",
      "message": "Success",
      "updated_at": "2026-02-16T12:00:00+09:00"
    }
  ]
}
```

### S3 確認

```bash
aws s3 ls s3://kp-dev-s3-data/knowledge/
aws s3 cp s3://kp-dev-s3-data/knowledge/KB-550e8400-e29b-41d4-a716-446655440000.md -
aws s3 cp s3://kp-dev-s3-data/knowledge/KB-550e8400-e29b-41d4-a716-446655440000.metadata.json -
```

### メタデータ確認（active フィールドの確認）

```bash
aws s3 cp s3://kp-dev-s3-data/knowledge/KB-550e8400-e29b-41d4-a716-446655440000.metadata.json - | python3 -m json.tool
```

期待される出力:
```json
{
  "metadataAttributes": {
    "no": "KB-550e8400-e29b-41d4-a716-446655440000",
    "category": "テスト",
    "source_url": "",
    "updated_at": "2026-02-16T12:00:00+09:00",
    "active": "true"
  }
}
```

### 削除テスト（論理削除の確認）

```bash
curl -X POST \
  https://<API_ID>.execute-api.ap-northeast-1.amazonaws.com/prod/knowledge \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_KEY>" \
  -d '{
    "job_id": "test-job-002",
    "action": "delete",
    "items": [{"row_number": 2, "no": "KB-550e8400-e29b-41d4-a716-446655440000"}]
  }'
```

削除後にメタデータを確認し、`active` が `"false"` になっていることを確認:

```bash
aws s3 cp s3://kp-dev-s3-data/knowledge/KB-550e8400-e29b-41d4-a716-446655440000.metadata.json - | python3 -m json.tool
```

### クリーンアップ（テストデータ物理削除）

```bash
aws s3 rm s3://kp-dev-s3-data/knowledge/KB-550e8400-e29b-41d4-a716-446655440000.md
aws s3 rm s3://kp-dev-s3-data/knowledge/KB-550e8400-e29b-41d4-a716-446655440000.metadata.json
```
