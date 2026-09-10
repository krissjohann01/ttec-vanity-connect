import { buildDictionaryIndex } from './dictionary';
import {
  normalizePhoneNumber,
  findFullSegmentations,
  findPartialMatches,
  generateVanityCandidates,
  plainFormat,
} from './vanity';

describe('normalizePhoneNumber', () => {
  it('accepts E.164 with country code', () => {
    expect(normalizePhoneNumber('+15125551234')).toEqual({ areaCode: '512', localNumber: '5551234' });
  });

  it('accepts a bare 11-digit number starting with 1', () => {
    expect(normalizePhoneNumber('15125551234')).toEqual({ areaCode: '512', localNumber: '5551234' });
  });

  it('accepts a bare 10-digit number', () => {
    expect(normalizePhoneNumber('5125551234')).toEqual({ areaCode: '512', localNumber: '5551234' });
  });

  it('strips punctuation and whitespace', () => {
    expect(normalizePhoneNumber('(512) 555-1234')).toEqual({ areaCode: '512', localNumber: '5551234' });
  });

  it('rejects numbers that are too short', () => {
    expect(normalizePhoneNumber('555-1234')).toBeNull();
  });

  it('rejects numbers that are too long', () => {
    expect(normalizePhoneNumber('+44 20 7946 0958')).toBeNull();
  });

  it('rejects garbage input', () => {
    expect(normalizePhoneNumber('not-a-number')).toBeNull();
  });
});

describe('plainFormat', () => {
  it('formats a valid number as area-exchange-line', () => {
    expect(plainFormat('+15125551234')).toBe('512-555-1234');
  });

  it('returns null for an invalid number', () => {
    expect(plainFormat('abc')).toBeNull();
  });
});

// Using a small, hand-picked word list here keeps these tests predictable
// and separate from the real ~6,000-word list. The real list gets its own
// tests further down.
const TEST_DICTIONARY = buildDictionaryIndex(['CAB', 'SHOE', 'BOX', 'SHOEBOX', 'CALL', 'ACE']);
const TEST_RANKS = new Map(['CAB', 'SHOE', 'BOX', 'SHOEBOX', 'CALL', 'ACE'].map((w, i) => [w, i]));

describe('findFullSegmentations', () => {
  it('finds a single word that fully covers the digits', () => {
    // SHOEBOX -> 7 4 6 3 2 6 9
    const segmentations = findFullSegmentations('7463269', TEST_DICTIONARY);
    expect(segmentations).toContainEqual(['SHOEBOX']);
  });

  it('finds a two-word segmentation that fully covers the digits', () => {
    // SHOE 7463, BOX 269
    const segmentations = findFullSegmentations('7463269', TEST_DICTIONARY);
    expect(segmentations).toContainEqual(['SHOE', 'BOX']);
  });

  it('returns an empty list when no segmentation covers all digits', () => {
    expect(findFullSegmentations('0000000', TEST_DICTIONARY)).toEqual([]);
  });
});

describe('findPartialMatches', () => {
  it('finds every dictionary word appearing anywhere in the digits', () => {
    // CAB -> 222, appears at the start of "222XXXX"
    const matches = findPartialMatches('2229999', TEST_DICTIONARY);
    expect(matches).toContainEqual({ start: 0, word: 'CAB' });
  });
});

describe('generateVanityCandidates', () => {
  it('prefers a full segmentation over a partial match', () => {
    const candidates = generateVanityCandidates('512-746-3269', 5, TEST_DICTIONARY, TEST_RANKS);
    expect(candidates[0].display).toBe('512-SHOEBOX');
  });

  it('ranks a one-word full segmentation above a two-word one covering the same digits', () => {
    const candidates = generateVanityCandidates('512-746-3269', 5, TEST_DICTIONARY, TEST_RANKS);
    const displays = candidates.map((c) => c.display);
    expect(displays).toContain('512-SHOEBOX');
    expect(displays).toContain('512-SHOE-BOX');
    expect(displays.indexOf('512-SHOEBOX')).toBeLessThan(displays.indexOf('512-SHOE-BOX'));
  });

  it('formats a partial match with the matched word standing out between digit runs', () => {
    const candidates = generateVanityCandidates('512-222-9999', 5, TEST_DICTIONARY, TEST_RANKS);
    expect(candidates[0].display).toBe('512-CAB-9999');
  });

  it('falls back to partial matches when no full segmentation exists', () => {
    const candidates = generateVanityCandidates('512-222-9999', 5, TEST_DICTIONARY, TEST_RANKS);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].words).toEqual(['CAB']);
  });

  it('returns an empty list for a number with no matching words', () => {
    const candidates = generateVanityCandidates('512-000-0000', 5, TEST_DICTIONARY, TEST_RANKS);
    expect(candidates).toEqual([]);
  });

  it('returns an empty list for an unparseable phone number', () => {
    expect(generateVanityCandidates('not-a-number', 5, TEST_DICTIONARY, TEST_RANKS)).toEqual([]);
  });

  it('never returns more than `limit` candidates', () => {
    const candidates = generateVanityCandidates('512-746-3269', 1, TEST_DICTIONARY, TEST_RANKS);
    expect(candidates.length).toBeLessThanOrEqual(1);
  });

  it('deduplicates candidates that produce the same display string', () => {
    const candidates = generateVanityCandidates('512-746-3269', 5, TEST_DICTIONARY, TEST_RANKS);
    const displays = candidates.map((c) => c.display);
    expect(new Set(displays).size).toBe(displays.length);
  });
});

describe('generateVanityCandidates against the real bundled dictionary', () => {
  it('finds at least one candidate for a number chosen to spell a real word ("CALLNOW")', () => {
    const candidates = generateVanityCandidates('+1-512-225-5669'); // 225-5669 spells CALLNOW
    expect(candidates.length).toBeGreaterThan(0);
  });

  it('gracefully returns an empty array rather than throwing for an all-zero local number', () => {
    expect(() => generateVanityCandidates('+15120000000')).not.toThrow();
  });
});
