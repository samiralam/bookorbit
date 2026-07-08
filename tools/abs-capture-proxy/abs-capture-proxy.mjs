#!/usr/bin/env node
// ABS traffic-capture proxy for debugging external Audiobookshelf clients (Prologue, Still, …).
// Point the client's server URL at this proxy (http://<your-LAN-ip>:9000) and it forwards every
// request — plus the Socket.IO websocket upgrade — to the upstream, logging exactly what the
// client sends/receives. See ./README.md for details.
//
//   UPSTREAM=http://localhost:3000 pnpm abs:capture                    # from the repo root
//   node ./tools/abs-capture-proxy/abs-capture-proxy.mjs --upstream=https://my-server.example
//
// The upstream target is REQUIRED (no default) — set the UPSTREAM env var or pass --upstream=<url>.
//
// Env knobs:
//   UPSTREAM=<url>  (required)         target server to forward to (or --upstream=<url> flag)
//   PORT=9000                          listen port
//   DUMP=1                             also write each response body to ./abs-capture/ (cwd)

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT ?? 9000);

/** Resolve the (required) upstream target from UPSTREAM, a --upstream=<url> flag, or a bare arg. */
function resolveUpstream() {
  const args = process.argv.slice(2);
  const flag = args.find((a) => a.startsWith('--upstream='));
  const positional = args.find((a) => !a.startsWith('-'));
  const raw = process.env.UPSTREAM ?? (flag ? flag.slice('--upstream='.length) : positional);
  if (!raw) {
    console.error(
      'Error: no upstream server specified. The target is required (no default).\n\n' +
        'Set the UPSTREAM env var or pass --upstream=<url>, e.g.\n' +
        '  UPSTREAM=http://localhost:3000 pnpm abs:capture\n' +
        '  node ./tools/abs-capture-proxy/abs-capture-proxy.mjs --upstream=https://my-server.example',
    );
    process.exit(1);
  }
  try {
    return new URL(raw);
  } catch {
    console.error(`Error: invalid upstream URL: ${raw}`);
    process.exit(1);
  }
}

const UPSTREAM = resolveUpstream();
const DUMP = process.env.DUMP === '1';
const upstreamPort = UPSTREAM.port ? Number(UPSTREAM.port) : UPSTREAM.protocol === 'https:' ? 443 : 80;
const agent = UPSTREAM.protocol === 'https:' ? https : http;

if (DUMP) fs.mkdirSync(path.join(process.cwd(), 'abs-capture'), { recursive: true });

let seq = 0;
const ts = () => new Date().toISOString().slice(11, 23);
const shortAuth = (h) => (!h ? '-' : /^Bearer /.test(h) ? `Bearer …${h.slice(-6)}` : h.slice(0, 12));

function decodeBody(buf, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buf);
    if (encoding === 'br') return zlib.brotliDecompressSync(buf);
    if (encoding === 'deflate') return zlib.inflateSync(buf);
  } catch {
    return buf;
  }
  return buf;
}

const server = http.createServer((req, res) => {
  const id = ++seq;
  const started = Date.now();
  const headers = { ...req.headers, host: UPSTREAM.host };

  const upReq = agent.request(
    {
      protocol: UPSTREAM.protocol,
      hostname: UPSTREAM.hostname,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers,
      servername: UPSTREAM.hostname,
    },
    (upRes) => {
      const ctype = upRes.headers['content-type'] ?? '';
      // Media/binary bodies (covers, audiobook range streams) pass through unbuffered — buffering a
      // 300MB+ range response delays the first byte by seconds and stalls AVPlayer playback.
      if (!/json|xml|text|mpegurl/i.test(ctype)) {
        console.log(
          `[${ts()}] #${id} ${req.method} ${req.url}\n` +
            `        ← ${upRes.statusCode} ${ctype} (streamed) range=${req.headers['range'] ?? '-'} len=${upRes.headers['content-length'] ?? '?'}`,
        );
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        return;
      }
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        const raw = Buffer.concat(chunks);
        const enc = upRes.headers['content-encoding'];
        const ms = Date.now() - started;
        const ctype = upRes.headers['content-type'] ?? '';
        console.log(
          `[${ts()}] #${id} ${req.method} ${req.url}\n` +
            `        ← ${upRes.statusCode} ${ctype} ${enc ? `(${enc}) ` : ''}${raw.length}B ${ms}ms\n` +
            `        UA=${req.headers['user-agent'] ?? '-'} AE=${req.headers['accept-encoding'] ?? '-'} Auth=${shortAuth(req.headers.authorization)}`,
        );
        // Flag suspicious bodies: a non-2xx, or a JSON error envelope that isn't ABS-shaped.
        if (upRes.statusCode >= 400) {
          const body = decodeBody(raw, enc).toString('utf8').slice(0, 300);
          if (body) console.log(`        ⚠ body: ${body}`);
        }
        if (DUMP && /json/.test(ctype)) {
          const safe = req.url.replace(/[^a-z0-9]+/gi, '_').slice(0, 80);
          fs.writeFileSync(path.join('abs-capture', `${String(id).padStart(4, '0')}_${req.method}_${safe}.json`), decodeBody(raw, enc));
        }
        res.writeHead(upRes.statusCode, upRes.headers);
        res.end(raw);
      });
    },
  );
  upReq.on('error', (e) => {
    console.log(`[${ts()}] #${id} ${req.method} ${req.url}  ✖ upstream error: ${e.message}`);
    if (!res.headersSent) res.writeHead(502).end(`proxy upstream error: ${e.message}`);
  });
  // AVPlayer opens/cancels range requests aggressively; stop pulling from upstream when it hangs up.
  res.on('close', () => {
    if (!res.writableEnded) upReq.destroy();
  });
  req.pipe(upReq);
});

// Transparently tunnel the Socket.IO websocket upgrade so Prologue's realtime works.
server.on('upgrade', (req, clientSocket, head) => {
  console.log(`[${ts()}] WS upgrade ${req.url}`);
  const isTls = UPSTREAM.protocol === 'https:';
  const upSocket = isTls
    ? tls.connect({ host: UPSTREAM.hostname, port: upstreamPort, servername: UPSTREAM.hostname, rejectUnauthorized: false })
    : net.connect({ host: UPSTREAM.hostname, port: upstreamPort });
  upSocket.on(isTls ? 'secureConnect' : 'connect', () => {
    const reqLines = [`${req.method} ${req.url} HTTP/1.1`, `Host: ${UPSTREAM.host}`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === 'host') continue;
      reqLines.push(`${k}: ${v}`);
    }
    upSocket.write(reqLines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upSocket.write(head);
    upSocket.pipe(clientSocket);
    clientSocket.pipe(upSocket);
  });
  upSocket.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => upSocket.destroy());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ABS capture proxy on http://0.0.0.0:${PORT}  ->  ${UPSTREAM.origin}`);
  console.log('Point Prologue at  http://<your-mac-LAN-ip>:' + PORT + (DUMP ? '   (DUMP on -> ./abs-capture/)' : ''));
});
