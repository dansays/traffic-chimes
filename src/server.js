import http from 'node:http';
import { logger } from './log.js';
import { State } from './session.js';

const log = logger('http');

export function createServer({ broadcaster, session, config, bitrateKbps, pageUrl }) {
  const bootAt = Date.now();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`;

    if (path === '/stream.mp3' || path === '/stream' || path === '/listen') {
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'icy-name': config.streamName,
        'icy-description': `Caltrans camera on the US-101 played as ${config.instruments.join(', ')}`,
        'icy-genre': 'Generative',
        'icy-url': config.pageUrl,
        'icy-br': String(bitrateKbps),
        'icy-pub': '0',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      req.socket.setNoDelay(true);
      req.socket.setTimeout(0);
      broadcaster.addClient(res, peer);
      return;
    }

    if (path === '/health') {
      const s = session.stats();
      const ok = s.state === State.IDLE
        || (s.state === State.LIVE && s.lastMp3AgeMs < config.stallSeconds * 1000)
        || s.state === State.STARTING || s.state === State.DRAINING;
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok, ...s, uptimeS: Math.round((Date.now() - bootAt) / 1000),
        instruments: config.instruments, bitrate: config.bitrate, page: pageUrl }, null, 2));
      return;
    }

    if (path === '/') {
      const s = session.stats();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><meta charset="utf-8"><title>${esc(config.streamName)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#cdd3d1;background:#0b1115}
a{color:#e4a244}code{background:#182229;padding:.1em .4em;border-radius:3px}small{color:#78858e}</style>
<h1>${esc(config.streamName)}</h1>
<p>Live MP3 of <a href="${esc(pageUrl)}">the-101-plays-itself</a>, instruments: <code>${esc(config.instruments.join(', '))}</code>.</p>
<p><audio controls preload="none" src="/stream.mp3"></audio></p>
<p>Stream URL: <code>${esc(`http://${req.headers.host}/stream.mp3`)}</code></p>
<p><small>State: ${esc(s.state)} · listeners: ${s.listeners} · <a href="/health">health</a>. The camera is only pulled while someone is listening.</small></p>`);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
  });

  server.keepAliveTimeout = 0;
  server.headersTimeout = 60_000;
  server.requestTimeout = 0;

  return {
    listen: () => new Promise((resolve) => server.listen(config.port, config.host, () => {
      log.info(`listening on http://${config.host}:${config.port}/stream.mp3`);
      resolve();
    })),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
