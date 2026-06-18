/**
 * Audiobookshelf objects carry opaque string IDs (UUID-shaped in real ABS). BookOrbit uses
 * serial integer primary keys, so the ABS adapter exposes a deterministic, reversible string
 * encoding: a type prefix plus the integer. Clients treat these as opaque and only need them to
 * round-trip exactly through item / cover / progress / play requests.
 *
 * Prefixes are namespaced per entity so the same integer in two tables never collides.
 */
export const ABS_ID_PREFIX = {
  user: 'usr',
  library: 'lib',
  libraryItem: 'li',
  book: 'bk',
  author: 'aut',
  series: 'ser',
  collection: 'col',
  playlist: 'pl',
  bookFile: 'bf',
} as const;

export type AbsIdType = keyof typeof ABS_ID_PREFIX;

export function encodeAbsId(type: AbsIdType, id: number): string {
  return `${ABS_ID_PREFIX[type]}_${id}`;
}

/**
 * Decode a prefixed ABS id back to its integer. Returns null when the string does not match the
 * expected prefix or does not carry a positive integer, so callers can answer with a 404 rather
 * than throwing on malformed client input.
 */
export function decodeAbsId(type: AbsIdType, value: string | undefined | null): number | null {
  if (!value) return null;
  const prefix = `${ABS_ID_PREFIX[type]}_`;
  if (!value.startsWith(prefix)) return null;
  const raw = value.slice(prefix.length);
  if (!/^\d+$/.test(raw)) return null;
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}
