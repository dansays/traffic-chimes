import puppeteer from 'puppeteer';
import { EventEmitter } from 'node:events';
import { injectScript } from './inject.js';
import { logger } from './log.js';

const log = logger('chrome');

/**
 * Owns the Chromium process and, while a session is active, the one page that
 * renders the site. Audio chunks from the page arrive via the `__chunk`
 * binding and are emitted as 'chunk' (Buffer).
 */
export class Browser extends EventEmitter {
  constructor({ chromePath, opusBitrate, throttleRaf }) {
    super();
    this.chromePath = chromePath;
    this.opusBitrate = opusBitrate;
    this.throttleRaf = throttleRaf;
    this.browser = null;
    this.page = null;
  }

  async launch() {
    if (this.browser && this.browser.connected) return this.browser;
    this.browser = await puppeteer.launch({
      headless: true,
      executablePath: this.chromePath,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--autoplay-policy=no-user-gesture-required', '--disable-gpu',
        '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--window-size=1280,900',
      ],
    });
    this.browser.on('disconnected', () => {
      if (this.closing) log.debug('browser disconnected');
      else log.warn('browser disconnected unexpectedly');
      this.browser = null;
      this.page = null;
      this.emit('gone');
    });
    log.info('launched', this.chromePath || '(bundled chrome)');
    return this.browser;
  }

  /** Open the site, wait for the camera, press Start. Resolves once Start is clicked. */
  async openPage(url, { startupTimeoutMs }) {
    await this.launch();
    await this.closePage();
    const page = await this.browser.newPage();
    this.page = page;
    page.on('console', (m) => {
      const t = m.text();
      if (t.startsWith('[tc]')) log.info(t.slice(5));
      else if (m.type() === 'error' && !/Failed to load resource/.test(t)) log.debug('console:', t);
    });
    page.on('pageerror', (e) => log.warn('pageerror:', e.message));
    page.on('error', (e) => { log.error('page crashed:', e.message); this.emit('crash'); });
    await page.exposeFunction('__chunk', (b64) => this.emit('chunk', Buffer.from(b64, 'base64')));
    await page.evaluateOnNewDocument(
      `window.__TC = ${JSON.stringify({ bitrate: this.opusBitrate, throttleRaf: this.throttleRaf })};`);
    await page.evaluateOnNewDocument(injectScript());

    log.info('opening', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: startupTimeoutMs });
    await page.waitForSelector('#start:not([hidden])', { timeout: startupTimeoutMs });
    await page.click('#start');
    log.info('start clicked');
    return page;
  }

  /** Current video clock, or null if the page is gone. Used by the stall watchdog. */
  async videoTime() {
    if (!this.page || this.page.isClosed()) return null;
    try {
      return await this.page.evaluate(() => {
        const v = document.querySelector('video');
        return v ? { t: v.currentTime, readyState: v.readyState, paused: v.paused } : null;
      });
    } catch { return null; }
  }

  async closePage() {
    const p = this.page;
    this.page = null;
    if (!p || p.isClosed()) return;
    try { await p.close({ runBeforeUnload: false }); log.info('page closed'); }
    catch (e) { log.debug('closePage', e.message); }
  }

  async close() {
    await this.closePage();
    const b = this.browser;
    this.browser = null;
    if (!b) return;
    this.closing = true;
    try { await b.close(); log.info('browser closed'); } catch (e) { log.debug('close', e.message); }
    finally { this.closing = false; }
  }
}
