import { describe, it, expect } from "vitest";
import { scoreDestination, tripDays } from "./score.js";
import { roadDistanceKm } from "./geo.js";
import { cityById } from "../data/cities.js";
import { allDestinations } from "../data/index.js";

const byId = (id: string) => {
  const d = allDestinations.find((d) => d.id === id);
  if (!d) throw new Error(`missing destination ${id}`);
  return d;
};

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);
const delhi = cityById("delhi-ncr");
const distFromDelhi = (id: string) =>
  roadDistanceKm(delhi.coords, byId(id).coords);

describe("tripDays", () => {
  it("counts inclusive days", () => {
    expect(tripDays(utc("2026-07-04"), utc("2026-07-05"))).toBe(2);
    expect(tripDays(utc("2026-07-04"), utc("2026-07-04"))).toBe(1);
  });
});

describe("scoreDestination", () => {
  it("ranks winter Goa far above monsoon Goa", () => {
    const goa = byId("goa");
    const dist = distFromDelhi("goa");
    const winter = scoreDestination(goa, utc("2026-12-19"), utc("2026-12-21"), dist);
    const monsoon = scoreDestination(goa, utc("2026-07-18"), utc("2026-07-20"), dist);
    expect(winter).toBeGreaterThan(monsoon + 3);
  });

  it("penalizes a 2-day Ladakh trip vs a week there", () => {
    const ladakh = byId("ladakh");
    const dist = distFromDelhi("ladakh");
    const weekend = scoreDestination(ladakh, utc("2026-08-01"), utc("2026-08-02"), dist);
    const week = scoreDestination(ladakh, utc("2026-08-01"), utc("2026-08-07"), dist);
    expect(week).toBeGreaterThan(weekend + 3);
  });

  it("is deterministic", () => {
    const d = byId("rishikesh");
    const dist = distFromDelhi("rishikesh");
    const a = scoreDestination(d, utc("2026-10-10"), utc("2026-10-11"), dist);
    const b = scoreDestination(d, utc("2026-10-10"), utc("2026-10-11"), dist);
    expect(a).toBe(b);
  });

  it("weights months across a straddling range", () => {
    const manali = byId("manali");
    const dist = distFromDelhi("manali");
    const june = scoreDestination(manali, utc("2026-06-24"), utc("2026-06-27"), dist);
    const july = scoreDestination(manali, utc("2026-07-08"), utc("2026-07-11"), dist);
    const straddle = scoreDestination(manali, utc("2026-06-28"), utc("2026-07-01"), dist);
    expect(straddle).toBeLessThan(june);
    expect(straddle).toBeGreaterThan(july);
  });
});
