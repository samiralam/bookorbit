import { toAbsAuthor } from './abs-author.mapper';

describe('toAbsAuthor', () => {
  it('maps an author to the ABS shape with an encoded id', () => {
    expect(toAbsAuthor({ id: 1, name: 'Andy Weir', description: 'bio', numBooks: 3 })).toEqual({
      id: 'aut_1',
      asin: null,
      name: 'Andy Weir',
      description: 'bio',
      imagePath: null,
      addedAt: 0,
      updatedAt: 0,
      numBooks: 3,
    });
  });

  it('defaults numBooks to 0 and description to null when absent', () => {
    expect(toAbsAuthor({ id: 2, name: 'Brandon Sanderson', description: null })).toMatchObject({
      id: 'aut_2',
      description: null,
      numBooks: 0,
    });
  });
});
