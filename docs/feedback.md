ざっと読んだ。**全体の骨格はOK**（S3正 → KB同期、スプシUI、3アクション分離、S3に`.md`＋`.metadata.json`）。
ただしこのままだと **運用で確実に詰まる点**がいくつかある。直すならここ。

---

## 1) ID形式「KB-{UUID8桁}」は衝突リスクが高い

8桁（16^8=約4.3e9）は、**運用が長くなるほど衝突が現実的**。さらに人間がコピペで壊す。

**推奨**

* `No` は **ULID/UUIDv4** をフルで（例：`KB-01J...` / `KB-550e...`）
* どうしても短くしたいなら「短縮ID」は別列（表示用）にして、主キーは長い方を保持。

---

## 2) APIのリクエストに「row_number / job_id」が無いのはNG

今のレスポンスは `no` しか返さない。
スプシ側は **行番号で結果を書き戻す**のが一番安全（Noが空の行、重複No、並び替え等が起きるから）。

**修正案**

* requestに `job_id` と `items[].row_number` を追加
* responseにも同じく `row_number` を返す

```json
{
  "job_id": "uuid",
  "action": "add|update|delete",
  "items": [
    { "row_number": 12, "no": "...", "question": "...", "answer": "...", ... }
  ]
}
```

---

## 3) Lambdaの責務が「KB同期」まで一気にやるとタイムアウトしがち

「S3へ書く」＋「StartIngestionJob」まで同一LambdaでやるのはMVPでは動くが、更新件数が増えると不安定になる。

**スケール前提なら**こう分けるのが堅い：

* **Lambda A（受領/検証/S3書き込み）**：即レスポンス（スプシは `pending`）
* **EventBridge（定期） or SQS**：取り込みトリガ
* **Lambda B（KB ingestion job起動/監視）**：集約して1回だけ起動

※「更新のたびに ingestion job」をやるなら、最低でも **デバウンス**（DynamoDBで`last_started_at`）が必要。

---

## 4) Markdown変換ルールが弱い（`# {質問}` だけだとノイズる）

質問がH1になると、検索で “質問文” が強く効きすぎたり、同一質問が増えると見出しが汚れる。QAテンプレに固定した方が安定する。

**推奨テンプレ**

```md
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

---

## 5) `.metadata.json` のスキーマは「KBの期待形」に合わせて固定

あなたが書いた「KB S3フィルタリング規約準拠」は良いけど、実装でズレると取り込みで無視される。

**仕様書に明記すべき**

* `metadataAttributes` のキー名（`category/tags/owner/sensitivity/source_url` 等）
* 型（string / string list）
* 予約語を避ける（`id` とか雑に使わない）

---

## 6) 削除の仕様：S3削除だけだと「取り込みタイミング」で揺れる

`delete` で

* `knowledge/<No>.md` を削除
* `metadata.json` も削除
  まではOK。

ただ、取り込みが遅延すると「検索にまだ出る」期間が発生する。運用上は普通に問題になる。

**対策（どれか）**

* スプシの削除ステータスを `deleting` → ingestion完了で `deleted`
* もしくは **論理削除**（metadataに `active=false` を入れ、検索時フィルタで除外）

---

## 7) API認証：APIキーだけだと漏洩時に終わる

MVPとしては妥当。ただ仕様書に**将来の強化パス**を書いとけ。

* 次段：Google ID token + Lambda Authorizer
* さらに：IP制限（GAS経由はIP固定できないことが多いので注意）

---

## 8) 追加メニューのガード条件は逆が安全

「Noが空の行だけ追加」は正しい。
ただし「追加後に即API呼び出し」は、途中失敗で `Noだけ発番済み` が残る。

**推奨**

* 追加は **No採番だけ**（ローカル操作）
* 同期（差分更新）で初回も含めて upsert
  → 操作が単純になり、失敗時の再実行も楽

あなたが “3メニュー” を守るなら、**追加＝採番専用**に寄せた方が運用は安定する。

---

# まとめ：良いけど、最低限ここは直せ

* `No` を **ULID/UUIDフル**に（UUID8桁はやめろ）
* APIに **job_id + row_number** を追加（書き戻しの生命線）
* ingestion job は **定期 or デバウンス**（スケールするなら分離）
* QA Markdownはテンプレ固定（`# 質問` 単独は弱い）
* 削除は **ステータス管理 or 論理削除** を入れる

---

必要なら、あなたの `docs/PLAN.md` にそのまま貼れる形で **「API仕様改訂版」「S3キー/metadata仕様」「ステータス遷移図」**を文章として整形して出す。今のドキュメントに追記するだけで設計が一段固くなる。
