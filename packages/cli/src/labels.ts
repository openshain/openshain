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
