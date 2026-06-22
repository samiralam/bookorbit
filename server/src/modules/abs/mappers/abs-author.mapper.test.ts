import { toAbsAuthor } from './abs-author.mapper';

describe('toAbsAuthor', () => {
  it('maps an author to the ABS shape with an encoded id and the listing libraryId', () => {
    expect(toAbsAuthor({ id: 1, name: 'Andy Weir', description: 'bio', numBooks: 3 }, 'lib_4')).toEqual({
      id: 'aut_1',
      asin: null,
      name: 'Andy Weir',
      description: 'bio',
      imagePath: null,
      libraryId: 'lib_4',
      addedAt: 0,
      updatedAt: 0,
      numBooks: 3,
      lastFirst: 'Weir, Andy',
    });
  });

  it('defaults numBooks to 0 and description to null when absent', () => {
    expect(toAbsAuthor({ id: 2, name: 'Brandon Sanderson', description: null }, 'lib_4')).toMatchObject({
      id: 'aut_2',
      description: null,
      libraryId: 'lib_4',
      numBooks: 0,
    });
  });
});
