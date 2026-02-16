/**
 * Code.gs - メイン（メニュー、共通関数、No生成、フロー制御）
 */

// ---------------------------------------------------------------------------
// メニュー
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("ナレッジ同期")
    .addItem("追加", "syncAdd")
    .addItem("差分更新", "syncUpdate")
    .addItem("削除", "syncDelete")
    .addToUi();
}

// ---------------------------------------------------------------------------
// 追加
// ---------------------------------------------------------------------------

function syncAdd() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var rows = getCheckedRows(sheet);
  var COL = CONFIG.COL;

  // No が空の行のみ対象
  var targets = rows.filter(function(r) {
    return !sheet.getRange(r, COL.NO).getValue();
  });

  if (targets.length === 0) {
    ui.alert("対象行がありません。\nチェックボックスが ON かつ No が空の行を選択してください。");
    return;
  }

  var confirm = ui.alert(
    "追加確認",
    targets.length + " 件のナレッジを追加します。よろしいですか？",
    ui.ButtonSet.OK_CANCEL
  );
  if (confirm !== ui.Button.OK) return;

  // No を生成してシートに即座に書き込み、row_number を付与
  var items = [];
  for (var i = 0; i < targets.length; i++) {
    var row = targets[i];
    var no = generateNo();
    sheet.getRange(row, COL.NO).setValue(no);

    items.push({
      row_number: row,
      no: no,
      question:   String(sheet.getRange(row, COL.QUESTION).getValue()),
      answer:     String(sheet.getRange(row, COL.ANSWER).getValue()),
      category:   String(sheet.getRange(row, COL.CATEGORY).getValue()),
      source_url: String(sheet.getRange(row, COL.SOURCE_URL).getValue())
    });
  }

  // API 呼び出し（job_id を生成）
  try {
    var jobId = Utilities.getUuid();
    var response = callApi(jobId, "add", items);
    applyResults(sheet, response.results);
  } catch (e) {
    markError(sheet, targets, e.message);
  }

  clearCheckboxes(sheet, targets);
}

// ---------------------------------------------------------------------------
// 差分更新
// ---------------------------------------------------------------------------

function syncUpdate() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var rows = getCheckedRows(sheet);
  var COL = CONFIG.COL;

  // No がある行のみ対象
  var targets = rows.filter(function(r) {
    return !!sheet.getRange(r, COL.NO).getValue();
  });

  if (targets.length === 0) {
    ui.alert("対象行がありません。\nチェックボックスが ON かつ No がある行を選択してください。");
    return;
  }

  // No がない行がスキップされた場合に警告
  var skipped = rows.length - targets.length;
  if (skipped > 0) {
    ui.alert("警告", skipped + " 件の行は No が空のためスキップされます。", ui.ButtonSet.OK);
  }

  var confirm = ui.alert(
    "更新確認",
    targets.length + " 件のナレッジを更新します。よろしいですか？",
    ui.ButtonSet.OK_CANCEL
  );
  if (confirm !== ui.Button.OK) return;

  var items = [];
  for (var i = 0; i < targets.length; i++) {
    var row = targets[i];
    items.push({
      row_number: row,
      no:         String(sheet.getRange(row, COL.NO).getValue()),
      question:   String(sheet.getRange(row, COL.QUESTION).getValue()),
      answer:     String(sheet.getRange(row, COL.ANSWER).getValue()),
      category:   String(sheet.getRange(row, COL.CATEGORY).getValue()),
      source_url: String(sheet.getRange(row, COL.SOURCE_URL).getValue())
    });
  }

  try {
    var jobId = Utilities.getUuid();
    var response = callApi(jobId, "update", items);
    applyResults(sheet, response.results);
  } catch (e) {
    markError(sheet, targets, e.message);
  }

  clearCheckboxes(sheet, targets);
}

// ---------------------------------------------------------------------------
// 削除
// ---------------------------------------------------------------------------

function syncDelete() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var rows = getCheckedRows(sheet);
  var COL = CONFIG.COL;

  // No がある行のみ対象
  var targets = rows.filter(function(r) {
    return !!sheet.getRange(r, COL.NO).getValue();
  });

  if (targets.length === 0) {
    ui.alert("対象行がありません。\nチェックボックスが ON かつ No がある行を選択してください。");
    return;
  }

  var confirm = ui.alert(
    "削除確認（注意）",
    targets.length + " 件のナレッジを削除します。\nこの操作は取り消せません。本当に削除しますか？",
    ui.ButtonSet.OK_CANCEL
  );
  if (confirm !== ui.Button.OK) return;

  var items = [];
  for (var i = 0; i < targets.length; i++) {
    var row = targets[i];
    items.push({
      row_number: row,
      no: String(sheet.getRange(row, COL.NO).getValue())
    });
  }

  try {
    var jobId = Utilities.getUuid();
    var response = callApi(jobId, "delete", items);
    applyDeleteResults(sheet, response.results);
  } catch (e) {
    markError(sheet, targets, e.message);
  }

  clearCheckboxes(sheet, targets);
}

// ---------------------------------------------------------------------------
// 共通関数
// ---------------------------------------------------------------------------

/**
 * No を生成する (KB-{UUIDv4フル36桁})
 */
function generateNo() {
  return "KB-" + Utilities.getUuid();
}

/**
 * チェックボックスが ON の行番号を取得する（ヘッダー行を除く）
 */
function getCheckedRows(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= CONFIG.HEADER_ROWS) return [];

  var dataStartRow = CONFIG.HEADER_ROWS + 1;
  var numRows = lastRow - CONFIG.HEADER_ROWS;
  var checkboxes = sheet.getRange(dataStartRow, CONFIG.COL.CHECKBOX, numRows, 1).getValues();

  var rows = [];
  for (var i = 0; i < checkboxes.length; i++) {
    if (checkboxes[i][0] === true) {
      rows.push(dataStartRow + i);
    }
  }
  return rows;
}

/**
 * API レスポンスの結果をシートに反映する（追加・更新用）
 * row_number を使って対応する行を特定する
 */
function applyResults(sheet, results) {
  var COL = CONFIG.COL;

  for (var i = 0; i < results.length; i++) {
    var result = results[i];
    var row = result.row_number;
    if (!row) continue;

    if (result.status === "success") {
      sheet.getRange(row, COL.UPDATED_AT).setValue(result.updated_at);
      sheet.getRange(row, COL.STATUS).setValue("同期済");
    } else {
      sheet.getRange(row, COL.STATUS).setValue("エラー");
    }
  }
}

/**
 * API レスポンスの結果をシートに反映する（削除用）
 * row_number を使って対応する行を特定する
 */
function applyDeleteResults(sheet, results) {
  var COL = CONFIG.COL;

  for (var i = 0; i < results.length; i++) {
    var result = results[i];
    var row = result.row_number;
    if (!row) continue;

    if (result.status === "success") {
      sheet.getRange(row, COL.STATUS).setValue("deleting");
    } else {
      sheet.getRange(row, COL.STATUS).setValue("エラー");
    }
  }
}

/**
 * エラー時にステータスを一括設定する
 */
function markError(sheet, targetRows, message) {
  var COL = CONFIG.COL;
  for (var i = 0; i < targetRows.length; i++) {
    sheet.getRange(targetRows[i], COL.STATUS).setValue("エラー");
  }
  SpreadsheetApp.getUi().alert("エラーが発生しました:\n" + message);
}

/**
 * 処理後にチェックボックスを OFF に戻す
 */
function clearCheckboxes(sheet, targetRows) {
  for (var i = 0; i < targetRows.length; i++) {
    sheet.getRange(targetRows[i], CONFIG.COL.CHECKBOX).setValue(false);
  }
}
