import { existsSync } from 'node:fs';

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const num = (k, d) => Number(env(k, d));
const bool = (k, d) => ['1', 'true', 'yes', 'on'].includes(String(env(k, d)).toLowerCase());

function detectChrome() {
  const fromEnv = env('CHROME_PATH', '');
  if (fromEnv) return fromEnv;
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (existsSync(p)) return p;
  }
  return undefined; // fall back to Puppeteer's bundled Chrome
}

const instruments = env('INSTRUMENTS', 'theremin,glass,marimba')
  .split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  port: num('PORT', 8000),
  host: env('HOST', '0.0.0.0'),
  instruments,
  bitrate: env('BITRATE', '128k'),          // MP3 output bitrate
  opusBitrate: num('OPUS_BITRATE', 192000), // in-browser capture bitrate
  pageUrl: env('PAGE_URL', 'https://the-101-plays-itself.netlify.app/'),
  streamUrl: env('STREAM_URL', ''),         // optional camera override (page supports ?stream=)
  stallSeconds: num('STALL_SECONDS', 30),   // no audio chunks for this long -> recycle page
  videoStallSeconds: num('VIDEO_STALL_SECONDS', 120), // video clock frozen this long -> recycle page
  noteStallSeconds: num('NOTE_STALL_SECONDS', 300),   // video playing but no notes this long -> recycle (0 = off)
  startupTimeoutSeconds: num('STARTUP_TIMEOUT_SECONDS', 90),
  idleSeconds: num('IDLE_SECONDS', 60),     // grace period after the last listener leaves
  killBrowserWhenIdle: bool('KILL_BROWSER_WHEN_IDLE', false),
  reloadHours: num('RELOAD_HOURS', 24),     // periodic page reload while live (0 = never)
  throttleRaf: bool('THROTTLE_RAF', true),
  chromePath: detectChrome(),
  ffmpegPath: env('FFMPEG_PATH', 'ffmpeg'),
  streamName: env('STREAM_NAME', 'The 101 Plays Itself'),
  ringSeconds: num('RING_SECONDS', 2),      // MP3 kept for late joiners
};

export function pageUrl() {
  const u = new URL(config.pageUrl);
  if (config.streamUrl) u.searchParams.set('stream', config.streamUrl);
  u.hash = config.instruments.join(',');
  return u.toString();
}

export function bitrateBps() {
  const m = /^(\d+)(k?)$/i.exec(config.bitrate);
  if (!m) return 128000;
  return Number(m[1]) * (m[2] ? 1000 : 1);
}
