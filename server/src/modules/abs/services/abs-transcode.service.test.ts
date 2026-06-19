import { mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ConfigService } from '@nestjs/config';

import type { AbsAudioFileRow } from '../abs-read.repository';
import type { AbsSocketGateway } from '../abs-socket.gateway';
import { AbsTranscodeService } from './abs-transcode.service';

function audioFile(id: number): AbsAudioFileRow {
  return { id, bookId: 3, format: 'mp3', sortOrder: id, durationSeconds: 60, sizeBytes: 1000, absolutePath: `/books/3/${id}.mp3` };
}

describe('AbsTranscodeService', () => {
  let appDataPath: string;
  let service: AbsTranscodeService;
  let emitStreamReset: ReturnType<typeof vi.fn>;
  let launchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    appDataPath = await mkdtemp(join(tmpdir(), 'abs-transcode-'));
    emitStreamReset = vi.fn();
    const config = { get: vi.fn().mockReturnValue(appDataPath) } as unknown as ConfigService;
    const socketGateway = { emitStreamReset } as unknown as AbsSocketGateway;
    service = new AbsTranscodeService(config, socketGateway);
    // Stub the real ffmpeg spawn; tests drive segment availability by writing files directly.
    launchSpy = vi.spyOn(service as unknown as { launchFfmpeg: () => void }, 'launchFfmpeg').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await rm(appDataPath, { recursive: true, force: true });
  });

  async function open(streamId: string, duration: number, startTime = 0): Promise<string> {
    return service.createStream({ streamId, userId: 1, audioFiles: [audioFile(10), audioFile(11)], duration, startTime });
  }

  function segPath(streamId: string, n: number): string {
    return join(appDataPath, 'abs', 'streams', streamId, `output-${n}.ts`);
  }

  it('creates a stream, writes a concat list + playlist, and returns the HLS url', async () => {
    const url = await open('s1', 60);
    expect(url).toBe('/hls/s1/output.m3u8');
    expect(launchSpy).toHaveBeenCalledOnce();
    const files = await readdir(join(appDataPath, 'abs', 'streams', 's1'));
    expect(files).toContain('concat.txt');
    expect(files).toContain('output.m3u8');
  });

  it('serves the playlist for an open stream and null for an unknown one', async () => {
    await open('s1', 60);
    expect(service.playlist('s1')).toContain('#EXT-X-ENDLIST');
    expect(service.playlist('missing')).toBeNull();
  });

  it('serves a segment that exists on disk', async () => {
    await open('s1', 60);
    await writeFile(segPath('s1', 0), 'ts-bytes');
    const result = await service.resolveSegment('s1', 'output-0.ts');
    expect(result.action).toBe('serve');
    expect(result.filePath).toBe(segPath('s1', 0));
  });

  it('waits for a not-yet-produced segment within the window', async () => {
    await open('s1', 600);
    const result = await service.resolveSegment('s1', 'output-1.ts');
    expect(result.action).toBe('wait');
    expect(emitStreamReset).not.toHaveBeenCalled();
  });

  it('resets ffmpeg and emits stream_reset on a forward seek beyond the window', async () => {
    await open('s1', 600); // 100 segments
    const result = await service.resolveSegment('s1', 'output-80.ts');
    expect(result.action).toBe('reset');
    expect(launchSpy).toHaveBeenCalledTimes(2); // initial + reset
    expect(emitStreamReset).toHaveBeenCalledWith(1, { streamId: 's1', startTime: 80 * 6 });
  });

  it('404s a segment outside the title and unknown streams', async () => {
    await open('s1', 60); // 10 segments
    expect((await service.resolveSegment('s1', 'output-99.ts')).action).toBe('not-found');
    expect((await service.resolveSegment('missing', 'output-0.ts')).action).toBe('not-found');
  });

  it('closeStream removes the stream dir and forgets the stream', async () => {
    await open('s1', 60);
    await service.closeStream('s1');
    expect(service.hasStream('s1')).toBe(false);
    expect(service.playlist('s1')).toBeNull();
    await expect(readdir(join(appDataPath, 'abs', 'streams', 's1'))).rejects.toThrow();
  });
});
