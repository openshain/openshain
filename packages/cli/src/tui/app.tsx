import { Box, Static, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import type { Controller, ControllerState, Entry } from "./controller.ts";

const COLORS: Record<Entry["kind"], string | undefined> = {
  user: "cyan",
  assistant: undefined,
  progress: "gray",
  notice: "yellow",
  question: "magenta",
  line: undefined,
};

function Line({ entry }: { entry: Entry }) {
  const color = COLORS[entry.kind];
  return (
    <Text {...(color && { color })}>
      {entry.kind === "user" ? "> " : ""}
      {entry.text}
    </Text>
  );
}

function statusText(state: ControllerState): string {
  const { company, model, work, usage } = state.status;
  const parts = [company, model];
  if (work) parts.push(`${work.id} ${work.status}`);
  parts.push(
    `model ${usage.modelCalls} 回、入力 ${usage.inputTokens}、出力 ${usage.outputTokens} トークン`,
  );
  return parts.join(" | ");
}

export function App({ controller }: { controller: Controller }) {
  const { exit } = useApp();
  const [state, setState] = useState<ControllerState>(() => ({ ...controller.state() }));
  const [input, setInput] = useState("");

  useEffect(() => controller.subscribe(() => setState({ ...controller.state() })), [controller]);
  useEffect(() => {
    if (state.closed) exit();
  }, [state.closed, exit]);

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") {
      if (!controller.interrupt()) void controller.close();
      return;
    }
    if (key.return) {
      const line = input;
      setInput("");
      void controller.submit(line);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((v) => [...v].slice(0, -1).join(""));
      return;
    }
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab || key.escape)
      return;
    if (!key.ctrl && !key.meta) setInput((v) => v + ch);
  });

  return (
    <Box flexDirection="column">
      <Static items={state.settled}>{(entry) => <Line key={entry.id} entry={entry} />}</Static>
      {state.live.map((entry) => (
        <Line key={entry.id} entry={entry} />
      ))}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>{statusText(state)}</Text>
      </Box>
      <Box>
        <Text color={state.question ? "magenta" : "cyan"}>{state.question ? "答え> " : "> "}</Text>
        <Text>{input}</Text>
        <Text dimColor>{state.busy ? " …" : "▌"}</Text>
      </Box>
    </Box>
  );
}
