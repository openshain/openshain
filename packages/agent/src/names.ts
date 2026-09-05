/**
 * Names a session's agent may go by. Given names in kana, none of which identify a real person,
 * and none that a company would confuse with a role or a colleague's surname.
 */
export const AGENT_NAMES: readonly string[] = Object.freeze([
  "あおい",
  "あさひ",
  "いぶき",
  "かえで",
  "かなた",
  "こはる",
  "さくら",
  "しおん",
  "すばる",
  "そら",
  "たまき",
  "ちひろ",
  "つばさ",
  "とわ",
  "なぎ",
  "なお",
  "のぞみ",
  "はるか",
  "ひなた",
  "ひろ",
  "ふみ",
  "まこと",
  "みなと",
  "みのり",
  "みらい",
  "ゆう",
  "ゆずき",
  "りお",
  "りん",
  "れい",
]);

/** A name for a new session's agent, avoiding the ones sessions still open are using while any is free. */
export function pickAgentName(taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set(taken);
  const free = AGENT_NAMES.filter((name) => !used.has(name));
  const pool = free.length > 0 ? free : AGENT_NAMES;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] as string;
}
