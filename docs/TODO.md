# TODO

| # | タスク | 成果物 | ステータス |
|---|--------|--------|------------|
| 1 | Lambda 関数の実装（Markdown変換 + S3操作 + KB同期） | `lambda/lambda_function.py` | 完了 |
| 2 | GAS メインコード実装（メニュー、No生成、フロー制御） | `gas/Code.gs` | 完了 |
| 3 | GAS API呼び出しモジュール実装 | `gas/api.gs` | 完了 |
| 4 | GAS 設定ファイル作成 | `gas/config.gs` | 完了 |
| 5 | AWS リソース構築手順書の作成（IAMユーザー・ロール含む） | `docs/aws-setup.md` | 完了 |
| 6 | Lambda ローカルテスト用イベント JSON 作成 | `lambda/events/` | 完了 |
| 7 | E2E テスト（スプシ→GAS→API GW→Lambda→S3→KB） | - | 完了 |
