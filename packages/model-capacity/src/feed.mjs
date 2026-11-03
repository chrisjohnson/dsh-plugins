// dsh-model-capacity: the live snapshot feed.
//
// One builder serves every connected panel. While nobody is subscribed there is
// no timer and no work. While somebody is, a once-a-second tick re-reads the
// snapshot (the clocks and rates on screen move even when no event fires) and
// every capacity event pushes sooner, coalesced so a burst costs one frame. A
// tick whose content is identical to the last frame is not sent, apart from a
// keep-alive that lets a dead connection be noticed by the failed write.

const ASOF = /"asOf":\d+,?/;

export class SnapshotFeed {
  /**
   * @param {object} options
   * @param {() => object} options.build current snapshot; called once per frame however many subscribers.
   * @param {() => number} [options.now]
   * @param {(fn: () => void, ms: number) => unknown} [options.setTimer]
   * @param {(handle: unknown) => void} [options.clearTimer]
   * @param {number} [options.minGapMs] least time between two event-driven frames.
   * @param {number} [options.tickMs] period of the content re-check while anyone is subscribed.
   * @param {number} [options.keepAliveMs] longest silence before an unchanged frame is sent anyway.
   */
  constructor({ build, now = Date.now, setTimer = defaultSetTimer, clearTimer = defaultClearTimer, minGapMs = 150, tickMs = 1000, keepAliveMs = 15000 }) {
    this.build = build;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.minGapMs = minGapMs;
    this.tickMs = tickMs;
    this.keepAliveMs = keepAliveMs;
    this.subscribers = new Set();
    this.tickTimer = null;
    this.pushTimer = null;
    this.lastSignature = null;
    this.lastSentAt = 0;
    this.frames = 0;
  }

  get size() {
    return this.subscribers.size;
  }

  /** Register a sink. It receives the current frame at once, then every later one. Returns the unsubscribe. */
  subscribe(send) {
    const first = this.subscribers.size === 0;
    this.subscribers.add(send);
    this.lastSentAt = this.now();
    const line = JSON.stringify(this.build()) + '\n';
    // The first listener defines "what the audience has seen"; a later one joins
    // that audience without redefining it, so nobody misses a pending change.
    if (first) this.lastSignature = line.replace(ASOF, '');
    this.#deliver(send, line);
    this.#armTick();
    return () => this.#remove(send);
  }

  /** A capacity event happened: push soon, coalescing a burst into one frame. */
  notify() {
    if (this.subscribers.size === 0 || this.pushTimer !== null) return;
    const wait = Math.max(0, this.minGapMs - (this.now() - this.lastSentAt));
    this.pushTimer = this.setTimer(() => {
      this.pushTimer = null;
      this.#push();
    }, wait);
  }

  close() {
    this.subscribers.clear();
    this.#disarm();
  }

  #remove(send) {
    this.subscribers.delete(send);
    if (this.subscribers.size === 0) this.#disarm();
  }

  #disarm() {
    if (this.tickTimer !== null) this.clearTimer(this.tickTimer);
    if (this.pushTimer !== null) this.clearTimer(this.pushTimer);
    this.tickTimer = null;
    this.pushTimer = null;
  }

  #armTick() {
    if (this.tickTimer !== null || this.subscribers.size === 0) return;
    this.tickTimer = this.setTimer(() => {
      this.tickTimer = null;
      this.#tick();
      this.#armTick();
    }, this.tickMs);
  }

  #render() {
    const line = JSON.stringify(this.build()) + '\n';
    this.lastSignature = line.replace(ASOF, '');
    return line;
  }

  #tick() {
    if (this.subscribers.size === 0) return;
    const line = JSON.stringify(this.build()) + '\n';
    const signature = line.replace(ASOF, '');
    if (signature === this.lastSignature && this.now() - this.lastSentAt < this.keepAliveMs) return;
    this.lastSignature = signature;
    this.#fanOut(line);
  }

  #push() {
    if (this.subscribers.size === 0) return;
    this.#fanOut(this.#render());
  }

  #fanOut(line) {
    this.lastSentAt = this.now();
    this.frames += 1;
    for (const send of [...this.subscribers]) this.#deliver(send, line);
  }

  #deliver(send, line) {
    try {
      send(line);
    } catch {
      this.#remove(send);
    }
  }
}

function defaultSetTimer(fn, ms) {
  const handle = setTimeout(fn, ms);
  if (typeof handle?.unref === 'function') handle.unref();
  return handle;
}

function defaultClearTimer(handle) {
  clearTimeout(handle);
}
