import { describe, it, expect } from "vitest";
import { allDestinations } from "./index.js";

describe("destination dataset invariants", () => {
  it("has destinations", () => {
    expect(allDestinations.length).toBeGreaterThan(0);
  });

  it("has unique ids", () => {
    const ids = allDestinations.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(allDestinations.map((d) => [d.id, d] as const))(
    "%s is well-formed",
    (_id, d) => {
      expect(d.monthScores).toHaveLength(12);
      expect(d.weather).toHaveLength(12);
      expect(d.modes.length).toBeGreaterThan(0);
      expect(d.idealDays).toBeGreaterThan(0);
      expect(d.distanceKm).toBeGreaterThan(0);
      for (const s of d.monthScores) {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(10);
      }
      for (const w of d.weather) {
        expect(w.tempMin).toBeLessThanOrEqual(w.tempMax);
        expect(w.summary.length).toBeGreaterThan(0);
      }
    },
  );

  it("bike/bus destinations are within road-trip range", () => {
    for (const d of allDestinations) {
      if (d.modes.includes("bus") || d.modes.includes("bike")) {
        expect(d.distanceKm).toBeLessThanOrEqual(1100);
      }
    }
  });

  it("international destinations are flight-only", () => {
    for (const d of allDestinations) {
      if (d.scope === "international") {
        expect(d.modes).toEqual(["flight"]);
      }
    }
  });
});
