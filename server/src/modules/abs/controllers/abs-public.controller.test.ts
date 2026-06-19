import type { AbsAudioFileRow } from '../abs-read.repository';
import type { AbsPlaybackService } from '../services/abs-playback.service';
import type { AbsStreamService } from '../services/abs-stream.service';
import { makeReply, makeRequest, thrownStatus } from '../__testing__/abs-test-helpers';
import { AbsPublicController } from './abs-public.controller';

const FILE: AbsAudioFileRow = {
  id: 10,
  bookId: 3,
  format: 'mp3',
  sortOrder: 0,
  durationSeconds: 100,
  sizeBytes: 1000,
  absolutePath: '/books/3/10.mp3',
};

function build(trackFile: AbsAudioFileRow | null) {
  const playbackService = { trackFile: vi.fn().mockReturnValue(trackFile) } as unknown as AbsPlaybackService;
  const streamService = { streamFile: vi.fn().mockResolvedValue(undefined) } as unknown as AbsStreamService;
  return { controller: new AbsPublicController(playbackService, streamService), playbackService, streamService };
}

describe('AbsPublicController#track', () => {
  it('404s on a non-numeric track index', async () => {
    const { controller } = build(FILE);
    const { reply } = makeReply();
    expect(await thrownStatus(() => controller.track('sess-1', 'abc', makeRequest(), reply))).toBe(404);
  });

  it('404s on a negative track index', async () => {
    const { controller } = build(FILE);
    const { reply } = makeReply();
    expect(await thrownStatus(() => controller.track('sess-1', '-1', makeRequest(), reply))).toBe(404);
  });

  it('404s when the session/track cannot be resolved', async () => {
    const { controller } = build(null);
    const { reply } = makeReply();
    expect(await thrownStatus(() => controller.track('sess-1', '0', makeRequest(), reply))).toBe(404);
  });

  it('streams the resolved track file with range support', async () => {
    const { controller, streamService } = build(FILE);
    const { reply } = makeReply();
    const req = makeRequest({ headers: { range: 'bytes=0-100' } });
    await controller.track('sess-1', '0', req, reply);
    expect(streamService.streamFile).toHaveBeenCalledWith(req, reply, FILE.absolutePath, FILE.format);
  });
});
