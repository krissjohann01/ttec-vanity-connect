import words from './words.json';

/**
 * Standard telephone keypad letter mapping. 0 and 1 have no letters, so a
 * digit sequence containing them can never be (fully) replaced by a word.
 */
export const DIGIT_TO_LETTERS: Record<string, string> = {
  '2': 'ABC',
  '3': 'DEF',
  '4': 'GHI',
  '5': 'JKL',
  '6': 'MNO',
  '7': 'PQRS',
  '8': 'TUV',
  '9': 'WXYZ',
};

const LETTER_TO_DIGIT: Record<string, string> = Object.entries(DIGIT_TO_LETTERS).reduce(
  (acc, [digit, letters]) => {
    for (const letter of letters) acc[letter] = digit;
    return acc;
  },
  {} as Record<string, string>,
);

/** Converts a word (letters only, any case) to its keypad digit signature, e.g. "Cab" -> "222". */
export function wordToDigits(word: string): string {
  let out = '';
  for (const ch of word.toUpperCase()) {
    const digit = LETTER_TO_DIGIT[ch];
    if (!digit) throw new Error(`Character "${ch}" has no keypad digit (word: "${word}")`);
    out += digit;
  }
  return out;
}

export type DictionaryIndex = Map<string, string[]>;

/**
 * Groups words by their digit signature. Words are expected to already be
 * ordered most-common-first (see words.json); that order is preserved within
 * each bucket, which lets scoring treat "earlier in the bucket" as "more
 * common" without carrying a separate frequency field around.
 */
export function buildDictionaryIndex(dictionaryWords: string[] = words as string[]): DictionaryIndex {
  const index: DictionaryIndex = new Map();
  for (const word of dictionaryWords) {
    const digits = wordToDigits(word);
    const bucket = index.get(digits);
    if (bucket) {
      bucket.push(word);
    } else {
      index.set(digits, [word]);
    }
  }
  return index;
}

// Built once per Lambda execution environment (module scope = reused across
// warm invocations), not per-request -- see design-notes.md "cold start".
export const DEFAULT_DICTIONARY_INDEX = buildDictionaryIndex();
export const DEFAULT_WORDS: readonly string[] = words as string[];

/** word -> position in the frequency-ranked list (lower = more common). O(1) lookup for scoring. */
export const DEFAULT_WORD_RANKS: ReadonlyMap<string, number> = new Map(
  DEFAULT_WORDS.map((word, i) => [word, i]),
);
