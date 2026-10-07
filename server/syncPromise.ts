// Apps Script runs each request synchronously and has no event loop to finish async work before
// returning. The portal's rules are written with async/await (shared with the browser versions),
// so the server bundle is compiled with async/await turned into generators and uses this
// promise, which settles immediately. Every "await" on the server is on already-available data.
type State = 'pending' | 'fulfilled' | 'rejected';
type Handler = { ok?: (v: unknown) => unknown; err?: (e: unknown) => unknown; next: SyncPromise<unknown> };

const isThenable = (v: unknown): v is { then: (a: (x: unknown) => void, b: (e: unknown) => void) => unknown } =>
  !!v && (typeof v === 'object' || typeof v === 'function') && typeof (v as { then?: unknown }).then === 'function';

export class SyncPromise<T> {
  state: State = 'pending';
  value: unknown = undefined;
  private handlers: Handler[] = [];

  constructor(executor: (resolve: (v: T | PromiseLike<T>) => void, reject: (e: unknown) => void) => void) {
    try { executor((v) => this.settle('fulfilled', v), (e) => this.settle('rejected', e)); } catch (e) { this.settle('rejected', e); }
  }
  private settle(state: 'fulfilled' | 'rejected', v: unknown) {
    if (this.state !== 'pending') return;
    if (state === 'fulfilled' && isThenable(v)) {
      let done = false;
      try { v.then((x) => { if (!done) { done = true; this.settle('fulfilled', x); } }, (e) => { if (!done) { done = true; this.settle('rejected', e); } }); }
      catch (e) { if (!done) { done = true; this.settle('rejected', e); } }
      return;
    }
    this.state = state; this.value = v;
    const hs = this.handlers; this.handlers = [];
    hs.forEach((h) => this.run(h));
  }
  private run(h: Handler) {
    const fn = this.state === 'fulfilled' ? h.ok : h.err;
    if (!fn) { (h.next as SyncPromise<unknown>).settle(this.state as 'fulfilled' | 'rejected', this.value); return; }
    try { (h.next as SyncPromise<unknown>).settle('fulfilled', fn(this.value)); } catch (e) { (h.next as SyncPromise<unknown>).settle('rejected', e); }
  }
  then<A = T, B = never>(ok?: ((v: T) => A | PromiseLike<A>) | null, err?: ((e: unknown) => B | PromiseLike<B>) | null): SyncPromise<A | B> {
    const next = new SyncPromise<A | B>(() => {});
    const h: Handler = { ok: ok ? (v) => ok(v as T) : undefined, err: err ?? undefined, next: next as SyncPromise<unknown> };
    if (this.state === 'pending') this.handlers.push(h); else this.run(h);
    return next;
  }
  catch<B = never>(err?: ((e: unknown) => B | PromiseLike<B>) | null) { return this.then(undefined, err); }
  finally(fn?: (() => void) | null) {
    return this.then((v) => { fn?.(); return v; }, (e) => { fn?.(); throw e; });
  }
  static resolve<T>(v?: T | PromiseLike<T>) { return new SyncPromise<T>((r) => r(v as T)); }
  static reject(e?: unknown) { return new SyncPromise<never>((_, r) => r(e)); }
  static all(items: unknown[]) {
    return new SyncPromise<unknown[]>((res, rej) => {
      const out: unknown[] = new Array(items.length); let left = items.length;
      if (!left) return res(out);
      items.forEach((it, i) => SyncPromise.resolve(it).then((v) => { out[i] = v; if (--left === 0) res(out); }, rej));
    });
  }
  static allSettled(items: unknown[]) {
    return SyncPromise.all(items.map((it) => SyncPromise.resolve(it).then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }))));
  }
  static race(items: unknown[]) { return new SyncPromise((res, rej) => items.forEach((it) => SyncPromise.resolve(it).then(res, rej))); }
}

/** Reads a settled result synchronously (throws if something truly asynchronous slipped through). */
export function settleNow(v: unknown): unknown {
  // duck-typed: the global Promise on the server is the copy of SyncPromise loaded before the bundle
  const p = v as { state?: string; value?: unknown; then?: unknown } | null;
  if (p && typeof p === 'object' && typeof p.then === 'function' && typeof p.state === 'string') {
    if (p.state === 'fulfilled') return p.value;
    if (p.state === 'rejected') throw p.value;
    throw new Error('Internal error: an operation did not finish');
  }
  return v;
}
