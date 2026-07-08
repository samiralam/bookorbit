import { encodeAbsId } from '../abs-id.util';

export interface AbsAuthorRow {
  id: number;
  name: string;
  description: string | null;
  numBooks?: number;
}

/** ABS sorts/indexes authors by a "Last, First" key; mirror its basic split on the final space. */
export function toLastFirst(name: string): string {
  const trimmed = name.trim();
  const idx = trimmed.lastIndexOf(' ');
  return idx === -1 ? trimmed : `${trimmed.slice(idx + 1)}, ${trimmed.slice(0, idx)}`;
}

/**
 * Map a BookOrbit author to the ABS Author shape (`LibraryController.getAuthors` /
 * `AuthorController.findOne`, mirroring `Author.toOldJSONExpanded`). BookOrbit has no
 * ASIN/timestamps/image-path for authors, so those are emitted as the nullable/zero defaults ABS
 * uses for unknown values. The full field set matters: author-centric clients (e.g. Prologue) decode
 * the Author model with non-optional keys — notably `libraryId` and `numBooks` — and drop the entire
 * authors list (blanking the library) if any is absent. `lastFirst` drives the client's A–Z index.
 * BookOrbit authors are global (linked to libraries only via books), so `libraryAbsId` is the library
 * the author is being listed under.
 */
export function toAbsAuthor(author: AbsAuthorRow, libraryAbsId: string): Record<string, unknown> {
  return {
    id: encodeAbsId('author', author.id),
    asin: null,
    name: author.name,
    description: author.description ?? null,
    imagePath: null,
    libraryId: libraryAbsId,
    addedAt: 0,
    updatedAt: 0,
    numBooks: author.numBooks ?? 0,
    lastFirst: toLastFirst(author.name),
  };
}
