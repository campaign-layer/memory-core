// Every untrusted value that reaches the prompt goes through here.
//
// The prompt renders one turn per line as `[i] (role) Date: text`, so the two
// things an injected value must not be able to do are start a new line and look
// like that prefix. Collapsing control characters and line separators kills the
// first; rewriting bracketed integers kills the second, inline as well as at a
// line start. Length caps stop a display name or thread id from flooding the
// window.
//
// This is prompt hygiene, not a guarantee: the text of a turn is still attacker
// authored and can still contain instructions. What stops those from becoming
// memories is the grounding + provenance gate on the way out, not this function.
// Only the prompt rendering is sanitized; stored text is never modified.

/** Turn text. Generous cap: batching and maxTokens are the real size control. */
export const MAX_PROMPT_TEXT = 4000;
/** Actor / thread labels. Long enough for a real name, short enough to be inert. */
export const MAX_PROMPT_LABEL = 120;

// C0 and C1 control characters plus the Unicode line/paragraph separators.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const BRACKETED_INDEX = /\[\s*(\d+)\s*\]/g;

export function sanitizePromptText(value: string, maxLength = MAX_PROMPT_TEXT): string {
  const flat = String(value)
    .replace(CONTROL, " ")
    .replace(BRACKETED_INDEX, "($1)")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}...` : flat;
}

/**
 * Header values (actor, conversation). Brackets carry no meaning in a name, and
 * quotes are removed because the header renders these inside quotes: a flattened
 * label that cannot break out of its own quoting reads as one value rather than
 * as more prompt.
 */
export function sanitizePromptLabel(value: string, maxLength = MAX_PROMPT_LABEL): string {
  return sanitizePromptText(value, maxLength)
    .replace(/[[\]"'`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Roles are rendered inside `(...)`, so a role of `user) Monday, 1 May 2020: ...`
 * would forge a turn block. Roles are enum-like in practice; anything else is
 * folded to an underscore.
 */
export function sanitizeRole(value: string): string {
  const role = String(value).replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  return role;
}
