import type { Destination } from "../types.js";

/** User-facing vibe filters → destination tags that satisfy them. */
export const VIBES: Record<string, { emoji: string; label: string; tags: string[] }> = {
  trek: {
    emoji: "🥾",
    label: "Trekking",
    tags: ["treks", "trekking", "camping", "himalaya", "annapurna", "rafting"],
  },
  beach: {
    emoji: "🏖️",
    label: "Beaches",
    tags: ["beach", "beaches", "islands", "lagoons", "surf", "overwater"],
  },
  mountains: {
    emoji: "🏔️",
    label: "Mountains",
    tags: ["mountains", "himalaya", "hills", "snow", "kanchenjunga", "annapurna", "cold-desert"],
  },
  heritage: {
    emoji: "🏰",
    label: "Heritage",
    tags: ["heritage", "forts", "fort", "fort-palace", "palaces", "taj-mahal", "old-town", "old-city", "bazaars", "mosques", "monasteries", "monastery", "colonial", "ghats", "temples", "history", "golden-temple", "tigers-nest"],
  },
  party: {
    emoji: "🎉",
    label: "Exciting",
    tags: ["nightlife", "city", "cafes", "shopping", "paragliding", "zipline", "rafting", "scuba", "desert-safari", "skyline"],
  },
  wildlife: {
    emoji: "🦁",
    label: "Wildlife",
    tags: ["safari", "tigers", "jungle", "whales", "scuba", "snorkeling", "diving"],
  },
  chill: {
    emoji: "🌿",
    label: "Chill",
    tags: ["quiet", "homestays", "tea", "tea-gardens", "coffee", "romantic", "lakes", "lake", "mist", "river", "resorts", "yoga", "pine-forest", "rice-terraces", "gardens"],
  },
};

export function matchesVibes(dest: Destination, vibeIds: string[]): boolean {
  if (vibeIds.length === 0) return true;
  const wanted = new Set(vibeIds.flatMap((v) => VIBES[v]?.tags ?? []));
  return dest.tags.some((t) => wanted.has(t));
}
