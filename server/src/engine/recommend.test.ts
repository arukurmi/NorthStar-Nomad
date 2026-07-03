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
      expect(p.destination.modes).toContain("bike");
      expect(p.destination.scope).toBe("india");
    }
    for (const p of r.international) {
      expect(p.destination.scope).toBe("international");
    }
  });

  it("rotates picks with the seed and cycles back", () => {
    const s0 = recommend(start, end, 0).india.bike.map((p) => p.destination.id);
    const s1 = recommend(start, end, 1).india.bike.map((p) => p.destination.id);
    const sN = recommend(start, end, s0.length).india.bike.map(
      (p) => p.destination.id,
    );
    expect(s1[0]).toBe(s0[1 % s0.length]);
    expect(sN).toEqual(s0);
  });

  it("never returns empty pools, even for a 1-day monsoon Tuesday", () => {
    const r = recommend(utc("2026-07-14"), utc("2026-07-14"));
    expect(r.india.flight.length).toBeGreaterThan(0);
    expect(r.india.bike.length).toBeGreaterThan(0);
    expect(r.india.bus.length).toBeGreaterThan(0);
    expect(r.international.length).toBeGreaterThan(0);
  });

  it("every pick carries weather and a why-now line", () => {
    const r = recommend(start, end);
    for (const p of [...r.india.flight, ...r.international]) {
      expect(p.weatherNow.summary.length).toBeGreaterThan(0);
      expect(p.whyNow.length).toBeGreaterThan(0);
    }
  });
});
