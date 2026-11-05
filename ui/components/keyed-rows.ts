/**
 * Repaint a list without moving the rows that did not change (#81).
 *
 * Home's queue is repainted when readiness answers, when the count changes and every minute.
 * Rebuilding it with replaceChildren() takes every row out of the page and puts it back, and a
 * focused element taken out of the page loses focus: a Deny message being typed in an open
 * permission card stops taking keystrokes. So rows are kept by key while what they show is the
 * same, and the list is patched: rows no longer wanted are removed, new ones inserted, and a
 * kept row is only moved when the order among kept rows changed.
 *
 * Pure over a minimal parent interface, so tests run it without a DOM.
 */

export interface ParentLike<N> {
  readonly childNodes: ArrayLike<N>;
  insertBefore(node: N, ref: N | null): unknown;
  removeChild(node: N): unknown;
}

/** Make `parent`'s children exactly `desired`, in order, moving as few kept nodes as it can. */
export function reconcile<N>(parent: ParentLike<N>, desired: N[]): void {
  const want = new Set(desired);
  for (const c of Array.from(parent.childNodes)) if (!want.has(c)) parent.removeChild(c);
  desired.forEach((n, i) => {
    if (parent.childNodes[i] !== n) parent.insertBefore(n, parent.childNodes[i] ?? null);
  });
}

/**
 * The element for each item: the one built before when its key and signature are unchanged,
 * else a new one. Entries for keys not in `items` are dropped from the cache.
 */
export function keyedReuse<T, E>(
  cache: Map<string, { sig: string; el: E }>,
  items: T[],
  keyOf: (t: T) => string,
  sigOf: (t: T) => string,
  build: (t: T) => E,
): E[] {
  const seen = new Set<string>();
  const out = items.map((t) => {
    const key = keyOf(t);
    const sig = sigOf(t);
    seen.add(key);
    const had = cache.get(key);
    if (had && had.sig === sig) return had.el;
    const el = build(t);
    cache.set(key, { sig, el });
    return el;
  });
  for (const k of [...cache.keys()]) if (!seen.has(k)) cache.delete(k);
  return out;
}
