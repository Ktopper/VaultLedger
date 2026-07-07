import matter from "gray-matter";

export type CanonicalValue =
  | { type: "date"; value: string } // ISO yyyy-mm-dd
  | { type: "number"; value: number }
  | { type: "string"; value: string } // case + whitespace folded
  | { type: "unparseable"; raw: string }; // never compared

/** key (folded) -> canonicalized value */
export type MemoryFacts = Map<string, CanonicalValue>;

// Deterministic month-name lookup — no Date parsing of arbitrary strings
// (which would be timezone-dependent / nondeterministic). Both full names
// and common abbreviations map to a zero-padded month number.
const MONTHS: Record<string, string> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

// Year-first (yyyy-mm-dd / yyyy/mm/dd) is unambiguous — order is fixed, so we
// can parse it regardless of separator.
const ISO_DATE_RE = /^(\d{4})[-/](\d{2})[-/](\d{2})$/;
// Slash date with a 1-2 digit leading field (m/d/y vs d/m/y) is genuinely
// ambiguous — we cannot know which of the first two fields is the month.
// Precision-first: mark unparseable rather than guess a convention.
const AMBIGUOUS_SLASH_DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
// Leading/trailing currency symbols stripped before the number test.
const CURRENCY_RE = /^[$€£¥]\s*|\s*[$€£¥]$/g;
// Trailing sentence punctuation stripped before folding a string value.
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;
// "Mon day[, year]" / "Month day[, year]" — year is optional so we can
// detect the date-shaped-but-yearless case (-> unparseable) separately.
const MONTH_DAY_YEAR_RE = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?$/;
// "day Mon[ year]" / "day Month[ year]"
const DAY_MONTH_YEAR_RE = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s*(\d{4})?$/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;
// A date-shaped value that also carries a time component (yyyy-mm-dd followed
// by "T" or a space and then a digit). Interpreting the time would require
// picking a timezone, which can shift the calendar day nondeterministically —
// so these are always unparseable rather than silently narrowed to a date.
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d/;

/**
 * Try to interpret `trimmed` as a date. Returns:
 *  - {type:"date", ...} for a recognized, fully-determined (year present) date
 *  - {type:"unparseable", ...} for something date-shaped (month + day) but
 *    missing a year, so the detector can skip it rather than guess
 *  - null if it isn't date-shaped at all (caller falls through to number/string)
 */
function tryDate(trimmed: string): CanonicalValue | null {
  if (DATETIME_RE.test(trimmed)) {
    return { type: "unparseable", raw: trimmed };
  }

  const iso = ISO_DATE_RE.exec(trimmed);
  if (iso) {
    return { type: "date", value: `${iso[1]!}-${iso[2]!}-${iso[3]!}` };
  }

  if (AMBIGUOUS_SLASH_DATE_RE.test(trimmed)) {
    return { type: "unparseable", raw: trimmed };
  }

  const monDayYear = MONTH_DAY_YEAR_RE.exec(trimmed);
  if (monDayYear) {
    const monthName = monDayYear[1]!;
    const day = monDayYear[2]!;
    const year = monDayYear[3];
    const mm = MONTHS[monthName.toLowerCase()];
    if (mm) {
      if (year) {
        return { type: "date", value: `${year}-${mm}-${day.padStart(2, "0")}` };
      }
      return { type: "unparseable", raw: trimmed };
    }
  }

  const dayMonYear = DAY_MONTH_YEAR_RE.exec(trimmed);
  if (dayMonYear) {
    const day = dayMonYear[1]!;
    const monthName = dayMonYear[2]!;
    const year = dayMonYear[3];
    const mm = MONTHS[monthName.toLowerCase()];
    if (mm) {
      if (year) {
        return { type: "date", value: `${year}-${mm}-${day.padStart(2, "0")}` };
      }
      return { type: "unparseable", raw: trimmed };
    }
  }

  return null;
}

export function canonicalize(raw: string): CanonicalValue {
  const trimmed = raw.trim();

  const dateResult = tryDate(trimmed);
  if (dateResult) {
    return dateResult;
  }

  const numberCandidate = trimmed.replace(CURRENCY_RE, "").replace(/,/g, "");
  if (NUMBER_RE.test(numberCandidate)) {
    return { type: "number", value: parseFloat(numberCandidate) };
  }

  // NFC-normalize so composed/decomposed unicode forms (e.g. "café") fold to
  // the same value; strip trailing sentence punctuation so "Alice." == "Alice".
  const folded = trimmed
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(TRAILING_PUNCT_RE, "");
  return { type: "string", value: folded };
}

function foldKey(key: string): string {
  return key.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Case/whitespace-fold for entity names (shared by the entity matcher):
 * lowercase, collapse internal runs of whitespace to single spaces, trim.
 * Same folding `extract` applies to fact keys, so "Nova", "nova", and
 * " nova " all fold to one canonical form.
 */
export function foldEntity(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// Body lines: an optional bold-markdown label, then a colon (ASCII ":" or the
// CJK fullwidth colon U+FF1A), then a value. e.g. "deadline: 2026-08-15",
// "**owner:** Alice", or "owner：Alice".
const FACT_LINE_RE = /^\s*(?:\*\*)?([A-Za-z][\w \-]*?)(?:\*\*)?\s*[:：]\s*(.+?)\s*$/;

// URL schemes that must never be captured as a fact key/value: a bare URL
// like "See https://example.com" would otherwise parse as key "https",
// value "//example.com" — a prose sentence, not a declared fact.
const URL_SCHEME_STOPLIST = new Set([
  "http",
  "https",
  "ftp",
  "ftps",
  "mailto",
  "file",
  "tel",
  "ws",
  "wss",
]);

function looksLikeUrl(key: string, value: string): boolean {
  if (URL_SCHEME_STOPLIST.has(key)) return true;
  return value.startsWith("//");
}

export function extract(noteText: string): MemoryFacts {
  const { data, content } = matter(noteText);
  const facts: MemoryFacts = new Map();

  for (const [key, rawValue] of Object.entries(data ?? {})) {
    if (key === "ledger") continue;

    let asString: string;
    if (rawValue instanceof Date) {
      // gray-matter's YAML engine (js-yaml) auto-coerces unquoted
      // yyyy-mm-dd-shaped (and datetime-shaped) scalars into JS Date
      // objects. toISOString() is deterministic (always UTC, no
      // local-timezone/system-clock dependence) given the Date object's
      // fixed internal timestamp — but we can't recover the *original*
      // scalar text here to see whether it carried a time component. As a
      // proxy: a date-only YAML scalar parses to UTC midnight, so a
      // non-midnight UTC time-of-day means the source had a time component.
      // In that case emit the full ISO string so DATETIME_RE below marks it
      // unparseable (never day-shifted); only a date-only value canonicalizes.
      const isMidnightUtc =
        rawValue.getUTCHours() === 0 &&
        rawValue.getUTCMinutes() === 0 &&
        rawValue.getUTCSeconds() === 0 &&
        rawValue.getUTCMilliseconds() === 0;
      asString = isMidnightUtc ? rawValue.toISOString().slice(0, 10) : rawValue.toISOString();
    } else if (
      typeof rawValue === "string" ||
      typeof rawValue === "number" ||
      typeof rawValue === "boolean"
    ) {
      asString = String(rawValue);
    } else {
      continue; // arrays/objects/null/undefined skipped
    }

    const folded = foldKey(key);
    if (facts.has(folded)) continue; // first occurrence wins
    facts.set(folded, canonicalize(asString));
  }

  for (const line of content.split("\n")) {
    const m = FACT_LINE_RE.exec(line);
    if (!m) continue;
    const key = m[1]!;
    // The label-only char class ([A-Za-z][\w \-]*?) can't include "*", so a
    // "**key:** value" line (colon inside the bold span) leaves a stray
    // leading "**" on the captured value ("** Alice") — strip markdown bold
    // markers left dangling on either side of the captured value.
    const rawValue = m[2]!.replace(/^\*+\s*/, "").replace(/\s*\*+$/, "");

    const folded = foldKey(key);
    if (looksLikeUrl(folded, rawValue)) continue; // URL/scheme, not a fact
    if (facts.has(folded)) continue; // first occurrence wins
    facts.set(folded, canonicalize(rawValue));
  }

  return facts;
}
