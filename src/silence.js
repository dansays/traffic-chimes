import { spawn } from 'node:child_process';
import { logger } from './log.js';

const log = logger('silence');

/**
 * While the page is warming up (camera connect, first HLS segments) listeners
 * already have an open response. Feeding them real-time silent MP3 frames keeps
 * players from timing out and gives them valid headers straight away.
 */
export class Silence {
  constructor({ ffmpegPath, bitrate, seconds = 1 }) {
    this.ffmpegPath = ffmpegPath;
    this.bitrate = bitrate;
    this.seconds = seconds;
    this.buf = null;
    this.timer = null;
  }

  /** Render `seconds` of silence once at boot. */
  async prepare() {
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(this.seconds),
      '-c:a', 'libmp3lame', '-b:a', this.bitrate, '-f', 'mp3',
      '-write_xing', '0', '-id3v2_version', '0', 'pipe:1'];
    const chunks = [];
    await new Promise((resolve, reject) => {
      const p = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
      p.stdout.on('data', (c) => chunks.push(c));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
    });
    this.buf = Buffer.concat(chunks);
    log.info(`prepared ${this.seconds}s of silence (${this.buf.length} bytes)`);
  }

  start(sink) {
    if (this.timer || !this.buf) return;
    sink(this.buf);
    this.timer = setInterval(() => sink(this.buf), this.seconds * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get running() { return this.timer !== null; }
}
