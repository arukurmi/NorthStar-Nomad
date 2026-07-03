import { describe, it, expect } from "vitest";
import { recommend } from "./recommend.js";

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("recommend", () => {
  const start = utc("2026-11-07");
  const end = utc("2026-11-09");

  it("populates all three india modes and international", () => {
    const r = recommend(start, end);
    expect(r.india.flight.length).toBeGreaterThan(0);
    expect(r.india.bike.length).toBeGreaterThan(0);
    expect(r.india.bus.length).toBeGreaterThan(0);
    expect(r.international.length).toBeGreaterThan(0);
  });

  it("respects mode and scope in each pool", () => {
    const r = recommend(start, end);
    for (const p of r.india.bike) {
      expect(p.modes).toContain("bike");
      expect(p.destination.scope).toBe("india");
      expect(p.distanceKm).toBeLessThanOrEqual(700);
    }
    for (const p of r.international) {
      expect(p.destination.scope).toBe("international");
    }
  });

  it("changes bike picks with the home city", () => {
    const fromDelhi = recommend(start, end, { cityId: "delhi-ncr" });
    const fromBengaluru = recommend(start, end, { cityId: "bengaluru" });
    const delhiIds = fromDelhi.india.bike.map((p) => p.destination.id);
    const blrIds = fromBengaluru.india.bike.map((p) => p.destination.id);
    expect(blrIds.length).toBeGreaterThan(0);
    expect(blrIds).not.toEqual(delhiIds);
    // Coorg is riding distance from Bengaluru, never from Delhi.
    expect(delhiIds).not.toContain("coorg");
  });

  it("rotates picks with the seed and cycles back", () => {
    const ids = (seed: number) =>
      recommend(start, end, { seed }).india.bike.map((p) => p.destination.id);
    const s0 = ids(0);
    expect(ids(1)[0]).toBe(s0[1 % s0.length]);
    expect(ids(s0.length)).toEqual(s0);
  });

  it("never returns empty pools for unfiltered requests", () => {
    const r = recommend(utc("2026-07-14"), utc("2026-07-14"));
    expect(r.india.flight.length).toBeGreaterThan(0);
    expect(r.india.bike.length).toBeGreaterThan(0);
    expect(r.india.bus.length).toBeGreaterThan(0);
    expect(r.international.length).toBeGreaterThan(0);
  });

  it("applies budget filter honestly", () => {
    const r = recommend(start, end, { budget: "₹" });
    expect(r.filtered).toBe(true);
    for (const p of [
      ...r.india.flight,
      ...r.india.bike,
      ...r.india.bus,
      ...r.international,
    ]) {
      expect(p.destination.budgetTier).toBe("₹");
    }
  });

  it("applies vibe filters", () => {
    const r = recommend(start, end, { vibes: ["beach"] });
    const all = [...r.india.flight, ...r.india.bike, ...r.india.bus];
    for (const p of all) {
      expect(
        p.destination.tags.some((t) =>
          ["beach", "beaches", "islands", "lagoons", "surf", "overwater"].includes(t),
        ),
      ).toBe(true);
    }
  });

  it("every pick carries weather, distance, and a why-now line", () => {
    const r = recommend(start, end);
    for (const p of [...r.india.flight, ...r.international]) {
      expect(p.weatherNow.summary.length).toBeGreaterThan(0);
      expect(p.whyNow.length).toBeGreaterThan(0);
      expect(p.distanceKm).toBeGreaterThan(0);
    }
  });
});
