import { decodeAbsId, encodeAbsId } from './abs-id.util';

describe('abs-id.util', () => {
  it('round-trips ids per type', () => {
    expect(decodeAbsId('library', encodeAbsId('library', 42))).toBe(42);
    expect(decodeAbsId('libraryItem', encodeAbsId('libraryItem', 7))).toBe(7);
    expect(decodeAbsId('user', encodeAbsId('user', 1))).toBe(1);
  });

  it('produces namespaced, non-colliding ids for the same integer', () => {
    expect(encodeAbsId('library', 1)).not.toBe(encodeAbsId('libraryItem', 1));
    // Decoding with the wrong type prefix must fail rather than silently mismatch.
    expect(decodeAbsId('libraryItem', encodeAbsId('library', 1))).toBeNull();
  });

  it('rejects malformed or hostile input', () => {
    expect(decodeAbsId('library', undefined)).toBeNull();
    expect(decodeAbsId('library', '')).toBeNull();
    expect(decodeAbsId('library', 'lib_')).toBeNull();
    expect(decodeAbsId('library', 'lib_abc')).toBeNull();
    expect(decodeAbsId('library', 'lib_-5')).toBeNull();
    expect(decodeAbsId('library', 'lib_0')).toBeNull();
    expect(decodeAbsId('library', 'lib_1.5')).toBeNull();
    expect(decodeAbsId('library', '42')).toBeNull();
  });
});
