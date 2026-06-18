/**
 * The ABS server identity reported to clients. Clients gate feature availability on
 * `serverVersion`, so we advertise the ABS version this adapter is built against
 * (see docs/abs-api). `app` must be the literal "audiobookshelf" the clients expect.
 */
export const ABS_APP_NAME = 'audiobookshelf';
export const ABS_SERVER_VERSION = '2.35.1';
export const ABS_SOURCE = 'bookorbit';
export const ABS_DEFAULT_LANGUAGE = 'en-us';

/** BookOrbit has no podcasts; every ABS library/item is reported as a book. */
export const ABS_MEDIA_TYPE_BOOK = 'book';
