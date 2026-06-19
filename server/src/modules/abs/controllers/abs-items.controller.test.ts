import { ConfigService } from '@nestjs/config';
import { tmpdir } from 'os';

import type { AbsCatalogService } from '../services/abs-catalog.service';
import type { AbsPlaybackService } from '../services/abs-playback.service';
import { makeAbsUser, makeReply, makeRequest, thrownStatus } from '../__testing__/abs-test-helpers';
import { AbsItemsController } from './abs-items.controller';

function build() {
  const catalogService = { getLibraryItem: vi.fn().mockResolvedValue({ id: 'li_3' }) } as unknown as AbsCatalogService;
  const playbackService = { startSession: vi.fn().mockResolvedValue({ id: 'sess-1', playMethod: 0 }) } as unknown as AbsPlaybackService;
  const config = { get: () => tmpdir() } as unknown as ConfigService;
  return { controller: new AbsItemsController(catalogService, playbackService, config), catalogService, playbackService };
}

describe('AbsItemsController#getItem', () => {
  it('404s on a malformed item id', async () => {
    const { controller } = build();
    expect(await thrownStatus(() => controller.getItem(makeAbsUser(), 'nope', {}))).toBe(404);
  });

  it('delegates to the catalog service, passing minified through', async () => {
    const { controller, catalogService } = build();
    await controller.getItem(makeAbsUser(), 'li_3', { minified: '1' });
    expect(catalogService.getLibraryItem).toHaveBeenCalledWith(expect.anything(), 3, true);
  });
});

describe('AbsItemsController#play', () => {
  it('404s on a malformed item id', async () => {
    const { controller } = build();
    expect(await thrownStatus(() => controller.play(makeAbsUser(), 'nope', {}))).toBe(404);
  });

  it('starts a playback session for a valid item', async () => {
    const { controller, playbackService } = build();
    const body = { supportedMimeTypes: ['audio/mpeg'] };
    const session = await controller.play(makeAbsUser(), 'li_3', body);
    expect(playbackService.startSession).toHaveBeenCalledWith(expect.anything(), 3, body);
    expect(session).toMatchObject({ id: 'sess-1' });
  });
});

describe('AbsItemsController#cover', () => {
  it('404s on a malformed item id', async () => {
    const { controller } = build();
    const { reply } = makeReply();
    expect(await thrownStatus(() => controller.cover('nope', makeRequest(), reply))).toBe(404);
  });

  it('404s when no cover file exists for the item', async () => {
    const { controller } = build();
    const { reply } = makeReply();
    // appDataPath points at an empty tmp dir, so the cover directory does not exist -> 404.
    expect(await thrownStatus(() => controller.cover('li_999999', makeRequest(), reply))).toBe(404);
  });
});
