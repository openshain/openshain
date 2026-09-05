import type { Language } from "@openshain/core";

/**
 * Names a session's agent may go by, per language of the company. Given names that are also words
 * of nature, so they read as a person to talk to without pointing at anyone real, and lean on no
 * gender. Thirty each.
 */
export const AGENT_NAMES: Readonly<Record<Language, readonly string[]>> = Object.freeze({
  ja: Object.freeze([
    "あおい",
    "あかね",
    "あさひ",
    "いずみ",
    "いぶき",
    "うみ",
    "かえで",
    "かすみ",
    "こはる",
    "さくら",
    "しおん",
    "しずく",
    "すばる",
    "すみれ",
    "そら",
    "つばき",
    "つばさ",
    "なぎ",
    "なずな",
    "はづき",
    "ひかり",
    "ひなた",
    "ほたる",
    "みお",
    "みずき",
    "みなと",
    "みのり",
    "もみじ",
    "ゆずき",
    "わかば",
  ]),
  en: Object.freeze([
    "Ash",
    "Aspen",
    "Bay",
    "Birch",
    "Cedar",
    "Clover",
    "Coral",
    "Dawn",
    "Ember",
    "Fern",
    "Hazel",
    "Holly",
    "Indigo",
    "Iris",
    "Ivy",
    "Jade",
    "Juniper",
    "Laurel",
    "Maple",
    "Moss",
    "Olive",
    "Rain",
    "Reed",
    "River",
    "Robin",
    "Rowan",
    "Sage",
    "Sky",
    "Willow",
    "Wren",
  ]),
});

/** A name for a new session's agent in the company's language, avoiding the ones open sessions use while any is free. */
export function pickAgentName(
  language: Language,
  taken: Iterable<string>,
  random: () => number = Math.random,
): string {
  const names = AGENT_NAMES[language];
  const used = new Set(taken);
  const free = names.filter((name) => !used.has(name));
  const pool = free.length > 0 ? free : names;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] as string;
}
