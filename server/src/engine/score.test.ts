import { describe, it, expect } from "vitest";
import { scoreDestination, tripDays } from "./score.js";
import { allDestinations } from "../data/index.js";

const byId = (id: string) => {
  const d = allDestinations.find((d) => d.id === id);
  if (!d) throw new Error(`missing destination ${id}`);
  return d;
};

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("tripDays", () => {
  it("counts inclusive days", () => {
    expect(tripDays(utc("2026-07-04"), utc("2026-07-05"))).toBe(2);
    expect(tripDays(utc("2026-07-04"), utc("2026-07-04"))).toBe(1);
  });
});

describe("scoreDestination", () => {
  it("ranks winter Goa far above monsoon Goa", () => {
    const goa = byId("goa");
    const winter = scoreDestination(goa, utc("2026-12-19"), utc("2026-12-21"));
    const monsoon = scoreDestination(goa, utc("2026-07-18"), utc("2026-07-20"));
    expect(winter).toBeGreaterThan(monsoon + 3);
  });

  it("penalizes a 2-day Ladakh trip vs a week there", () => {
    const ladakh = byId("ladakh");
    const weekend = scoreDestination(
      ladakh,
      utc("2026-08-01"),
      utc("2026-08-02"),
    );
    const week = scoreDestination(ladakh, utc("2026-08-01"), utc("2026-08-07"));
    expect(week).toBeGreaterThan(weekend + 3);
  });

  it("is deterministic", () => {
    const d = byId("rishikesh");
    const a = scoreDestination(d, utc("2026-10-10"), utc("2026-10-11"));
    const b = scoreDestination(d, utc("2026-10-10"), utc("2026-10-11"));
    expect(a).toBe(b);
  });

  it("weights months across a straddling range", () => {
    // Late June → early July in Manali: should sit between pure-June and pure-July scores.
    const manali = byId("manali");
    const june = scoreDestination(manali, utc("2026-06-24"), utc("2026-06-27"));
    const july = scoreDestination(manali, utc("2026-07-08"), utc("2026-07-11"));
    const straddle = scoreDestination(
      manali,
      utc("2026-06-28"),
      utc("2026-07-01"),
    );
    expect(straddle).toBeLessThan(june);
    expect(straddle).toBeGreaterThan(july);
  });
});
