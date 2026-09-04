/** The words shown for a work's status. The log keeps the original value. */
export const STATUS_LABELS: Record<string, string> = {
  queued: "未着手",
  in_progress: "進行中",
  waiting_input: "利用者の入力待ち",
  waiting_approval: "承認待ち",
  waiting_external: "外部の応答待ち",
  completed: "完了",
  failed: "失敗",
  cancelled: "取り消し",
};

/** Why a work failed, in the person's words. */
export const FAILURE_LABELS: Record<string, string> = {
  limit_reached: "上限に達した",
  model_refusal: "model が拒否した",
  model_error: "model のエラー",
};

/** Why a tool call was rejected, in the person's words. */
export const REJECTION_LABELS: Record<string, string> = {
  schema_mismatch: "入力が schema に合わない",
  unknown_tool: "知らない Tool",
  not_allowed: "この workspace では許可されていない",
  reserved_path: "予約されたパス",
  outside_workspace: "workspace の外",
  invalid_path: "不正なパス",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function failureLabel(reason: string | undefined): string {
  return reason ? (FAILURE_LABELS[reason] ?? reason) : "理由は不明";
}

export function rejectionLabel(code: string): string {
  return REJECTION_LABELS[code] ?? code;
}

/** A heading for a runtime error, in the person's words. The original message follows it. */
export const ERROR_LABELS: Record<string, string> = {
  auth: "認証に失敗した",
  network: "接続できなかった",
  rate_limit: "呼び出しの上限に当たった",
  invalid_response: "model の応答を解釈できない",
  config: "設定に問題がある",
  corrupt_log: "Work の記録が壊れている",
  invalid_transition: "この状態からは進められない",
  duplicate_tool: "同じ名前の Tool が 2 つある",
  invalid_id: "id の形が正しくない",
  invalid_tool: "Tool の定義に問題がある",
  invalid_path: "パスが正しくない",
  lock_held: "別のプロセスがこの Work を使っている",
  not_found: "見つからない",
  reserved_path: "予約されたパス",
  outside_workspace: "workspace の外",
  concurrent_write: "同時に書き込まれた",
  invalid_event: "記録できないイベント",
};

export function errorLabel(code: string): string | undefined {
  return ERROR_LABELS[code];
}
