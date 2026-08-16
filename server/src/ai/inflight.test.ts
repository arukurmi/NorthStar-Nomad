import { describe, it, expect, afterEach } from "vitest";
import {
  __resetInFlightForTests,
  inFlight,
  inFlightSize,
} from "./inflight.js";

/** A promise with its resolve/reject pulled out, so a test controls timing. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  __resetInFlightForTests();
});

describe("inFlight", () => {
  it("runs the work once and gives both callers the same answer", () => {
    // The whole point: two users asking the same question inside the vendor's
    // latency window must produce one paid call, not two.
    let runs = 0;
    const gate = deferred<string>();
    const work = () => {
      runs += 1;
      return gate.promise;
    };

    const first = inFlight("k", work);
    const second = inFlight("k", work);
    expect(runs).toBe(1);
    expect(second).toBe(first);

    gate.resolve("answer");
    return Promise.all([first, second]).then(([a, b]) => {
      expect(a).toBe("answer");
      expect(b).toBe("answer");
    });
  });

  it("keeps different keys independent", async () => {
    let runs = 0;
    const work = async () => {
      runs += 1;
      return runs;
    };
    await Promise.all([inFlight("a", work), inFlight("b", work)]);
    expect(runs).toBe(2);
  });

  it("clears the key after settling, so a later caller starts fresh", async () => {
    let runs = 0;
    const work = async () => {
      runs += 1;
      return runs;
    };
    await inFlight("k", work);
    expect(inFlightSize()).toBe(0);
    await inFlight("k", work);
    expect(runs).toBe(2);
  });

  it("does not poison a key with a rejection", async () => {
    // A failed call must not make every later caller inherit that failure —
    // which is what would happen if the entry were only removed on success.
    const failing = () => Promise.reject(new Error("vendor down"));
    await expect(inFlight("k", failing)).rejects.toThrow("vendor down");
    expect(inFlightSize()).toBe(0);
    await expect(inFlight("k", async () => "recovered")).resolves.toBe(
      "recovered",
    );
  });

  it("shares a rejection with everyone inside the same window", async () => {
    const gate = deferred<string>();
    const first = inFlight("k", () => gate.promise);
    const second = inFlight("k", () => gate.promise);
    gate.reject(new Error("vendor down"));
    await expect(first).rejects.toThrow("vendor down");
    await expect(second).rejects.toThrow("vendor down");
  });

  it("a slow call settling late does not evict a newer entry", async () => {
    // The identity check in the finally. Without it, the first call's cleanup
    // deletes the *second* call's promise and silently reopens the window this
    // module exists to close.
    const slow = deferred<string>();
    const first = inFlight("k", () => slow.promise);
    __resetInFlightForTests();

    const fresh = deferred<string>();
    const second = inFlight("k", () => fresh.promise);
    expect(inFlightSize()).toBe(1);

    slow.resolve("old");
    await first;
    // The newer entry must still be registered.
    expect(inFlightSize()).toBe(1);

    fresh.resolve("new");
    await second;
    expect(inFlightSize()).toBe(0);
  });
});
