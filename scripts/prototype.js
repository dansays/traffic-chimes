// Diagnostic: open the page headless, capture ~45 s of audio, transcode to MP3, report.
// Use it to confirm headless Web Audio capture works on a new machine: `npm run prototype`.
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { injectScript } from '../src/inject.js';

const SECONDS = Number(process.env.SECONDS || 45);
const OUT = process.env.OUT || 'proto.mp3';
const INSTRUMENTS = process.env.INSTRUMENTS || 'theremin,glass,marimba';
const URL = `https://the-101-plays-itself.netlify.app/#${INSTRUMENTS}`;

const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-y',
  '-f', 'webm', '-i', 'pipe:0', '-vn', '-ac', '2', '-ar', '44100',
  '-c:a', 'libmp3lame', '-b:a', '128k', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
         '--disable-gpu', '--window-size=1280,900'],
});
const page = await browser.newPage();
let chunks = 0, bytes = 0, first = null;
await page.exposeFunction('__chunk', (b64) => {
  const buf = Buffer.from(b64, 'base64');
  chunks++; bytes += buf.length;
  if (!first) { first = Date.now(); console.log('first chunk after', ((first - t0) / 1000).toFixed(1), 's'); }
  ff.stdin.write(buf);
});
page.on('console', (m) => { const t = m.text(); if (t.startsWith('[tc]') || m.type() === 'error') console.log('page>', t); });
page.on('pageerror', (e) => console.log('pageerror>', e.message));
await page.evaluateOnNewDocument(`window.__TC = ${JSON.stringify({ throttleRaf: true })};`);
await page.evaluateOnNewDocument(injectScript());

const t0 = Date.now();
await page.goto(URL, { waitUntil: 'domcontentloaded' });
console.log('loaded, waiting for Start button');
await page.waitForSelector('#start:not([hidden])', { timeout: 90_000 });
console.log('camera live after', ((Date.now() - t0) / 1000).toFixed(1), 's; clicking Start');
await page.click('#start');

const timer = setInterval(async () => {
  const info = await page.evaluate(() => {
    const v = document.querySelector('video');
    return { vt: v && v.currentTime.toFixed(1), rs: v && v.readyState, paused: v && v.paused,
             status: (document.getElementById('status') || {}).textContent };
  }).catch(() => ({}));
  console.log(`t=${((Date.now() - t0) / 1000).toFixed(0)}s chunks=${chunks} bytes=${bytes} video=${JSON.stringify(info)}`);
}, 5000);

await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(timer);
const captureSecs = first ? (Date.now() - first) / 1000 : 0;
console.log(`done: ${chunks} chunks, ${bytes} bytes over ${captureSecs.toFixed(1)} s of capture (${(bytes * 8 / captureSecs / 1000).toFixed(0)} kbps)`);
await browser.close();
ff.stdin.end();
await new Promise((r) => ff.on('close', r));
