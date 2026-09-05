import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useState } from "react";
import type { Controller, ControllerState } from "./controller.ts";
import { type ScreenLine, screenLines } from "./lines.ts";

const COLORS: Record<ScreenLine["kind"], string | undefined> = {
  user: "cyan",
  assistant: undefined,
  progress: "gray",
  notice: "yellow",
  question: "magenta",
  line: undefined,
  blank: undefined,
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Rows that are not history: the header, the input box (three rows) and the status line. */
const CHROME_ROWS = 5;

function statusText(state: ControllerState, scrolled: number): string {
  if (scrolled > 0) return `↑ ${scrolled} 行上を表示中。End で最新へ、PageUp と PageDown で移動`;
  const { work, usage } = state.status;
  const parts = [];
  if (work) parts.push(`${work.id} ${work.status}`);
  parts.push(
    `model ${usage.modelCalls} 回、入力 ${usage.inputTokens}、出力 ${usage.outputTokens} トークン`,
  );
  parts.push("/help で使い方");
  return parts.join(" · ");
}

/**
 * The whole terminal: a header, the conversation with the newest rows at the bottom, the input
 * box, and a status line. The conversation scrolls inside the screen with PageUp, PageDown and
 * the arrow keys; End returns to the newest rows.
 */
export function App({ controller }: { controller: Controller }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState<ControllerState>(() => ({ ...controller.state() }));
  const [input, setInput] = useState("");
  const [scroll, setScroll] = useState(0);
  const [size, setSize] = useState({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
  const [tick, setTick] = useState(0);

  useEffect(() => controller.subscribe(() => setState({ ...controller.state() })), [controller]);
  useEffect(() => {
    if (state.closed) exit();
  }, [state.closed, exit]);
  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  useEffect(() => {
    if (!state.busy) return;
    const timer = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(timer);
  }, [state.busy]);

  // One row is left to the terminal: drawing exactly its height makes it scroll on every redraw.
  const height = Math.max(CHROME_ROWS + 1, size.rows - 1);
  const width = Math.max(20, size.columns);
  const paneRows = height - CHROME_ROWS;
  const lines = screenLines(state.entries, width).map((line, row) => ({ ...line, row }));
  const maxScroll = Math.max(0, lines.length - paneRows);
  const scrolled = Math.min(scroll, maxScroll);
  const end = lines.length - scrolled;
  const visible = lines.slice(Math.max(0, end - paneRows), end);
  const page = Math.max(1, paneRows - 1);

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") {
      if (!controller.interrupt()) void controller.close();
      return;
    }
    if (key.pageUp) return setScroll((s) => Math.min(maxScroll, s + page));
    if (key.pageDown) return setScroll((s) => Math.max(0, s - page));
    if (key.upArrow) return setScroll((s) => Math.min(maxScroll, s + 1));
    if (key.downArrow) return setScroll((s) => Math.max(0, s - 1));
    if (key.home) return setScroll(maxScroll);
    if (key.end) return setScroll(0);
    // Ink hands a pasted or quickly typed chunk over whole, and a newline inside it does not set
    // key.return. The line ends at the first newline; what follows stays in the input.
    const newline = key.return ? 0 : ch.search(/[\r\n]/);
    if (newline >= 0) {
      const line = input + ch.slice(0, newline);
      setInput(ch.slice(newline + 1).replace(/^\n/, ""));
      setScroll(0);
      void controller.submit(line);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((v) => [...v].slice(0, -1).join(""));
      return;
    }
    if (key.leftArrow || key.rightArrow || key.tab || key.escape) return;
    if (!key.ctrl && !key.meta) setInput((v) => v + ch);
  });

  const asking = state.question !== undefined;
  const bottom = state.busy
    ? `${SPINNER[tick % SPINNER.length]} 作業中。Ctrl-C で止める`
    : statusText(state, scrolled);
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text dimColor wrap="truncate">
        {[
          "openshain",
          state.status.company,
          ...(state.status.agentName ? [`社員エージェント ${state.status.agentName}`] : []),
          state.status.model,
        ].join(" · ")}
      </Text>
      <Box flexDirection="column" height={paneRows}>
        {visible.map((line) => {
          const color = COLORS[line.kind];
          return (
            <Text key={line.row} wrap="truncate" {...(color && { color })}>
              {line.text || " "}
            </Text>
          );
        })}
      </Box>
      <Box borderStyle="round" borderColor={asking ? "magenta" : "gray"} paddingX={1}>
        <Text color={asking ? "magenta" : "cyan"}>{asking ? "答え> " : "> "}</Text>
        <Text>{input}</Text>
        <Text dimColor>▌</Text>
      </Box>
      <Text dimColor wrap="truncate">
        {bottom}
      </Text>
    </Box>
  );
}
