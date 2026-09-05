import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useMemo, useState } from "react";
import type { Controller, ControllerState } from "./controller.ts";
import { type ScreenLine, screenLines } from "./lines.ts";

const COLORS: Record<ScreenLine["kind"], string | undefined> = {
  user: "cyan",
  assistant: undefined,
  progress: "gray",
  notice: "yellow",
  question: "magenta",
  line: undefined,
  logo: undefined,
  banner: undefined,
  blank: undefined,
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Rows that are not history: the header, the input box (three rows) and the status line. */
const CHROME_ROWS = 5;

function statusText(state: ControllerState, scrolled: number): string {
  if (scrolled > 0)
    return `↑ ${scrolled} 行上を表示中。End で最新へ、ホイールか PageUp と PageDown で移動`;
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
 * box, and a status line. The conversation scrolls inside the screen with the mouse wheel, PageUp
 * and PageDown. The up and down arrows recall the lines sent before; the input is edited in place.
 */
export function App({ controller }: { controller: Controller }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState<ControllerState>(() => ({ ...controller.state() }));
  const [input, setInput] = useState("");
  /** Where the next character goes, counted in characters, not bytes. */
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  /** While the arrows walk the history: where we are, and what the input held before. */
  const [recall, setRecall] = useState<{ index: number; draft: string } | undefined>();
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
  const lines = useMemo(
    () => screenLines(state.entries, width).map((line, row) => ({ ...line, row })),
    [state.entries, width],
  );
  const maxScroll = Math.max(0, lines.length - paneRows);
  const scrolled = Math.min(scroll, maxScroll);
  const end = lines.length - scrolled;
  const visible = lines.slice(Math.max(0, end - paneRows), end);
  const page = Math.max(1, paneRows - 1);

  /** Replaces the input and puts the cursor after it. */
  const replaceInput = (text: string) => {
    setInput(text);
    setCursor([...text].length);
  };

  useInput((ch, key) => {
    // The terminal reports the mouse (SGR). The wheel scrolls the conversation; the rest is ignored.
    if (/\[<\d+;\d+;\d+[Mm]/.test(ch)) {
      let delta = 0;
      for (const m of ch.matchAll(/\[<(6[45]);\d+;\d+M/g)) delta += m[1] === "64" ? 3 : -3;
      if (delta !== 0) setScroll((s) => Math.max(0, Math.min(maxScroll, s + delta)));
      return;
    }
    if (key.ctrl && ch === "c") {
      if (!controller.interrupt()) void controller.close();
      return;
    }
    if (key.pageUp) return setScroll((s) => Math.min(maxScroll, s + page));
    if (key.pageDown) return setScroll((s) => Math.max(0, s - page));
    // Up and down walk the lines sent before; below the newest one is what was being typed.
    if (key.upArrow) {
      const index = (recall?.index ?? history.length) - 1;
      if (index < 0) return;
      setRecall({ index, draft: recall?.draft ?? input });
      replaceInput(history[index] ?? "");
      return;
    }
    if (key.downArrow) {
      if (!recall) return;
      const index = recall.index + 1;
      if (index >= history.length) {
        replaceInput(recall.draft);
        setRecall(undefined);
        return;
      }
      setRecall({ ...recall, index });
      replaceInput(history[index] ?? "");
      return;
    }
    // Editing: the cursor moves with the arrows, Home and End (also Ctrl-A and Ctrl-E); Backspace
    // deletes before it, Delete at it, Ctrl-U everything before it, Ctrl-K everything after it.
    const chars = [...input];
    const at = Math.min(cursor, chars.length);
    if (key.leftArrow) return setCursor(Math.max(0, at - 1));
    if (key.rightArrow) return setCursor(Math.min(chars.length, at + 1));
    if (key.home || (key.ctrl && ch === "a")) return setCursor(0);
    if (key.end || (key.ctrl && ch === "e")) return setCursor(chars.length);
    if (key.backspace) {
      if (at === 0) return;
      setInput([...chars.slice(0, at - 1), ...chars.slice(at)].join(""));
      setCursor(at - 1);
      return;
    }
    if (key.delete) {
      setInput([...chars.slice(0, at), ...chars.slice(at + 1)].join(""));
      return;
    }
    if (key.ctrl && ch === "u") {
      setInput(chars.slice(at).join(""));
      setCursor(0);
      return;
    }
    if (key.ctrl && ch === "k") return setInput(chars.slice(0, at).join(""));
    // Ink hands a pasted or quickly typed chunk over whole, and a newline inside it does not set
    // key.return. The line ends at the first newline; what follows becomes the next input.
    const newline = key.return ? 0 : ch.search(/[\r\n]/);
    if (newline >= 0) {
      const line = [...chars.slice(0, at), ch.slice(0, newline), ...chars.slice(at)].join("");
      if (line.trim() !== "") setHistory((h) => (h.at(-1) === line ? h : [...h, line]));
      setRecall(undefined);
      replaceInput(ch.slice(newline + 1).replace(/^\n/, ""));
      setScroll(0);
      void controller.submit(line);
      return;
    }
    if (key.tab || key.escape || key.ctrl || key.meta) return;
    setInput([...chars.slice(0, at), ch, ...chars.slice(at)].join(""));
    setCursor(at + [...ch].length);
  });

  const asking = state.question !== undefined;
  const chars = [...input];
  const at = Math.min(cursor, chars.length);
  const before = chars.slice(0, at).join("");
  const under = chars[at] ?? "";
  const after = chars.slice(at + 1).join("");
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
          if (line.segments) {
            return (
              <Text key={line.row} wrap="truncate">
                {line.segments.map((s) => (
                  <Text key={s.at} color={s.color}>
                    {s.text}
                  </Text>
                ))}
              </Text>
            );
          }
          return (
            <Text
              key={line.row}
              wrap="truncate"
              dimColor={line.kind === "banner"}
              {...(color && { color })}
            >
              {line.text || " "}
            </Text>
          );
        })}
      </Box>
      <Box borderStyle="round" borderColor={asking ? "magenta" : "gray"} paddingX={1}>
        <Text color={asking ? "magenta" : "cyan"}>{asking ? "答え> " : "> "}</Text>
        <Text>{before}</Text>
        {under === "" ? <Text dimColor>▌</Text> : <Text inverse>{under}</Text>}
        <Text>{after}</Text>
      </Box>
      <Text dimColor wrap="truncate">
        {bottom}
      </Text>
    </Box>
  );
}
