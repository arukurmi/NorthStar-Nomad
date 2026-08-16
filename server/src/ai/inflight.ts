/**
 * De-duplicates concurrent identical work.
 *
 * The problem it solves is specific and costs real money. `ai_cache` is global
 * and a row is only written *after* a completion returns, so two users who ask
 * the same question within the same few seconds both miss, both call the
 * vendor, and both pay — for one answer, of which one is then thrown away by
 * the upsert. The window is exactly the vendor's latency, which is the longest
 * thing in the request.
 *
 * A `Map<string, Promise>` closes it: the second caller awaits the first
 * caller's promise instead of starting its own. In-process and single-node,
 * like `rateLimit.ts`, and with the same caveat — two instances mean two
 * independent maps and the saving degrades to zero rather than breaking.
 */
const pending = new Map<string, Promise<unknown>>();

/**
 * Runs `work` under `key`, or joins the run already in flight for that key.
 *
 * The entry is removed in a `finally`, so a rejection never poisons the key —
 * a failed call must not make every later caller inherit that failure. Callers
 * therefore share a success *and* share a failure, but only within one window.
 */
export function inFlight<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = pending.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const started = work().finally(() => {
    // Only delete our own entry. Without the identity check a slow call
    // finishing after a later one started would evict the newer promise and
    // silently reopen the window it exists to close.
    if (pending.get(key) === started) pending.delete(key);
  });
  pending.set(key, started);
  return started;
}

/** Test-only: the map is module state shared by every test in a file. */
export function __resetInFlightForTests(): void {
  pending.clear();
}

/** How many calls are currently in flight. Test and diagnostics only. */
export function inFlightSize(): number {
  return pending.size;
}
