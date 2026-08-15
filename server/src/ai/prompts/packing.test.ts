import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { MODE_CATEGORY_TITLE } from "../packing.js";
import {
  buildGrounding,
  packingSystemPrompt,
  packingUserPrompt,
  quantityGuide,
} from "./packing.js";
import { allDestinations } from "../../data/index.js";
import type { Destination, TravelMode } from "../../types.js";

/**
 * Looks a catalogue row up by id and fails loudly when it is gone. A renamed or
 * deleted destination should read as "the catalogue moved", not as a stack of
 * confusing `undefined` property errors halfway down a fixture comparison.
 */
function destination(id: string): Destination {
  const dest = allDestinations.find((d) => d.id === id);
  if (!dest) {
    throw new Error(
      `Destination "${id}" is not in allDestinations. These tests pin prompt ` +
        `fixtures to real catalogue rows; update both together.`,
    );
  }
  return dest;
}

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
}

const SPITI = destination("spiti");
const GOA = destination("goa");
const BALI = destination("bali");

const MODES: TravelMode[] = ["bike", "flight", "bus"];

const NEGATIVE_CONSTRAINT =
  "Do not place an item in the mode section that would appear unchanged in a list for a different travel mode.";

describe("committed prompt fixtures", () => {
  // These .txt files are reviewed data, not auto-updatable snapshots. There is
  // deliberately no `--update` path: changing a prompt changes what every cached
  // answer was generated from, so it must land as a diff a human read and chose.
  it("renders the system prompt exactly as committed", () => {
    expect(packingSystemPrompt()).toBe(fixture("packing.system.txt"));
  });

  it("renders the Spiti bike 7-day prompt exactly as committed", () => {
    const g = buildGrounding(SPITI, "2026-06-12", "2026-06-18", "bike");
    expect(packingUserPrompt(g)).toBe(fixture("packing.spiti-bike-7d.txt"));
  });

  it("renders the Goa flight 2-day prompt exactly as committed", () => {
    const g = buildGrounding(GOA, "2026-07-11", "2026-07-12", "flight");
    expect(packingUserPrompt(g)).toBe(fixture("packing.goa-flight-2d.txt"));
  });

  it("renders the Bali flight 5-day prompt exactly as committed", () => {
    const g = buildGrounding(BALI, "2026-09-10", "2026-09-14", "flight");
    expect(packingUserPrompt(g)).toBe(fixture("packing.bali-flight-5d.txt"));
  });
});

describe("buildGrounding", () => {
  it("counts a single-month range inclusively and takes that month's numbers", () => {
    const g = buildGrounding(SPITI, "2026-06-12", "2026-06-18", "bike");
    // 12th to 18th is seven days, not six: both dates are on the trip.
    expect(g.days).toBe(7);
    expect(g.months).toEqual(["June"]);
    expect(g.tempMin).toBe(SPITI.weather[5].tempMin);
    expect(g.tempMax).toBe(SPITI.weather[5].tempMax);
    expect(g.weatherLines).toEqual([`June — ${SPITI.weather[5].summary}`]);
  });

  it("counts a trip that starts and ends on the same date as one day", () => {
    const g = buildGrounding(GOA, "2026-07-11", "2026-07-11", "flight");
    expect(g.days).toBe(1);
    expect(g.months).toEqual(["July"]);
  });

  it("spans every month a cross-month range touches, not just the first", () => {
    // The failure this whole feature exists to prevent: a 28 Jun → 2 Jul trip
    // described with June's numbers alone hides July's rain and July's lows.
    const g = buildGrounding(SPITI, "2026-06-28", "2026-07-02", "bike");
    const june = SPITI.weather[5];
    const july = SPITI.weather[6];

    expect(g.days).toBe(5);
    expect(g.months).toEqual(["June", "July"]);
    expect(g.tempMin).toBe(Math.min(june.tempMin, july.tempMin));
    expect(g.tempMax).toBe(Math.max(june.tempMax, july.tempMax));
    expect(g.weatherLines).toEqual([
      `June — ${june.summary}`,
      `July — ${july.summary}`,
    ]);
  });

  it("orders a range that crosses new year as December then January", () => {
    // Month indexes wrap, so a naive start..end index walk would produce
    // nothing or eleven months here.
    const g = buildGrounding(GOA, "2026-12-30", "2027-01-02", "flight");
    expect(g.days).toBe(4);
    expect(g.months).toEqual(["December", "January"]);
    expect(g.weatherLines).toHaveLength(2);
  });

  it("marks an international destination international and an Indian one not", () => {
    expect(buildGrounding(BALI, "2026-09-10", "2026-09-14", "flight").international).toBe(
      true,
    );
    expect(buildGrounding(GOA, "2026-07-11", "2026-07-12", "flight").international).toBe(
      false,
    );
  });

  it("is deterministic for identical arguments", () => {
    // No clock, no locale, no randomness — this is what lets the fixtures above
    // be compared byte for byte on any machine and in CI.
    const a = buildGrounding(SPITI, "2026-06-12", "2026-06-18", "bike");
    const b = buildGrounding(SPITI, "2026-06-12", "2026-06-18", "bike");
    expect(a).toEqual(b);
    expect(packingUserPrompt(a)).toBe(packingUserPrompt(b));
  });
});

describe("quantityGuide", () => {
  /** Reads the daily figure back out of the text the module actually produced. */
  function daily(text: string): string {
    const match = text.match(/socks\): qty (\d+)\./);
    if (!match) throw new Error(`No daily quantity line in:\n${text}`);
    return match[1];
  }

  it("scales the numbers with trip length", () => {
    expect(quantityGuide(2)).not.toBe(quantityGuide(7));
    expect(daily(quantityGuide(2))).toBe("2");
    expect(daily(quantityGuide(7))).toBe("7");
  });

  it("caps the daily figure at 7 however long the trip runs", () => {
    // Nobody packs fourteen t-shirts for a fortnight; the cap is stated in the
    // text too, or the model "corrects" it back to the day count.
    expect(daily(quantityGuide(14))).toBe(daily(quantityGuide(7)));
    expect(daily(quantityGuide(30))).toBe("7");
  });

  it("never emits a zero quantity for a one-day trip", () => {
    // A qty 0 line is worse than no line: it reads as an instruction.
    const text = quantityGuide(1);
    expect(text).not.toMatch(/0/);
    expect(text).toContain("This trip is 1 day long");
  });
});

describe("travel-mode divergence", () => {
  const prompts = Object.fromEntries(
    MODES.map((mode) => [
      mode,
      packingUserPrompt(buildGrounding(SPITI, "2026-06-12", "2026-06-18", mode)),
    ]),
  ) as Record<TravelMode, string>;

  it("differs by more than the mode word between bike and flight", () => {
    // Strip every mode word from both and the remainders must still diverge.
    // This fails the day someone collapses MODE_BRIEF into one shared template
    // with the mode name swapped in — the cosmetic relabel the PRD guards
    // against, where a "bike list" is a flight list under a new heading.
    const strip = (text: string) => text.replace(/bike|flight|bus/gi, "");
    expect(strip(prompts.bike)).not.toBe(strip(prompts.flight));
  });

  it("keeps pannier vocabulary exclusive to the bike brief", () => {
    expect(prompts.bike).toMatch(/pannier/i);
    expect(prompts.flight).not.toMatch(/pannier/i);
    expect(prompts.bus).not.toMatch(/pannier/i);
  });

  it("keeps cabin vocabulary exclusive to the flight brief", () => {
    expect(prompts.flight).toMatch(/cabin/i);
    expect(prompts.bike).not.toMatch(/cabin/i);
    expect(prompts.bus).not.toMatch(/cabin/i);
  });

  it("produces three distinct prompts for the same trip", () => {
    expect(new Set(MODES.map((mode) => prompts[mode])).size).toBe(3);
  });

  it("dictates each mode's exact category title and neither of the others", () => {
    // The separator is an em dash; downstream code matches this string, so a
    // near-miss here is a mode section nothing can find.
    for (const mode of MODES) {
      expect(prompts[mode]).toContain(MODE_CATEGORY_TITLE[mode]);
      for (const other of MODES) {
        if (other === mode) continue;
        expect(prompts[mode]).not.toContain(MODE_CATEGORY_TITLE[other]);
      }
    }
  });

  it("states the negative constraint for every mode", () => {
    for (const mode of MODES) {
      expect(prompts[mode]).toContain(NEGATIVE_CONSTRAINT);
    }
  });
});

describe("grounding hygiene", () => {
  const cases: Array<{ dest: Destination; prompt: string }> = [
    {
      dest: SPITI,
      prompt: packingUserPrompt(
        buildGrounding(SPITI, "2026-06-12", "2026-06-18", "bike"),
      ),
    },
    {
      dest: GOA,
      prompt: packingUserPrompt(
        buildGrounding(GOA, "2026-07-11", "2026-07-12", "flight"),
      ),
    },
    {
      dest: BALI,
      prompt: packingUserPrompt(
        buildGrounding(BALI, "2026-09-10", "2026-09-14", "flight"),
      ),
    },
  ];

  const texts = [...cases.map((c) => c.prompt), packingSystemPrompt()];

  it.each(cases.map((c) => [c.dest.id, c] as const))(
    "leaves the excluded destination fields out of the %s prompt",
    (_id, { dest, prompt }) => {
      // Each exclusion is deliberate: heroGradient/blurb/bestFor are marketing
      // copy whose tone bleeds into the summary, monthScores is a fit score the
      // model misreads as a temperature, and budgetTier invites the brand and
      // price talk the system prompt forbids.
      expect(prompt).not.toContain(dest.heroGradient);
      expect(prompt).not.toContain(dest.blurb);
      expect(prompt).not.toContain(dest.bestFor);
      expect(prompt).not.toContain(dest.monthScores.join(", "));
      expect(prompt).not.toContain(JSON.stringify(dest.monthScores));
      expect(prompt).not.toContain(String(dest.coords[0]));
    },
  );

  it("never carries an @ character or a budget tier symbol into any prompt", () => {
    // An @ is the cheapest tripwire for an email or handle reaching a globally
    // cached prompt; ₹ is the budget tier, which packing does not vary with.
    for (const text of texts) {
      expect(text).not.toContain("@");
      expect(text).not.toContain("₹");
    }
  });

  it("returns a system prompt with no interpolation at all", () => {
    // Rules only, never data: identical on every call and naming no destination,
    // which is what keeps it out of the cache-key conversation entirely.
    expect(packingSystemPrompt()).toBe(packingSystemPrompt());
    for (const name of [SPITI.name, GOA.name, BALI.name]) {
      expect(packingSystemPrompt()).not.toContain(name);
    }
  });
});

describe("international versus domestic documents", () => {
  it("asks for passport and visa on an international trip", () => {
    const prompt = packingUserPrompt(
      buildGrounding(BALI, "2026-09-10", "2026-09-14", "flight"),
    );
    expect(prompt).toMatch(/passport/i);
    expect(prompt).toMatch(/visa/i);
  });

  it("never asks for a passport on a domestic trip", () => {
    // The word does appear, but only inside an explicit negation: the module
    // rules the passport out rather than staying silent, because silence is
    // what the model fills in with a passport line anyway.
    const prompt = packingUserPrompt(
      buildGrounding(GOA, "2026-07-11", "2026-07-12", "flight"),
    );
    expect(prompt).toContain(
      "Documents needs no passport, visa, plug adapter or foreign currency",
    );
    expect(prompt).not.toContain("must cover passport");
    expect(prompt).not.toMatch(/international trip/i);
  });
});

describe("buildGrounding refuses ranges it cannot ground", () => {
  // These throw rather than degrade, and the reason is worth stating: without
  // them the failure is not an exception, it is a *prompt*. An unparseable
  // date leaves the day-walk never entering, so `covered` is empty and
  // Math.min of nothing is Infinity — the model is handed "Coldest low:
  // Infinity °C", answers confidently, and that answer is cached globally for
  // thirty days. A throw is a 502 the user can retry.
  it("rejects a date that is not a real calendar date", () => {
    // V8 parses "2026-02-30T00:00:00Z" as 2 March rather than rejecting it, so
    // a NaN check alone would let a February request be grounded and cached
    // against March's weather. Only the ISO round-trip catches that.
    expect(() => buildGrounding(GOA, "2026-02-30", "2026-03-02", "flight")).toThrow(
      RangeError,
    );
    expect(() => buildGrounding(GOA, "not-a-date", "2026-03-02", "flight")).toThrow(
      RangeError,
    );
    expect(() => buildGrounding(GOA, "2026-03-01", "2026-04-31", "flight")).toThrow(
      RangeError,
    );
  });

  it("rejects a reversed range", () => {
    expect(() => buildGrounding(GOA, "2026-03-10", "2026-03-02", "flight")).toThrow(
      RangeError,
    );
  });

  it("rejects a range longer than the supported span", () => {
    // Unbounded, the day-by-day walk is a loop a caller controls the length of.
    expect(() => buildGrounding(GOA, "2026-01-01", "2027-01-01", "flight")).toThrow(
      RangeError,
    );
    // The boundary itself is fine: 30 days counting both dates.
    expect(() =>
      buildGrounding(GOA, "2026-01-01", "2026-01-30", "flight"),
    ).not.toThrow();
    expect(buildGrounding(GOA, "2026-01-01", "2026-01-30", "flight").days).toBe(30);
  });

  it("never renders a non-finite temperature into a prompt", () => {
    const prompt = packingUserPrompt(
      buildGrounding(GOA, "2026-06-28", "2026-07-02", "bike"),
    );
    expect(prompt).not.toContain("Infinity");
    expect(prompt).not.toContain("NaN");
    expect(prompt).not.toContain("undefined");
  });
});
