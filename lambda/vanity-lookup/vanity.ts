import { DictionaryIndex, DEFAULT_DICTIONARY_INDEX, DEFAULT_WORD_RANKS } from './dictionary';

/** A NANP (US/Canada) number split into its dialable area code and 7-digit local number. */
export interface ParsedPhoneNumber {
  areaCode: string;
  localNumber: string;
}

export interface VanityCandidate {
  /** Human-readable form, e.g. "CAB-3729". */
  display: string;
  /** The 7-digit local number this candidate replaces (unformatted). */
  digits: string;
  /** Dictionary words used, in left-to-right order. Empty for the all-digits fallback. */
  words: string[];
  /** Higher is "better" -- see scoreCandidate for the definition. */
  score: number;
}

const LOCAL_NUMBER_LENGTH = 7;
const MAX_WORDS_PER_SEGMENTATION = 3;
const MIN_WORD_LENGTH = 3;

/**
 * Accepts common real-world formats a caller ID or a human might produce
 * ("+15125551234", "(512) 555-1234", "512-555-1234", "15125551234") and
 * reduces them to a bare 10-digit NANP number, or null if that's not
 * possible. Only NANP (1 + 10 digits) numbers are supported -- see
 * design-notes.md "shortcuts" for why international numbers are out of scope.
 */
export function normalizePhoneNumber(raw: string): ParsedPhoneNumber | null {
  const digitsOnly = raw.replace(/\D/g, '');
  const tenDigits =
    digitsOnly.length === 11 && digitsOnly.startsWith('1')
      ? digitsOnly.slice(1)
      : digitsOnly.length === 10
        ? digitsOnly
        : null;
  if (!tenDigits) return null;
  return {
    areaCode: tenDigits.slice(0, 3),
    localNumber: tenDigits.slice(3),
  };
}

/**
 * Finds every way to fully segment `digits` into 1..MAX_WORDS_PER_SEGMENTATION
 * dictionary words with no leftover digits. Classic word-break backtracking;
 * the search space for a 7-digit number is tiny (at most 2^6 split points)
 * so no memoization is needed to stay well inside the Lambda time budget.
 */
export function findFullSegmentations(digits: string, dictionary: DictionaryIndex): string[][] {
  const results: string[][] = [];

  function backtrack(remaining: string, wordsSoFar: string[]): void {
    if (remaining.length === 0) {
      if (wordsSoFar.length > 0) results.push([...wordsSoFar]);
      return;
    }
    if (wordsSoFar.length >= MAX_WORDS_PER_SEGMENTATION) return;

    for (let len = Math.min(remaining.length, 7); len >= MIN_WORD_LENGTH; len--) {
      const prefix = remaining.slice(0, len);
      const matches = dictionary.get(prefix);
      if (!matches) continue;
      // Only try the most common match per digit-signature per branch --
      // homographs-in-digits (e.g. two different 3-letter words sharing a
      // signature) would otherwise multiply the search for no real benefit,
      // since scoring already prefers the most common word.
      wordsSoFar.push(matches[0]);
      backtrack(remaining.slice(len), wordsSoFar);
      wordsSoFar.pop();
    }
  }

  backtrack(digits, []);
  return results;
}

/**
 * Finds the best single dictionary word for every contiguous substring of
 * `digits` (length >= MIN_WORD_LENGTH), used as a fallback when no full
 * segmentation exists -- mirrors how real vanity numbers usually work
 * (1-800-FLOWERS keeps the toll-free prefix numeric, only part becomes a word).
 */
export function findPartialMatches(
  digits: string,
  dictionary: DictionaryIndex,
): { start: number; word: string }[] {
  const matches: { start: number; word: string }[] = [];
  for (let start = 0; start < digits.length; start++) {
    for (let len = Math.min(digits.length - start, 7); len >= MIN_WORD_LENGTH; len--) {
      const substr = digits.slice(start, start + len);
      const bucket = dictionary.get(substr);
      if (bucket) matches.push({ start, word: bucket[0] });
    }
  }
  return matches;
}

/**
 * "Best" is defined as (in priority order):
 *   1. More of the 7 digits converted to letters (a fully-worded number beats
 *      a partially-worded one -- it's what people actually remember).
 *   2. Fewer dictionary words used to cover that many digits (SHOEBOX beats
 *      SHOE-BOX -- one memorable word beats a run-on of two).
 *   3. More common words (average dictionary rank -- avoids obscure words a
 *      caller wouldn't recognize when it's read aloud).
 *   4. Starting closer to the front of the local number (the part callers
 *      hear/read first is the part that sticks).
 * Full rationale is in docs/design-notes.md ("Best" is defined as you see fit).
 */
export function scoreCandidate(digitsCovered: number, wordCount: number, avgRank: number, startPos: number): number {
  const coverageScore = digitsCovered * 1000;
  const conciseness = (MAX_WORDS_PER_SEGMENTATION - wordCount + 1) * 100;
  const commonality = Math.max(0, 100 - avgRank / 50);
  const earliness = Math.max(0, 10 - startPos);
  return coverageScore + conciseness + commonality + earliness;
}

/**
 * Renders segments word-boundary-first ("512-CAB-9999", "512-SHOE-BOX",
 * "512-SHOEBOX") rather than a fixed 3-4 digit split. This matters for more
 * than looks: it's also what keeps candidates with a different word
 * breakdown of the same digits (SHOEBOX vs. SHOE+BOX) from rendering as the
 * same display string and silently deduplicating one of them away.
 */
function formatDisplay(areaCode: string, localDigits: string, replacements: { start: number; text: string }[]): string {
  const byStart = new Map(replacements.map((r) => [r.start, r.text]));
  const segments: string[] = [];
  let digitRun = '';
  let i = 0;
  while (i < localDigits.length) {
    const word = byStart.get(i);
    if (word) {
      if (digitRun) {
        segments.push(digitRun);
        digitRun = '';
      }
      segments.push(word);
      i += word.length;
    } else {
      digitRun += localDigits[i];
      i += 1;
    }
  }
  if (digitRun) segments.push(digitRun);
  return `${areaCode}-${segments.join('-')}`;
}

function rankOf(word: string, ranks: ReadonlyMap<string, number>): number {
  return ranks.get(word) ?? ranks.size;
}

/**
 * Produces up to `limit` ranked vanity-number candidates for a phone number.
 * Returns [] if the number can't be parsed or no dictionary words fit it at
 * all (the Lambda handler falls back to the plain digits in that case).
 */
export function generateVanityCandidates(
  rawPhoneNumber: string,
  limit = 5,
  dictionary: DictionaryIndex = DEFAULT_DICTIONARY_INDEX,
  wordRanks: ReadonlyMap<string, number> = DEFAULT_WORD_RANKS,
): VanityCandidate[] {
  const parsed = normalizePhoneNumber(rawPhoneNumber);
  if (!parsed) return [];
  const { areaCode, localNumber } = parsed;

  const candidatesByDisplay = new Map<string, VanityCandidate>();

  const addCandidate = (
    words: string[],
    replacements: { start: number; text: string }[],
    digitsCovered: number,
  ) => {
    const avgRank =
      words.reduce((sum, w) => sum + rankOf(w, wordRanks), 0) / Math.max(words.length, 1);
    const startPos = replacements.length > 0 ? Math.min(...replacements.map((r) => r.start)) : LOCAL_NUMBER_LENGTH;
    const score = scoreCandidate(digitsCovered, words.length, avgRank, startPos);
    const display = formatDisplay(areaCode, localNumber, replacements);
    const existing = candidatesByDisplay.get(display);
    if (!existing || score > existing.score) {
      candidatesByDisplay.set(display, { display, digits: localNumber, words, score });
    }
  };

  // Tier 1: full segmentations (every digit becomes a letter).
  for (const segmentation of findFullSegmentations(localNumber, dictionary)) {
    const replacements: { start: number; text: string }[] = [];
    let cursor = 0;
    for (const word of segmentation) {
      replacements.push({ start: cursor, text: word });
      cursor += word.length;
    }
    addCandidate(segmentation, replacements, LOCAL_NUMBER_LENGTH);
  }

  // Tier 2: best single-word substring matches, used to fill out the list
  // when full segmentations are scarce or absent.
  for (const { start, word } of findPartialMatches(localNumber, dictionary)) {
    addCandidate([word], [{ start, text: word }], word.length);
  }

  return [...candidatesByDisplay.values()]
    .sort((a, b) => b.score - a.score || a.display.localeCompare(b.display))
    .slice(0, limit);
}

/** Plain, hyphen-formatted fallback ("512-555-1234") for when no word fits at all. */
export function plainFormat(rawPhoneNumber: string): string | null {
  const parsed = normalizePhoneNumber(rawPhoneNumber);
  if (!parsed) return null;
  return `${parsed.areaCode}-${parsed.localNumber.slice(0, 3)}-${parsed.localNumber.slice(3)}`;
}
