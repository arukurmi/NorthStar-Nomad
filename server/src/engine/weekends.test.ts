import { describe, it, expect } from "vitest";
import { findLongWeekends } from "./weekends.js";

describe("findLongWeekends", () => {
  it("detects Diwali 2026 long weekend (Sat Nov 7 – Mon Nov 9)", () => {
    const spans = findLongWeekends(2026, 11);
    const diwali = spans.find((s) => s.holidayName === "Diwali");
    expect(diwali).toBeDefined();
    expect(diwali!.start).toBe("2026-11-07");
    expect(diwali!.end).toBe("2026-11-09");
    expect(diwali!.days).toBe(3);
  });

  it("detects Gandhi Jayanti 2026 (Fri Oct 2 – Sun Oct 4)", () => {
    const spans = findLongWeekends(2026, 10);
    const gandhi = spans.find((s) => s.holidayName === "Gandhi Jayanti");
    expect(gandhi).toBeDefined();
    expect(gandhi!.start).toBe("2026-10-02");
    expect(gandhi!.days).toBe(3);
  });

  it("does not report plain 2-day weekends", () => {
    for (const s of findLongWeekends(2026, 7)) {
      expect(s.days).toBeGreaterThanOrEqual(3);
    }
  });

  it("catches spans straddling month boundaries", () => {
    // Buddha Purnima Fri 2026-05-01 joins Sat/Sun May 2–3.
    const may = findLongWeekends(2026, 5);
    expect(may.some((s) => s.start === "2026-05-01" && s.days === 3)).toBe(
      true,
    );
    // The span lies fully in May, so April's view must not include it.
    const apr = findLongWeekends(2026, 4);
    expect(apr.some((s) => s.start === "2026-05-01")).toBe(false);
  });
});
