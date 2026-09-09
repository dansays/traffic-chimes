import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { logger } from './log.js';

const log = logger('ffmpeg');
const MAX_STDIN_BACKLOG = 4 << 20;

/**
 * One ffmpeg process per browser session: WebM/Opus in on stdin, MP3 out on
 * stdout. A fresh page needs a fresh encoder because each MediaRecorder run
 * begins with a new WebM header. Emits 'data' (Buffer) and 'exit'.
 */
export class Encoder extends EventEmitter {
  constructor({ ffmpegPath, bitrate }) {
    super();
    this.ffmpegPath = ffmpegPath;
    this.bitrate = bitrate;
    this.proc = null;
    this.dropped = 0;
  }

  start() {
    if (this.proc) return;
    const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin',
      '-f', 'webm', '-i', 'pipe:0', '-vn',
      // MediaRecorder timestamps occasionally step backwards by a few ms after a
      // stall; async resampling absorbs that instead of the muxer complaining.
      '-af', 'aresample=async=1:first_pts=0', '-ac', '2', '-ar', '44100',
      '-c:a', 'libmp3lame', '-b:a', this.bitrate, '-f', 'mp3',
      '-write_xing', '0', '-id3v2_version', '0', 'pipe:1'];
    const proc = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stdout.on('data', (buf) => this.emit('data', buf));
    proc.stderr.on('data', (d) => { if (this.proc === proc) log.warn(String(d).trim()); });
    proc.stdin.on('error', (e) => log.debug('stdin', e.code));
    proc.on('error', (e) => log.error('spawn failed', e.message));
    proc.on('close', (code, sig) => {
      const expected = this.proc !== proc; // stop() detaches before ending stdin
      if (!expected) this.proc = null;
      log.info(`exited code=${code} signal=${sig}${expected ? '' : ' (unexpected)'}`);
      if (!expected) this.emit('exit', code);
    });
    log.info('started', this.bitrate);
  }

  write(buf) {
    const p = this.proc;
    if (!p || p.stdin.destroyed) return false;
    if (p.stdin.writableLength > MAX_STDIN_BACKLOG) {
      if (++this.dropped % 50 === 1) log.warn('stdin backlog, dropping chunk');
      return false;
    }
    p.stdin.write(buf);
    return true;
  }

  stop() {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    try { p.stdin.end(); } catch { /* ignore */ }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);
    p.on('close', () => clearTimeout(t));
  }

  get running() { return this.proc !== null; }
}
