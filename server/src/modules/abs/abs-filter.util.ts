/**
 * ABS browse filters arrive as `filter=<group>.<base64url(value)>` (REIMPLEMENTATION_GUIDE §4.2).
 * The server splits on the **first** `.`, takes the group, and base64url-decodes the remainder.
 * For id-based groups (authors, series, genres, tags) the decoded value is the *encoded* ABS id;
 * for narrators/languages it is the raw name/code.
 */
export interface AbsFilter {
  group: string;
  value: string;
}

export function decodeAbsFilter(raw: string | undefined): AbsFilter | null {
  if (!raw) return null;
  const dot = raw.indexOf('.');
  if (dot === -1) return null;
  const group = raw.slice(0, dot);
  const encoded = raw.slice(dot + 1);
  if (!group || !encoded) return null;
  try {
    const value = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!value) return null;
    return { group, value };
  } catch {
    return null;
  }
}
