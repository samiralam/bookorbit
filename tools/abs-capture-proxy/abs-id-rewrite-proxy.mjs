#!/usr/bin/env node
// Hypothesis-test proxy for ABS client debugging: presents BookOrbit's ABS ids (li_413, aut_363, …)
// to the client as UUID-shaped strings and reverse-maps them on requests. Real ABS ids are UUIDs;
// if a client (e.g. Prologue) persists items keyed by UUID(uuidString:), BookOrbit's prefixed ids
// decode fine over the wire but fail at the persistence layer — silently, with healthy traffic.
// If the client renders books through this proxy but not directly, that hypothesis is confirmed.
//
//   UPSTREAM=http://127.0.0.1:9000 PORT=9002 node abs-id-rewrite-proxy.mjs
//
// Chain through the capture proxy (:9000) so DUMP captures keep working, or point straight at the
// server. Binary responses (covers/audio) stream through untouched; Range requests work.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT ?? 9002);
const UPSTREAM = new URL(process.env.UPSTREAM ?? 'http://127.0.0.1:9000');
const upstreamPort = UPSTREAM.port ? Number(UPSTREAM.port) : UPSTREAM.protocol === 'https:' ? 443 : 80;
const agent = UPSTREAM.protocol === 'https:' ? https : http;

const ts = () => new Date().toISOString().slice(11, 23);

// prefix <-> 2-hex type code (keep in sync with server/src/modules/abs/abs-id.util.ts prefixes)
const TYPE_CODES = { usr: '01', lib: '02', li: '03', bk: '04', aut: '05', ser: '06', col: '07', pl: '08', bf: '09' };
const CODE_TO_PREFIX = Object.fromEntries(Object.entries(TYPE_CODES).map(([p, c]) => [c, p]));

function toUuid(prefix, num) {
  const hex = Number(num).toString(16).padStart(12, '0');
  return `00000000-00${TYPE_CODES[prefix]}-4000-8000-${hex}`;
}

// server-side text -> client-side text (prefix ids become uuids)
function rewriteResponseText(text) {
  return text.replace(/\b(usr|lib|li|bk|aut|ser|col|pl|bf)_(\d+)\b/g, (m, p, n) => toUuid(p, n));
}

// client-side text -> server-side text (uuids back to prefix ids)
const UUID_RE = /00000000-00([0-9a-f]{2})-4000-8000-([0-9a-f]{12})/gi;
function rewriteRequestText(text) {
  return text.replace(UUID_RE, (m, code, hex) => {
    const prefix = CODE_TO_PREFIX[code.toLowerCase()];
    if (!prefix) return m;
    return `${prefix}_${parseInt(hex, 16)}`;
  });
}

const b64 = { enc: (s) => Buffer.from(s, 'utf8').toString('base64'), dec: (s) => Buffer.from(s, 'base64').toString('utf8') };

/** Reverse-map ids inside the URL path and query (incl. base64-encoded filter values). */
function rewriteRequestUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl, 'http://x');
  } catch {
    return rewriteRequestText(rawUrl);
  }
  const pathname = rewriteRequestText(decodeURIComponent(u.pathname));
  const params = new URLSearchParams(u.search);
  for (const [k, v] of [...params.entries()]) {
    if (k === 'filter' && v.includes('.')) {
      const dot = v.indexOf('.');
      const group = v.slice(0, dot);
      try {
        const decoded = b64.dec(v.slice(dot + 1));
        const mapped = rewriteRequestText(decoded);
        if (mapped !== decoded) params.set(k, `${group}.${b64.enc(mapped)}`);
      } catch {
        /* leave as-is */
      }
    } else {
      const mapped = rewriteRequestText(v);
      if (mapped !== v) params.set(k, mapped);
    }
  }
  const qs = params.toString();
  return encodeURI(pathname) + (qs ? `?${qs}` : '');
}

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
  const targetPath = rewriteRequestUrl(req.url);
  const method = req.method;
  const isBodyText = /json/.test(req.headers['content-type'] ?? '');

  const reqChunks = [];
  req.on('data', (c) => reqChunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(reqChunks);
    if (isBodyText && body.length) body = Buffer.from(rewriteRequestText(body.toString('utf8')), 'utf8');

    const headers = { ...req.headers, host: UPSTREAM.host, 'accept-encoding': 'identity' };
    delete headers['content-length'];
    if (body.length) headers['content-length'] = String(body.length);

    const upReq = agent.request(
      { protocol: UPSTREAM.protocol, hostname: UPSTREAM.hostname, port: upstreamPort, method, path: targetPath, headers, servername: UPSTREAM.hostname },
      (upRes) => {
        const ctype = upRes.headers['content-type'] ?? '';
        const rewritable = /json|xml|mpegurl|text/i.test(ctype);
        if (!rewritable) {
          // binary (covers/audio): stream through untouched
          res.writeHead(upRes.statusCode, upRes.headers);
          upRes.pipe(res);
          return;
        }
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
          const raw = decodeBody(Buffer.concat(chunks), upRes.headers['content-encoding']);
          const out = Buffer.from(rewriteResponseText(raw.toString('utf8')), 'utf8');
          const outHeaders = { ...upRes.headers };
          delete outHeaders['content-encoding'];
          delete outHeaders['transfer-encoding'];
          outHeaders['content-length'] = String(out.length);
          console.log(`[${ts()}] ${method} ${req.url} -> ${targetPath}  ${upRes.statusCode} ${out.length}B`);
          res.writeHead(upRes.statusCode, outHeaders);
          res.end(out);
        });
      },
    );
    upReq.on('error', (e) => {
      console.log(`[${ts()}] ${method} ${req.url}  upstream error: ${e.message}`);
      res.writeHead(502).end(`id-rewrite proxy upstream error: ${e.message}`);
    });
    upReq.end(body.length ? body : undefined);
  });
});

// Transparently tunnel the Socket.IO websocket upgrade like the capture proxy does.
server.on('upgrade', (req, clientSocket, head) => {
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
  console.log(`ABS id-rewrite proxy on http://0.0.0.0:${PORT} -> ${UPSTREAM.origin}`);
  console.log('Point Prologue at http://<mac-LAN-ip>:' + PORT);
});
