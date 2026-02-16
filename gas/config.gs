/**
 * config.gs - 設定ファイル
 *
 * デプロイ環境に合わせて以下の値を設定してください。
 */

var CONFIG = {
  /** API Gateway エンドポイント URL */
  API_URL: "https://xxxxxxxxxx.execute-api.ap-northeast-1.amazonaws.com/prod/knowledge",

  /** API Gateway APIキー */
  API_KEY: "your-api-key-here",

  /** スプレッドシートの列インデックス (1-based) */
  COL: {
    CHECKBOX:   1, // A列: チェックボックス
    NO:         2, // B列: No
    QUESTION:   3, // C列: 質問
    ANSWER:     4, // D列: 回答
    CATEGORY:   5, // E列: カテゴリ
    SOURCE_URL: 6, // F列: 参照URL
    UPDATED_AT: 7, // G列: 更新日
    STATUS:     8  // H列: ステータス
  },

  /** ヘッダー行数 */
  HEADER_ROWS: 1
};
