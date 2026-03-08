const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "for",
  "of",
  "in",
  "on",
  "at",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "it",
  "this",
  "that",
  "as",
  "by",
  "from",
  "you",
  "your",
  "we",
  "our",
  "they",
  "their",
]);

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function normalizeKey(text: string): string {
  return normalizeText(text).toLowerCase();
}

export function tokenize(text: string): string[] {
  return normalizeKey(text)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

export function overlapScore(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;

  let overlap = 0;
  for (const token of ta) {
    if (tb.has(token)) overlap++;
  }

  return overlap / Math.max(ta.size, tb.size);
}

export function recencyScore(iso: string, halfLifeDays = 30): number {
  const ageMs = Date.now() - new Date(iso).getTime();
  const ageDays = Math.max(ageMs / (1000 * 60 * 60 * 24), 0);
  return Math.exp((-Math.log(2) * ageDays) / halfLifeDays);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function uid(prefix = "mem"): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rand}`;
}

export function isExpired(lastSeenAt: string, decayPolicy: DecayPolicy, now = Date.now()): boolean {
  if (decayPolicy.kind === "none") return false;
  const ttlDays = decayPolicy.ttlDays ?? 180;
  if (ttlDays <= 0) return false;
  const ageMs = now - new Date(lastSeenAt).getTime();
  return ageMs > ttlDays * 24 * 60 * 60 * 1000;
}
import type { DecayPolicy } from "./types.js";
