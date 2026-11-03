// dsh-kanban: the push channel behind the board.
//
// Every open board page holds one long-lived response of newline-delimited JSON
// frames instead of asking for the board on a timer. While nobody is subscribed
// there is no timer and no work. While somebody is, once a second the feed
// reads the (cheap) change token; only a token that moved costs a rebuild, and
// only a rebuild whose content differs sends the board. A change that leaves the
// board alone (activity on a ticket's detail, say) sends a token-only frame so a
// page showing that detail knows to look. A quiet board sends nothing but a
// keep-alive that lets a dead connection be noticed by the failed write.
//
// Frames: the compact board with `seq`, `boot`, `token` and `asOf` beside it
// (the same shape the `board` RPC answers), or just `{ token }`.

import { compactBoard } from './board-snapshot.mjs';

export class BoardFeed {
  /**
   * @param {object} options
   * @param {() => string} options.token the cheap change token.
   * @param {() => {seq: number, token: string, asOf: number, board: object, signature: string}} options.build one snapshot; called once per change however many subscribers.
   * @param {() => number} [options.now]
   * @param {(fn: () => void, ms: number) => unknown} [options.setTimer]
   * @param {(handle: unknown) => void} [options.clearTimer]
   * @param {number} [options.minGapMs] least time between two event-driven checks.
   * @param {number} [options.tickMs] period of the token check while anyone is subscribed.
   * @param {number} [options.keepAliveMs] longest silence before a keep-alive frame is sent.
   */
  constructor({ token, build, now = Date.now, setTimer = defaultSetTimer, clearTimer = defaultClearTimer, minGapMs = 150, tickMs = 1000, keepAliveMs = 15000 }) {
    this.token = token;
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
    this.last = null;
    this.lastSentAt = 0;
    this.frames = 0;
    this.builds = 0;
  }

  get size() {
    return this.subscribers.size;
  }

  /** Register a sink. It receives the current board at once, then every later change. Returns the unsubscribe. */
  subscribe(send) {
    // A change not yet seen reaches the existing audience first; the newcomer
    // then gets a board read just now, because the figures it carries forward
    // (a growing working time) are only as good as the moment they were read.
    if (this.subscribers.size > 0) this.#check();
    this.subscribers.add(send);
    this.lastSentAt = this.now();
    this.#rebuild();
    this.#deliver(send, this.#line(this.last, true));
    this.#armTick();
    return () => this.#remove(send);
  }

  /** Something that may have changed the board just happened: check soon, coalescing a burst into one check. */
  notify() {
    if (this.subscribers.size === 0 || this.pushTimer !== null) return;
    const wait = Math.max(0, this.minGapMs - (this.now() - this.lastSentAt));
    this.pushTimer = this.setTimer(() => {
      this.pushTimer = null;
      this.#check();
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
      this.#check();
      this.#armTick();
    }, this.tickMs);
  }

  #rebuild() {
    this.builds += 1;
    const previous = this.last;
    this.last = this.build();
    return previous;
  }

  #line(snapshot, withBoard) {
    const frame = withBoard
      ? { ...compactBoard(snapshot.board), seq: snapshot.seq, boot: snapshot.boot, token: snapshot.token, asOf: snapshot.asOf }
      : { token: snapshot.token };
    return JSON.stringify(frame) + '\n';
  }

  #check() {
    if (this.subscribers.size === 0) return;
    const token = this.token();
    if (this.last !== null && token === this.last.token) {
      if (this.now() - this.lastSentAt >= this.keepAliveMs) this.#fanOut(this.#line(this.last, false));
      return;
    }
    const previous = this.#rebuild();
    const boardChanged = previous === null || previous.signature !== this.last.signature;
    this.#fanOut(this.#line(this.last, boardChanged));
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
