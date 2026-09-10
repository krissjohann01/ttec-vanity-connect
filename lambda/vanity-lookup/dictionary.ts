import words from './words.json';

/**
 * The letters on a standard phone keypad. 0 and 1 have no letters, so a
 * number that contains them can never be turned fully into a word.
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

/** Turns a word into the digits you'd press to spell it, e.g. "Cab" -> "222". */
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
 * Groups words by the digits they spell. words.json is already sorted from
 * most common to least common, and that order carries over into each group
 * -- so later code can tell "more common" just by checking what's earlier
 * in the list, without needing to store a separate rank number per word.
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

// This only runs once when the Lambda starts up, not on every phone call --
// see design-notes.md's note on cold starts for why that matters.
export const DEFAULT_DICTIONARY_INDEX = buildDictionaryIndex();
export const DEFAULT_WORDS: readonly string[] = words as string[];

/** Looks up a word's position in the common-words list (lower number = more common). Fast lookup for scoring. */
export const DEFAULT_WORD_RANKS: ReadonlyMap<string, number> = new Map(
  DEFAULT_WORDS.map((word, i) => [word, i]),
);
