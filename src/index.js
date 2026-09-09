import { config, pageUrl, bitrateBps } from './config.js';
import { Broadcaster } from './broadcaster.js';
import { Silence } from './silence.js';
import { Encoder } from './encoder.js';
import { Browser } from './browser.js';
import { Session } from './session.js';
import { createServer } from './server.js';
import { logger } from './log.js';

const log = logger('main');
const url = pageUrl();
const bps = bitrateBps();

const broadcaster = new Broadcaster({ ringBytes: Math.round((bps / 8) * config.ringSeconds) });
const silence = new Silence({ ffmpegPath: config.ffmpegPath, bitrate: config.bitrate, seconds: 1 });
const encoder = new Encoder({ ffmpegPath: config.ffmpegPath, bitrate: config.bitrate });
const browser = new Browser({ chromePath: config.chromePath, opusBitrate: config.opusBitrate, throttleRaf: config.throttleRaf });
const session = new Session({ browser, encoder, silence, broadcaster, config, pageUrl: url });
const server = createServer({ broadcaster, session, config, bitrateKbps: Math.round(bps / 1000), pageUrl: url });

await silence.prepare();
if (!config.killBrowserWhenIdle) {
  // Warm the browser so the first listener only pays for the page, not Chromium.
  browser.launch().catch((e) => log.warn('browser prelaunch failed:', e.message));
}
await server.listen();
log.info(`page ${url}`);
log.info(`instruments ${config.instruments.join(',')} · mp3 ${config.bitrate} · idle grace ${config.idleSeconds}s`);

let stopping = false;
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  log.info(`${sig}: shutting down`);
  const t = setTimeout(() => process.exit(1), 10_000);
  try { await server.close(); await session.shutdown(); } catch (e) { log.error(e.message); }
  clearTimeout(t);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log.error('unhandled rejection:', e && e.stack || e));
