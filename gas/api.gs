/**
 * api.gs - API呼び出しモジュール
 */

/**
 * API Gateway へリクエストを送信する
 * @param {string} action - "add" | "update" | "delete"
 * @param {Object[]} items - 送信するアイテムの配列
 * @returns {Object} APIレスポンスのパース済みオブジェクト
 */
function callApi(action, items) {
  var payload = {
    action: action,
    items: items
  };

  var options = {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-api-key": CONFIG.API_KEY
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(CONFIG.API_URL, options);
  var statusCode = response.getResponseCode();
  var body = JSON.parse(response.getContentText());

  if (statusCode !== 200) {
    throw new Error("API error (" + statusCode + "): " + JSON.stringify(body));
  }

  return body;
}
