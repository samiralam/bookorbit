import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { AbsTranscodeService } from '../services/abs-transcode.service';
import { makeReply, thrownStatus } from '../__testing__/abs-test-helpers';
import { AbsHlsController } from './abs-hls.controller';

function build(overrides: Partial<AbsTranscodeService> = {}) {
  const transcodeService = {
    playlist: vi.fn().mockReturnValue('#EXTM3U\n#EXT-X-ENDLIST\n'),
    resolveSegment: vi.fn().mockResolvedValue({ action: 'not-found' }),
    ...overrides,
  } as unknown as AbsTranscodeService;
  return { controller: new AbsHlsController(transcodeService), transcodeService };
}

describe('AbsHlsController#streamFile', () => {
  it('400s a filename outside the allowed HLS shapes (blocks traversal)', async () => {
    const { controller } = build();
    const { reply } = makeReply();
    expect(await thrownStatus(() => controller.streamFile('s1', '../etc/passwd', reply))).toBe(400);
  });

  it('serves the playlist with the HLS content type', async () => {
    const { controller } = build();
    const { reply, captured } = makeReply();
    await controller.streamFile('s1', 'output.m3u8', reply);
    expect(captured.statusCode).toBe(200);
    expect(captured.headers['Content-Type']).toBe('application/vnd.apple.mpegurl');
    expect(captured.body).toContain('#EXT-X-ENDLIST');
  });

  it('404s the playlist for an unknown stream', async () => {
    const { controller } = build({ playlist: vi.fn().mockReturnValue(null) });
    const { reply } = makeReply();
    expect(await thrownStatus(() => controller.streamFile('missing', 'output.m3u8', reply))).toBe(404);
  });

  it('serves a ready segment as video/mp2t', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'abs-hls-'));
    const filePath = join(dir, 'output-0.ts');
    await writeFile(filePath, 'ts');
    const { controller } = build({ resolveSegment: vi.fn().mockResolvedValue({ action: 'serve', filePath }) });
    const { reply, captured } = makeReply();
    await controller.streamFile('s1', 'output-0.ts', reply);
    expect(captured.statusCode).toBe(200);
    expect(captured.headers['Content-Type']).toBe('video/mp2t');
    await rm(dir, { recursive: true, force: true });
  });

  it('404s a segment that is waiting, resetting, or missing', async () => {
    for (const action of ['wait', 'reset', 'not-found']) {
      const { controller } = build({ resolveSegment: vi.fn().mockResolvedValue({ action }) });
      const { reply } = makeReply();
      expect(await thrownStatus(() => controller.streamFile('s1', 'output-9.ts', reply))).toBe(404);
    }
  });
});
