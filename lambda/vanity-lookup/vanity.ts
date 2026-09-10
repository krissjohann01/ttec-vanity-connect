import { DictionaryIndex, DEFAULT_DICTIONARY_INDEX, DEFAULT_WORD_RANKS } from './dictionary';

/** A US/Canada phone number split into its area code and 7-digit local number. */
export interface ParsedPhoneNumber {
  areaCode: string;
  localNumber: string;
}

export interface VanityCandidate {
  /** How it looks written out, e.g. "CAB-3729". */
  display: string;
  /** The 7 local digits this candidate is based on, with no formatting. */
  digits: string;
  /** The word(s) used, left to right. Empty when it's just plain digits. */
  words: string[];
  /** Higher means "better" -- see scoreCandidate below for what that means. */
  score: number;
}

const LOCAL_NUMBER_LENGTH = 7;
const MAX_WORDS_PER_SEGMENTATION = 3;
const MIN_WORD_LENGTH = 3;

/**
 * Takes a phone number in whatever common format it shows up in
 * ("+15125551234", "(512) 555-1234", "512-555-1234", "15125551234") and
 * turns it into a plain 10-digit US/Canada number, or returns null if it
 * can't. Only US/Canada numbers are supported -- see the "shortcuts"
 * section of design-notes.md for why other countries aren't handled.
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
 * Finds every way to spell out all of `digits` using 1 to
 * MAX_WORDS_PER_SEGMENTATION real words, with no digits left over. This is
 * the classic "can this be split into dictionary words" problem, solved by
 * just trying every split point. A 7-digit number only has a handful of
 * possible split points, so this is fast enough without needing anything
 * clever to speed it up.
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
      // If more than one word spells out the same digits, only try the most
      // common one here -- trying all of them would just search more without
      // finding anything better, since the scoring step already prefers the
      // more common word anyway.
      wordsSoFar.push(matches[0]);
      backtrack(remaining.slice(len), wordsSoFar);
      wordsSoFar.pop();
    }
  }

  backtrack(digits, []);
  return results;
}

/**
 * Finds the best word hiding anywhere inside `digits`, even if it doesn't
 * cover the whole number. Used as a backup when there's no way to spell the
 * whole thing as words. This is also just how most real vanity numbers
 * work -- 1-800-FLOWERS keeps the toll-free part as numbers and only turns
 * part of it into a word.
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
 * What makes a candidate "better" than another, in order of importance:
 *   1. More of the 7 digits turned into letters -- a number that's fully a
 *      word beats one that's only partly a word, since that's what people
 *      actually remember.
 *   2. Fewer words used to cover those digits -- SHOEBOX beats SHOE-BOX,
 *      since one clean word beats two words stuck together.
 *   3. More common words -- avoids picking an obscure word nobody would
 *      recognize when it's read out loud.
 *   4. Starting closer to the front of the number -- the part you hear
 *      first is the part that sticks.
 * The full explanation is in docs/design-notes.md.
 */
export function scoreCandidate(digitsCovered: number, wordCount: number, avgRank: number, startPos: number): number {
  const coverageScore = digitsCovered * 1000;
  const conciseness = (MAX_WORDS_PER_SEGMENTATION - wordCount + 1) * 100;
  const commonality = Math.max(0, 100 - avgRank / 50);
  const earliness = Math.max(0, 10 - startPos);
  return coverageScore + conciseness + commonality + earliness;
}

/**
 * Formats the number by breaking it at word boundaries ("512-CAB-9999",
 * "512-SHOE-BOX", "512-SHOEBOX") instead of always splitting it 3 digits,
 * then 4. This isn't just about looks: it's also what keeps two different
 * candidates that use the same digits but different words (SHOEBOX vs.
 * SHOE+BOX) from ending up looking identical and one silently getting
 * dropped as a duplicate.
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
 * Returns up to `limit` vanity-number ideas for a phone number, best first.
 * Returns an empty list if the number isn't valid or no word fits it at all
 * -- when that happens, the Lambda handler just falls back to the plain
 * digits instead.
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

  // First, look for ways to spell the whole number as words.
  for (const segmentation of findFullSegmentations(localNumber, dictionary)) {
    const replacements: { start: number; text: string }[] = [];
    let cursor = 0;
    for (const word of segmentation) {
      replacements.push({ start: cursor, text: word });
      cursor += word.length;
    }
    addCandidate(segmentation, replacements, LOCAL_NUMBER_LENGTH);
  }

  // Then add the best partial-word matches too, to fill out the list when
  // there aren't enough (or any) full-word matches.
  for (const { start, word } of findPartialMatches(localNumber, dictionary)) {
    addCandidate([word], [{ start, text: word }], word.length);
  }

  return [...candidatesByDisplay.values()]
    .sort((a, b) => b.score - a.score || a.display.localeCompare(b.display))
    .slice(0, limit);
}

/** Plain formatted number ("512-555-1234"), used when no word fits at all. */
export function plainFormat(rawPhoneNumber: string): string | null {
  const parsed = normalizePhoneNumber(rawPhoneNumber);
  if (!parsed) return null;
  return `${parsed.areaCode}-${parsed.localNumber.slice(0, 3)}-${parsed.localNumber.slice(3)}`;
}
