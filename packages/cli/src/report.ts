import {
  type AnyEvent,
  type Event,
  pendingQuestions,
  type ToolContent,
  type Work,
} from "@openshain/core";
import { describeInput, truncate } from "./format.ts";
import { failureLabel, rejectionLabel, statusLabel } from "./labels.ts";
import { formatUsage, summarizeUsage } from "./usage.ts";

/** One line for a tool call, a rejection or a failure; nothing for the other events. `names` maps call ids to tool names. */
export function progressLine(event: AnyEvent, names: Map<string, string>): string | undefined {
  switch (event.type) {
    case "tool.called": {
      const { callId, name, input } = (event as Event<"tool.called">).payload;
      names.set(callId, name);
      return `${name} ${describeInput(input)}`.trimEnd();
    }
    case "tool.rejected": {
      const { name, code, reason } = (event as Event<"tool.rejected">).payload;
      return `${name} は拒否されました。${rejectionLabel(code)}。${reason}`;
    }
    case "tool.completed": {
      const { callId, content, isError } = (event as Event<"tool.completed">).payload;
      if (!isError) return undefined;
      return `${names.get(callId) ?? callId} は失敗しました。${truncate(firstLine(content))}`;
    }
    default:
      return undefined;
  }
}

function firstLine(content: ToolContent[]): string {
  for (const part of content) {
    if (part.type === "text") return part.text.split("\n")[0] ?? "";
  }
  return "";
}

/** The closing lines: what happened, what it cost, and who acts next. */
export function report(work: Work, events: AnyEvent[]): string[] {
  const lines: string[] = [];
  switch (work.status) {
    case "completed":
      lines.push(`完了。${work.outcome?.summary ?? ""}`.trimEnd());
      for (const artifact of work.outcome?.artifacts ?? []) {
        lines.push(
          `  書き込み ${artifact.path}${artifact.missing ? "  完了時には読めなかった" : ""}${artifact.claimed ? "  エージェントの申告(この Work の Tool は書いていない)" : ""}`,
        );
      }
      break;
    case "failed":
      lines.push(
        `失敗。${failureLabel(work.failure?.reason)}。${work.failure?.detail ?? ""}`.trimEnd(),
      );
      break;
    case "waiting_input":
      lines.push("利用者の入力を待っています。");
      for (const { question } of pendingQuestions(events)) lines.push(`  質問 ${question}`);
      break;
    default:
      lines.push(`状態は ${statusLabel(work.status)} です。`);
  }
  lines.push(formatUsage(summarizeUsage(events)));
  lines.push(nextActor(work));
  return lines;
}

export function nextActor(work: Work): string {
  switch (work.status) {
    case "completed":
    case "cancelled":
      return "次に動く人はいません。";
    case "waiting_input":
      return `次は利用者の番です。openshain の会話で /work resume ${work.id} を実行し、続きを依頼すると質問に答えられます。`;
    case "waiting_approval":
      return "次は利用者の番です。承認が要ります。";
    case "failed":
      return "次は利用者の番です。原因を修正して、もう一度依頼してください。";
    default:
      return "次は model の番です。";
  }
}
