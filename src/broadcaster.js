import { EventEmitter } from 'node:events';
import { logger } from './log.js';

const log = logger('cast');
const MAX_CLIENT_BACKLOG = 1 << 20; // 1 MiB: a player this far behind is stalled

/**
 * Fans MP3 bytes out to every connected HTTP response and keeps a small ring
 * buffer so a new listener hears sound immediately instead of waiting for the
 * next frame. Emits 'listeners' with the current count whenever it changes.
 */
export class Broadcaster extends EventEmitter {
  constructor({ ringBytes }) {
    super();
    this.ringBytes = ringBytes;
    this.ring = [];
    this.ringSize = 0;
    this.clients = new Set();
    this.bytesOut = 0;
  }

  get listeners() { return this.clients.size; }

  write(buf) {
    this.ring.push(buf);
    this.ringSize += buf.length;
    while (this.ringSize > this.ringBytes && this.ring.length > 1) {
      this.ringSize -= this.ring.shift().length;
    }
    for (const res of this.clients) {
      if (res.writableLength > MAX_CLIENT_BACKLOG) {
        log.warn('dropping stalled listener', res.__peer);
        res.destroy();
        continue;
      }
      res.write(buf);
      this.bytesOut += buf.length;
    }
  }

  clear() {
    this.ring = [];
    this.ringSize = 0;
  }

  addClient(res, peer) {
    res.__peer = peer;
    for (const buf of this.ring) res.write(buf);
    this.clients.add(res);
    log.info(`listener joined ${peer} (${this.clients.size} total)`);
    this.emit('listeners', this.clients.size);
    const drop = () => {
      if (!this.clients.delete(res)) return;
      log.info(`listener left ${peer} (${this.clients.size} total)`);
      this.emit('listeners', this.clients.size);
    };
    res.on('close', drop);
    res.on('error', drop);
  }
}
