import type { FailureReason } from "@openshain/agent";
import type { ErrorCode, ToolRejectionCode, WorkStatus } from "@openshain/core";

/** The words shown for a work's status. The log keeps the original value. */
export const STATUS_LABELS: Record<WorkStatus, string> = {
  queued: "未着手",
  in_progress: "進行中",
  waiting_input: "利用者の入力待ち",
  waiting_approval: "承認待ち",
  waiting_external: "外部の応答待ち",
  completed: "完了",
  failed: "失敗",
  cancelled: "取り消し",
};

/** Why a work failed, as a heading before the original detail. */
export const FAILURE_LABELS: Record<FailureReason, string> = {
  limit_reached: "上限到達",
  model_refusal: "model の拒否",
  model_error: "model のエラー",
};

/** Why a tool call was rejected, as a heading before the original reason. */
export const REJECTION_LABELS: Record<ToolRejectionCode, string> = {
  schema_mismatch: "schema に合わない入力",
  unknown_tool: "知らない Tool",
  not_allowed: "この workspace では不許可",
  reserved_path: "予約されたパス",
  outside_workspace: "workspace の外",
  invalid_path: "不正なパス",
  limit_reached: "Tool 呼び出しの上限",
};

/** A heading for a runtime error, before the original message. */
export const ERROR_LABELS: Record<ErrorCode, string> = {
  auth: "認証の失敗",
  network: "接続の失敗",
  rate_limit: "呼び出し上限",
  invalid_response: "解釈できない model の応答",
  config: "設定の問題",
  corrupt_log: "壊れた Work の記録",
  invalid_transition: "進められない状態",
  duplicate_tool: "同じ名前の Tool の重複",
  invalid_id: "不正な id",
  invalid_tool: "不正な Tool の定義",
  invalid_path: "不正なパス",
  lock_held: "別のプロセスが使用中",
  not_found: "対象なし",
  reserved_path: "予約されたパス",
  outside_workspace: "workspace の外",
  concurrent_write: "同時書き込み",
  invalid_event: "記録できないイベント",
};

export function statusLabel(status: string): string {
  return (STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export function failureLabel(reason: string | undefined): string {
  return reason ? ((FAILURE_LABELS as Record<string, string>)[reason] ?? reason) : "理由は不明";
}

export function rejectionLabel(code: string): string {
  return (REJECTION_LABELS as Record<string, string>)[code] ?? code;
}

export function errorLabel(code: string): string | undefined {
  return (ERROR_LABELS as Record<string, string>)[code];
}
