// Tokenizer for the retrieval core. Mirrors the approach of src/utils.ts
// tokenize() (lowercase, strip non-alphanumeric, drop stopwords and 1-char
// tokens) and adds light stemming so morphological variants match.
// General stopwords only — no domain/topic vocabulary anywhere in this module.

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "at", "with",
  "is", "are", "was", "were", "be", "been", "being", "am", "it", "its", "this",
  "that", "these", "those", "as", "by", "from", "you", "your", "we", "our",
  "they", "their", "he", "she", "his", "her", "him", "them", "i", "me", "my",
  "but", "if", "then", "than", "so", "not", "no", "do", "does", "did", "done",
  "have", "has", "had", "will", "would", "can", "could", "should", "there",
  "here", "what", "which", "who", "whom", "when", "where", "how", "why",
  "into", "about", "over", "under", "up", "down", "out", "off", "again",
  "also", "just", "very", "too", "any", "all", "some", "such", "own", "same",
]);

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}

/** Suffix rules applied longest-first. `min` is the shortest allowed remainder. */
const DERIVATIONAL: Array<{ suffix: string; replacement: string; min: number }> = [
  { suffix: "ically", replacement: "", min: 4 },
  { suffix: "ational", replacement: "", min: 4 },
  { suffix: "iveness", replacement: "", min: 4 },
  { suffix: "ousness", replacement: "", min: 4 },
  { suffix: "fulness", replacement: "", min: 4 },
  { suffix: "ization", replacement: "", min: 4 },
  { suffix: "ation", replacement: "", min: 4 },
  { suffix: "ative", replacement: "", min: 4 },
  { suffix: "ement", replacement: "", min: 4 },
  { suffix: "ment", replacement: "", min: 4 },
  { suffix: "ness", replacement: "", min: 3 },
  { suffix: "able", replacement: "", min: 4 },
  { suffix: "ible", replacement: "", min: 4 },
  { suffix: "ance", replacement: "", min: 4 },
  { suffix: "ence", replacement: "", min: 4 },
  { suffix: "ical", replacement: "", min: 4 },
  { suffix: "ing", replacement: "", min: 3 },
  { suffix: "ion", replacement: "", min: 4 },
  { suffix: "ity", replacement: "", min: 4 },
  { suffix: "ous", replacement: "", min: 4 },
  { suffix: "ful", replacement: "", min: 4 },
  { suffix: "ize", replacement: "", min: 4 },
  { suffix: "ise", replacement: "", min: 4 },
  { suffix: "ify", replacement: "", min: 4 },
  { suffix: "est", replacement: "", min: 4 },
  { suffix: "ed", replacement: "", min: 3 },
  { suffix: "ly", replacement: "", min: 4 },
  { suffix: "er", replacement: "", min: 4 },
  { suffix: "ic", replacement: "", min: 4 },
  { suffix: "al", replacement: "", min: 4 },
];

/** Plural / third-person-singular stripping (S-stemmer with a few guards). */
function stripPlural(word: string): string {
  if (word.length < 4 || !word.endsWith("s")) return word;
  if (word.endsWith("ss") || word.endsWith("us") || word.endsWith("is")) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  for (const group of ["ches", "shes", "xes", "zes", "ses"]) {
    if (word.endsWith(group) && word.length - 2 >= 3) return word.slice(0, -2);
  }
  if (word.endsWith("es") && word.length - 2 >= 3) return word.slice(0, -1);
  return word.slice(0, -1);
}

function stripDerivational(word: string): string {
  for (const rule of DERIVATIONAL) {
    if (!word.endsWith(rule.suffix)) continue;
    const stem = word.slice(0, word.length - rule.suffix.length) + rule.replacement;
    if (stem.length >= rule.min) return stem;
  }
  return word;
}

/** running -> runn -> run. Skips vowels, s/z doubles, and digits. */
function undouble(word: string): string {
  if (word.length < 4) return word;
  const last = word[word.length - 1];
  if (last !== word[word.length - 2]) return word;
  if (last < "a" || last > "z") return word;
  if ("aeiou".includes(last) || last === "s" || last === "z") return word;
  return word.slice(0, -1);
}

/**
 * Collapse the trailing vowel so "allergy"/"allergies"/"allergic" and
 * "move"/"moving"/"moved" land on one stem. This is the rule that fixes the
 * audit's allergies/allergic miss; plain Porter yields allergi vs allerg.
 */
function normalizeFinalVowel(word: string): string {
  if (word.length < 4) return word;
  const last = word[word.length - 1];
  if (last === "e" || last === "y" || last === "i") return word.slice(0, -1);
  return word;
}

/**
 * Compact suffix stemmer: S-stemmer for plurals, a Porter-flavoured
 * derivational suffix list, consonant undoubling, then a trailing-vowel
 * collapse. Deliberately more aggressive than Porter on final e/y/i, which
 * trades a few collisions (care/car) for recall on morphological variants.
 */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  let w = stripPlural(word);
  w = stripDerivational(w);
  w = undouble(w);
  w = normalizeFinalVowel(w);
  return w.length === 0 ? word : w;
}

/** Lowercase, split on non-alphanumerics, drop stopwords/1-char tokens, stem. */
export function tokenize(text: string, options: { stem?: boolean } = {}): string[] {
  const useStem = options.stem !== false;
  const raw = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/);

  const out: string[] = [];
  for (const token of raw) {
    if (token.length < 2 || STOPWORDS.has(token)) continue;
    const value = useStem ? stem(token) : token;
    if (value.length >= 1) out.push(value);
  }
  return out;
}
