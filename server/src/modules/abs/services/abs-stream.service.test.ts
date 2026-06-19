import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { makeReply, makeRequest } from '../__testing__/abs-test-helpers';
import { AbsStreamService } from './abs-stream.service';

describe('AbsStreamService#streamFile', () => {
  let dir: string;
  let filePath: string;
  const CONTENT = 'abcdefghij'; // 10 bytes
  const service = new AbsStreamService();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'abs-stream-'));
    filePath = join(dir, 'track.mp3');
    await writeFile(filePath, CONTENT);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('404s when the file does not exist', async () => {
    const { reply, captured } = makeReply();
    await service.streamFile(makeRequest(), reply, join(dir, 'missing.mp3'), 'mp3');
    expect(captured.statusCode).toBe(404);
  });

  it('serves the whole file as 200 with Content-Length and audio mime type', async () => {
    const { reply, captured } = makeReply();
    await service.streamFile(makeRequest(), reply, filePath, 'mp3');
    expect(captured.statusCode).toBe(200);
    expect(captured.headers['Content-Length']).toBe(10);
    expect(captured.headers['Content-Type']).toBe('audio/mpeg');
    expect(captured.headers['Accept-Ranges']).toBe('bytes');
  });

  it('honors a byte range with a 206 + Content-Range', async () => {
    const { reply, captured } = makeReply();
    await service.streamFile(makeRequest({ headers: { range: 'bytes=2-5' } }), reply, filePath, 'mp3');
    expect(captured.statusCode).toBe(206);
    expect(captured.headers['Content-Range']).toBe('bytes 2-5/10');
    expect(captured.headers['Content-Length']).toBe(4); // bytes 2,3,4,5
  });

  it('honors an open-ended range (bytes=5-)', async () => {
    const { reply, captured } = makeReply();
    await service.streamFile(makeRequest({ headers: { range: 'bytes=5-' } }), reply, filePath, 'mp3');
    expect(captured.statusCode).toBe(206);
    expect(captured.headers['Content-Range']).toBe('bytes 5-9/10');
  });

  it('honors a suffix range (last N bytes)', async () => {
    const { reply, captured } = makeReply();
    await service.streamFile(makeRequest({ headers: { range: 'bytes=-3' } }), reply, filePath, 'mp3');
    expect(captured.statusCode).toBe(206);
    expect(captured.headers['Content-Range']).toBe('bytes 7-9/10');
  });

  it('returns 416 for an unsatisfiable range', async () => {
    const { reply, captured } = makeReply();
    await service.streamFile(makeRequest({ headers: { range: 'bytes=50-60' } }), reply, filePath, 'mp3');
    expect(captured.statusCode).toBe(416);
    expect(captured.headers['Content-Range']).toBe('bytes */10');
  });
});
