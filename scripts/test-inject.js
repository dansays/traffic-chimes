// Unit-ish test for the injected page guards, run against about:blank in headless Chrome.
//   node scripts/test-inject.js
import puppeteer from 'puppeteer';
import { injectScript } from '../src/inject.js';

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(m.text()));
await page.evaluateOnNewDocument('window.__TC = { throttleRaf: true }');
await page.evaluateOnNewDocument(injectScript());
await page.goto('about:blank');

const r = await page.evaluate(async () => {
  const out = {};
  // 1. negative arc radius must not throw
  const ctx = document.createElement('canvas').getContext('2d');
  try { ctx.arc(10, 10, -3.2, 0, Math.PI * 2); out.arcNegativeOk = true; } catch (e) { out.arcNegativeOk = e.message; }
  // 2. a self-rearming rAF loop that throws once must keep running
  let n = 0;
  function loop() { n++; if (n === 3) throw new Error('boom'); requestAnimationFrame(loop); }
  requestAnimationFrame(loop);
  await new Promise((res) => setTimeout(res, 1500));
  out.loopIterations = n;
  // 3. AudioContext tap + note counter
  const ac = new AudioContext();
  ac.destination; // triggers tap + recorder
  ac.createOscillator();
  out.notes = window.__tcNotes;
  out.destinationIsTap = ac.destination instanceof MediaStreamAudioDestinationNode;
  return out;
});
await browser.close();

const pass = r.arcNegativeOk === true && r.loopIterations > 10 && r.notes === 1 && r.destinationIsTap;
console.log(JSON.stringify(r), '\nlogs:', logs.filter((l) => l.startsWith('[tc]')).join(' | '));
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
