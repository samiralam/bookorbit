import { encodeAbsId } from '../abs-id.util';

export interface AbsAuthorRow {
  id: number;
  name: string;
  description: string | null;
  numBooks?: number;
}

/** ABS sorts/indexes authors by a "Last, First" key; mirror its basic split on the final space. */
function toLastFirst(name: string): string {
  const trimmed = name.trim();
  const idx = trimmed.lastIndexOf(' ');
  return idx === -1 ? trimmed : `${trimmed.slice(idx + 1)}, ${trimmed.slice(0, idx)}`;
}

/**
 * Map a BookOrbit author to the ABS Author shape (`LibraryController.getAuthors` /
 * `AuthorController.findOne`). BookOrbit has no ASIN/timestamps/image-path for authors, so those are
 * emitted as the nullable/zero defaults ABS uses for unknown values. `numBooks` and `lastFirst` are
 * always present: author-centric clients (e.g. Prologue) decode the Author model with a non-optional
 * count and use `lastFirst` for the A–Z index.
 */
export function toAbsAuthor(author: AbsAuthorRow): Record<string, unknown> {
  return {
    id: encodeAbsId('author', author.id),
    asin: null,
    name: author.name,
    lastFirst: toLastFirst(author.name),
    description: author.description ?? null,
    imagePath: null,
    addedAt: 0,
    updatedAt: 0,
    numBooks: author.numBooks ?? 0,
  };
}
