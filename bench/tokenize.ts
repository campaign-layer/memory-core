// Bench-local tokenizer. Deliberately NOT imported from src/utils.ts so baselines
// stay frozen even if src tokenization changes underneath us.

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "did", "do", "does",
  "for", "from", "had", "has", "have", "i", "if", "in", "is", "it", "its", "me", "my",
  "of", "on", "or", "our", "should", "so", "that", "the", "their", "them", "then",
  "there", "they", "this", "to", "was", "we", "were", "what", "when", "where", "which",
  "who", "will", "with", "you", "your",
]);

export function tokenize(text: string, dropStopwords = true): string[] {
  const raw = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1);
  return dropStopwords ? raw.filter((t) => !STOPWORDS.has(t)) : raw;
}
