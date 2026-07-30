// Deterministic, locale-independent date rendering.
//
// A timestamp is rendered as the calendar date it NAMES, in the offset it
// carries: "2026-07-28T20:00:00-04:00" is Tuesday 28 July for the caller who
// wrote it, and that is what the prompt says. Formatting the UTC instant instead
// put that turn on Wednesday 29 July, so every "yesterday"/"last Tuesday" in it
// resolved a day off and the wrong weekday was baked into the stored fact.
//
// Two consequences of that rule, both deliberate:
// - A "Z" timestamp renders as a UTC date. A caller whose users are not in UTC
//   must send offset-bearing `observedAt` timestamps, not UTC ones, or the turn
//   is labelled with its UTC day.
// - A timestamp with no offset at all ("2026-07-28T20:00:00") is read as the
//   wall clock it states. new Date() would read it as the SERVER's local time,
//   which makes the prompt depend on the machine; this does not.
// Nothing here uses Intl or the local timezone, so rendering is identical on
// every machine.

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Date, optional time, optional offset. The date part is already offset-local. */
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** The calendar date a timestamp names, with no timezone conversion applied. */
export interface CivilDate {
  year: number;
  /** 1-12. */
  month: number;
  day: number;
  /** 0 = Sunday. */
  weekday: number;
}

export function parseIso(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toCivil(year: number, month: number, day: number): CivilDate | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utc = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls 31 February over into March; reject rather than rename the day.
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day, weekday: utc.getUTCDay() };
}

/**
 * Calendar date of a timestamp, honouring the offset it carries.
 *
 * ISO-8601 only, deliberately. Anything else ("July 28 2026", an epoch string,
 * RFC-2822 without a zone) went through `new Date()`, which reads a zone-less
 * string as the SERVER's local time — so the same input produced a different
 * weekday on a different host, and that weekday is what a model uses to resolve
 * "last Tuesday". A date we cannot determine unambiguously is reported as
 * absent; the prompt already has a "date not recorded" path, and no date beats a
 * machine-dependent one.
 */
export function civilDate(value: string | undefined): CivilDate | null {
  if (!value) return null;
  const match = ISO_TIMESTAMP.exec(value.trim());
  if (!match) return null;
  // ISO shape but an impossible date: report nothing rather than let Date roll
  // 31 February over into 3 March and label the turn with a day nobody wrote.
  return toCivil(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** "Wednesday, 29 July 2026" — the anchor a model needs to resolve "last Tuesday". */
export function formatLongDate(value: string | undefined): string | null {
  const date = civilDate(value);
  if (!date) return null;
  return `${WEEKDAYS[date.weekday]}, ${date.day} ${MONTHS[date.month - 1]} ${date.year}`;
}

/**
 * Every surface form a resolved date could plausibly take, so the grounding
 * check does not flag a correctly normalized date as invented text.
 */
export function dateVocabulary(value: string | undefined): string[] {
  const date = civilDate(value);
  if (!date) return [];
  const { day, year } = date;
  const month = MONTHS[date.month - 1];
  const iso = `${String(year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return [
    `${WEEKDAYS[date.weekday]}`,
    `${month} ${month.slice(0, 3)}`,
    `${day} ${month} ${year}`,
    `${month} ${day} ${year}`,
    iso.replace(/-/g, " "),
    iso,
    `${year}`,
  ];
}
