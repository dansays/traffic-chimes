import { EventEmitter } from 'node:events';
import { logger } from './log.js';

const log = logger('session');

export const State = Object.freeze({
  IDLE: 'idle', STARTING: 'starting', LIVE: 'live', DRAINING: 'draining',
});

/**
 * Drives the on-demand lifecycle from the listener count:
 *
 *   IDLE -> STARTING (first listener) -> LIVE (first MP3 bytes)
 *   LIVE -> DRAINING (last listener leaves) -> IDLE after idleSeconds
 *   DRAINING -> LIVE if someone comes back within the grace period
 *
 * Also runs the watchdog that recycles the page + encoder when audio stops or
 * the video clock freezes, with exponential backoff on repeated failures.
 */
export class Session extends EventEmitter {
  constructor({ browser, encoder, silence, broadcaster, config, pageUrl }) {
    super();
    this.browser = browser;
    this.encoder = encoder;
    this.silence = silence;
    this.cast = broadcaster;
    this.cfg = config;
    this.pageUrl = pageUrl;

    this.state = State.IDLE;
    this.lastChunkAt = 0;
    this.lastMp3At = 0;
    this.startedAt = 0;
    this.restarts = 0;
    this.failures = 0;
    this.idleTimer = null;
    this.watchdog = null;
    this.reloadTimer = null;
    this.lastVideo = { t: -1, at: 0 };
    this.lastNotes = { n: -1, at: 0 };
    this.recycling = false;
    this.probe = null;
    this.stopping = false; // set while stop()/shutdown() tear things down on purpose
    this.op = Promise.resolve(); // serialises start/stop/recycle

    browser.on('chunk', (buf) => {
      this.lastChunkAt = Date.now();
      this.encoder.write(buf);
    });
    browser.on('crash', () => { if (!this.stopping) this.queue(() => this.recycle('page crashed')); });
    browser.on('gone', () => {
      if (!this.stopping && this.state !== State.IDLE) this.queue(() => this.recycle('browser gone'));
    });
    encoder.on('data', (buf) => this.onMp3(buf));
    encoder.on('exit', () => {
      if (this.stopping) return;
      if (this.state === State.STARTING || this.state === State.LIVE || this.state === State.DRAINING) {
        this.queue(() => this.recycle('encoder exited'));
      }
    });
    broadcaster.on('listeners', (n) => this.onListeners(n));
  }

  queue(fn) {
    this.op = this.op.then(fn, fn).catch((e) => log.error('op failed:', e.message));
    return this.op;
  }

  setState(s) {
    if (s === this.state) return;
    log.info(`${this.state} -> ${s}`);
    this.state = s;
    this.emit('state', s);
  }

  onListeners(n) {
    if (n > 0) {
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
      if (this.state === State.IDLE) this.queue(() => this.start());
      else if (this.state === State.DRAINING) this.setState(this.lastMp3At ? State.LIVE : State.STARTING);
    } else if (this.state === State.STARTING || this.state === State.LIVE) {
      this.setState(State.DRAINING);
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.cast.listeners === 0) this.queue(() => this.stop());
      }, this.cfg.idleSeconds * 1000);
    }
  }

  onMp3(buf) {
    const first = !this.lastMp3At;
    this.lastMp3At = Date.now();
    if (first) {
      this.silence.stop();
      this.failures = 0;
      log.info(`first audio after ${((Date.now() - this.startedAt) / 1000).toFixed(1)}s`);
      if (this.state === State.STARTING) this.setState(State.LIVE);
    }
    this.cast.write(buf);
  }

  async start() {
    if (this.state !== State.IDLE) return;
    this.setState(State.STARTING);
    await this.bringUp();
    this.watchdog = setInterval(() => this.check().catch((e) => log.warn('watchdog', e.message)), 5000);
    if (this.cfg.reloadHours > 0) {
      this.reloadTimer = setInterval(() => this.queue(() => this.recycle('scheduled reload')),
        this.cfg.reloadHours * 3600 * 1000);
    }
  }

  async bringUp() {
    this.startedAt = Date.now();
    this.lastChunkAt = this.startedAt;
    this.lastMp3At = 0;
    this.lastVideo = { t: -1, at: this.startedAt };
    this.lastNotes = { n: -1, at: this.startedAt };
    this.silence.start((b) => this.cast.write(b));
    this.encoder.start();
    try {
      await this.browser.openPage(this.pageUrl, { startupTimeoutMs: this.cfg.startupTimeoutSeconds * 1000 });
    } catch (e) {
      log.error('open failed:', e.message);
      this.failures++;
      // leave the watchdog to retry with backoff
    }
  }

  async tearDown() {
    this.silence.stop();
    await this.browser.closePage();
    this.encoder.stop();
    this.cast.clear();
  }

  async recycle(reason) {
    if (this.state === State.IDLE || this.recycling) return;
    this.recycling = true;
    try { await this._recycle(reason); } finally { this.recycling = false; }
  }

  async _recycle(reason) {
    this.restarts++;
    const delay = Math.min(60_000, 2000 * 2 ** Math.min(this.failures, 5));
    log.warn(`recycling (${reason}); attempt ${this.restarts}, waiting ${delay / 1000}s`);
    if (this.state === State.LIVE) this.setState(State.STARTING);
    await this.tearDown();
    await new Promise((r) => setTimeout(r, delay));
    if (this.state === State.IDLE) return;
    await this.bringUp();
  }

  async stop() {
    if (this.state === State.IDLE) return;
    log.info('no listeners; shutting the session down');
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    this.watchdog = this.reloadTimer = null;
    this.stopping = true;
    try {
      await this.tearDown();
      if (this.cfg.killBrowserWhenIdle) await this.browser.close();
    } finally { this.stopping = false; }
    this.setState(State.IDLE);
  }

  async check() {
    if (this.state === State.IDLE || this.recycling) return;
    const now = Date.now();
    const sinceChunk = (now - this.lastChunkAt) / 1000;
    const limit = this.lastMp3At ? this.cfg.stallSeconds : this.cfg.startupTimeoutSeconds + this.cfg.stallSeconds;
    if (sinceChunk > limit) {
      this.failures++;
      return this.queue(() => this.recycle(`no audio for ${sinceChunk.toFixed(0)}s`));
    }
    const v = await this.browser.videoTime();
    if (v) this.probe = v;
    if (v && v.t !== this.lastVideo.t) this.lastVideo = { t: v.t, at: now };
    else if (v && now - this.lastVideo.at > this.cfg.videoStallSeconds * 1000) {
      this.failures++;
      return this.queue(() => this.recycle(`video clock frozen for ${((now - this.lastVideo.at) / 1000).toFixed(0)}s`));
    }
    // Detection can die while the video keeps playing (a thrown exception in the
    // page's frame loop). A freeway with five lanes never goes this long without a car.
    if (v && typeof v.notes === 'number') {
      if (v.notes !== this.lastNotes.n) this.lastNotes = { n: v.notes, at: now };
      else if (this.cfg.noteStallSeconds > 0 && v.notes > 0 && now - this.lastNotes.at > this.cfg.noteStallSeconds * 1000) {
        this.failures++;
        return this.queue(() => this.recycle(`no new notes for ${((now - this.lastNotes.at) / 1000).toFixed(0)}s while video plays`));
      }
    }
  }

  async shutdown() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    this.stopping = true;
    await this.tearDown();
    await this.browser.close();
    this.setState(State.IDLE);
  }

  stats() {
    const now = Date.now();
    return {
      state: this.state,
      listeners: this.cast.listeners,
      lastChunkAgeMs: this.lastChunkAt ? now - this.lastChunkAt : null,
      lastMp3AgeMs: this.lastMp3At ? now - this.lastMp3At : null,
      sessionUptimeS: this.startedAt && this.state !== State.IDLE ? Math.round((now - this.startedAt) / 1000) : 0,
      restarts: this.restarts,
      video: this.lastVideo.t >= 0 ? this.lastVideo.t : null,
      probe: this.state === State.IDLE ? null : this.probe || null,
    };
  }
}
