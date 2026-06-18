import { Injectable } from '@nestjs/common';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { audioMimeType } from '../abs-media.util';

/**
 * Streams an audio file with real HTTP Range (206) support so ABS clients can seek during
 * direct play. BookOrbit's existing download handler only declares `Accept-Ranges` without
 * honoring ranges, so this is built fresh (REIMPLEMENTATION_GUIDE §5.4).
 */
@Injectable()
export class AbsStreamService {
  async streamFile(req: FastifyRequest, reply: FastifyReply, absolutePath: string, format: string | null): Promise<void> {
    let size: number;
    try {
      size = (await stat(absolutePath)).size;
    } catch {
      reply.status(404).send();
      return;
    }

    const contentType = audioMimeType(format);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', contentType);

    const range = this.parseRange(req.headers['range'], size);
    if (!range) {
      reply.header('Content-Length', size);
      reply.status(200).send(createReadStream(absolutePath));
      return;
    }

    if (range === 'unsatisfiable') {
      reply.header('Content-Range', `bytes */${size}`);
      reply.status(416).send();
      return;
    }

    const { start, end } = range;
    reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
    reply.header('Content-Length', end - start + 1);
    reply.status(206).send(createReadStream(absolutePath, { start, end }));
  }

  /** Parse a single-range `bytes=start-end` header. Returns null for no range. */
  private parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
    if (!header || !header.startsWith('bytes=')) return null;
    const spec = header.slice('bytes='.length).split(',')[0]?.trim();
    if (!spec) return null;

    const [startRaw, endRaw] = spec.split('-');
    let start: number;
    let end: number;
    if (startRaw === '') {
      // Suffix range: last N bytes.
      const suffix = Number.parseInt(endRaw, 10);
      if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number.parseInt(startRaw, 10);
      end = endRaw === '' || endRaw === undefined ? size - 1 : Number.parseInt(endRaw, 10);
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'unsatisfiable';
    return { start, end: Math.min(end, size - 1) };
  }
}
