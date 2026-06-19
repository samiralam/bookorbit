# abs-capture-proxy

Standalone developer/debugging utility. Not part of the build — run directly with `node` (or via the
`pnpm abs:capture` script).

A zero-dependency logging reverse proxy for debugging external Audiobookshelf (ABS) clients
(Prologue, Still, etc.) against a BookOrbit server. It forwards every HTTP request — and the
Socket.IO websocket upgrade — to a target server and logs exactly what the client sends and
receives, so you can see the real request flow a client uses (paths, query params, headers, status
codes, body sizes) rather than guessing.

Originally built to diagnose Prologue showing empty libraries (it browses via
`GET /api/libraries/:id/authors`, not `/items`).

### Usage

The upstream target is **required** — set the `UPSTREAM` env var or pass `--upstream=<url>`:

```bash
UPSTREAM=http://localhost:3000 pnpm abs:capture                            # from the repo root
# or:
node ./tools/abs-capture-proxy/abs-capture-proxy.mjs --upstream=https://my-server.example
```

Then point the client's server URL at `http://<your-machine-LAN-ip>:9000` (same network; the device
must be able to reach your machine — check the OS firewall). The proxy forwards to the upstream and
logs each exchange.

### Env knobs / flags

| Var / flag                 | Default      | Purpose                                                                            |
| -------------------------- | ------------ | ---------------------------------------------------------------------------------- |
| `UPSTREAM` / `--upstream=` | _(required)_ | Target server to forward to (no default; the proxy exits if unset)                 |
| `PORT`                     | `9000`       | Listen port                                                                        |
| `DUMP`                     | _(off)_      | `DUMP=1` also writes each JSON response body to `./abs-capture/` (gzip/br decoded) |

Example against a local dev server with body dumps:

```bash
UPSTREAM=http://localhost:3000 PORT=9000 DUMP=1 pnpm abs:capture
```

### Notes

- Read-only forwarding — it does not modify requests or responses, only observes.
- For 4xx/5xx responses it prints a snippet of the body to surface error envelopes.
- TLS upstreams are connected with `rejectUnauthorized: false` so self-signed/proxy certs work.
