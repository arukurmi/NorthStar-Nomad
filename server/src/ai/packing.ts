import { createHash } from "node:crypto";
import type { JsonSchemaObject } from "./provider.js";
import type { TravelMode } from "../types.js";

export interface PackingItem {
  /** 16 lowercase hex chars. Derived server-side; the client never computes one. */
  itemKey: string;
  label: string;
  qty: number;
  /** Omitted entirely when the model had nothing non-obvious to say. */
  reason?: string;
}

export interface PackingCategory {
  name: string;
  /**
   * True for the one category matching MODE_CATEGORY_TITLE[mode]. Drives
   * "expanded by default" without the client string-matching a heading.
   */
  modeCategory: boolean;
  items: PackingItem[];
}

export interface PackingList {
  summary: string;
  categories: PackingCategory[];
}

/**
 * The exact heading the prompt dictates for the mode section. Dictating it is
 * what makes the section structurally identifiable — the model cannot dodge it
 * with a synonym, and nothing downstream has to guess which category is which.
 * The separator is an em dash (U+2014); it must match the prompt byte for byte.
 */
export const MODE_CATEGORY_TITLE: Record<TravelMode, string> = {
  bike: "Mode — Bike",
  flight: "Mode — Flight",
  bus: "Mode — Bus",
};

export const PACKING_SCHEMA_NAME = "packing_list";

/**
 * Advisory, not authoritative. `toVendorSchema` strips `minItems`/`maxItems`/
 * `minimum`/`maximum` for Gemini (it 400s on them) and OpenAI strict mode drops
 * them too, so on two of three vendors the counts and ranges below are hints the
 * model may ignore silently. They are declared anyway because they cost nothing
 * and steer the vendor that does honour them — but `parsePackingList`, never
 * this object, decides what is a valid list.
 *
 * `required` lists every property including `reason`: OpenAI strict mode demands
 * that `required` name every key in `properties`, which is why the parser has to
 * absorb the `null`/`""` the model then emits for obvious items.
 *
 * `modeCategory` and `itemKey` are deliberately absent. Both are derived
 * server-side, and putting `itemKey` in the schema would let model-authored text
 * become a primary key.
 */
export const PACKING_SCHEMA: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "categories"],
  properties: {
    summary: {
      type: "string",
      description:
        "One or two sentences on what makes packing for this trip distinctive. No greeting, no brand names, no prices.",
    },
    categories: {
      type: "array",
      minItems: 4,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "items"],
        properties: {
          name: {
            type: "string",
            description:
              "Clothing, Gear, Documents or Health, plus exactly one mode category titled with the literal heading given in the user message.",
          },
          items: {
            type: "array",
            minItems: 3,
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "qty", "reason"],
              properties: {
                label: { type: "string" },
                qty: {
                  type: "integer",
                  minimum: 1,
                  maximum: 20,
                  description:
                    "Copied from the quantity guide in the user message. Never invented arithmetic.",
                },
                reason: {
                  type: "string",
                  description:
                    "Why this item, traceable to a grounding fact. Empty string when the item is obvious.",
                },
              },
            },
          },
        },
      },
    },
  },
};

export type PackingShapeReason =
  | "not_object"
  | "missing_field"
  | "wrong_type"
  | "empty_string"
  | "too_long"
  | "out_of_range"
  | "count_out_of_range"
  | "duplicate_item";

/**
 * Carries structure, never the offending value. Model output is untrusted text:
 * echoing it into a message is how log injection happens, and the message ends
 * up in an `AiError` cause chain that a test or a log line will print.
 */
export class PackingShapeError extends Error {
  readonly reason: PackingShapeReason;
  /** Dotted/indexed path, e.g. "categories[2].items[5].label". "" is the root. */
  readonly path: string;

  constructor(reason: PackingShapeReason, path: string) {
    super(`${reason} at ${path === "" ? "(root)" : path}`);
    this.name = "PackingShapeError";
    this.reason = reason;
    this.path = path;
  }
}

const SUMMARY_MAX = 280;
const CATEGORY_NAME_MAX = 40;
const LABEL_MAX = 60;
const REASON_MAX = 160;
const CATEGORIES_MIN = 4;
const CATEGORIES_MAX = 6;
const ITEMS_MIN = 3;
const ITEMS_MAX = 8;
const QTY_MIN = 1;
const QTY_MAX = 20;

/**
 * Two details here are not cosmetic.
 *
 * Combining marks are stripped after NFKD rather than left to fall through the
 * character class. Without that, "Naive" slugs to `naive` and "Naïve" slugs to
 * `nai-ve` — the decomposed diaeresis becomes a separator mid-word — so exactly
 * the cosmetic drift this function exists to collapse would survive it.
 *
 * A label with no ASCII alphanumerics at all (a Devanagari or Cyrillic label)
 * would otherwise slug to the empty string, making every such label in one
 * category collide and turning valid model output into a `duplicate_item`
 * rejection and a 502. The fallback keeps them distinct.
 *
 * The `-+` passes are linear rather than quadratic only because the class
 * replace immediately above has already collapsed every run to one character.
 * The two lines are coupled; do not reorder them.
 */
function slug(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii === "" ? value.normalize("NFKC").toLowerCase().trim() : ascii;
}

/**
 * Stable identity for one checkbox, `/^[0-9a-f]{16}$/`.
 *
 * Slugging before hashing is the entire point: regeneration produces cosmetic
 * drift — "Rain liners", "rain liners", "Rain-liners" — and all of it must
 * collapse to one key, or a tick the user made last week lands on a row nobody
 * renders. An index-based key ("cat0.item3") breaks the instant the model
 * reorders, which it does. Hashing rather than storing the slug keeps unbounded
 * model-authored text out of a primary key and gives the tick endpoint one fixed
 * shape to validate.
 *
 * The category is part of the input because "Gloves" under Clothing and "Gloves"
 * under Mode — Bike are two different checkboxes.
 */
export function itemKeyFor(categoryName: string, label: string): string {
  return createHash("sha256")
    .update(`${slug(categoryName)}|${slug(label)}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Reads an own property only. Model output arrives through `JSON.parse`, which
 * never writes to a prototype, so this is not exploitable today — but the
 * module's claim is a *structural* guarantee, and a plain `host[key]` walks the
 * prototype chain. If anything else in the process ever polluted
 * `Object.prototype.summary`, a model returning `{}` would validate against the
 * polluted value and that value would be cached globally.
 */
function own(host: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(host, key) ? host[key] : undefined;
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PackingShapeError("not_object", path);
  }
  return value as Record<string, unknown>;
}

/** Absent or `undefined` is `missing_field`; present-but-wrong is `wrong_type`.
 *  The distinction is what tells "the model omitted a key" from "the model sent
 *  a number where a string belongs" in a failing test. */
function requireString(
  host: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const raw = own(host, key);
  if (raw === undefined) throw new PackingShapeError("missing_field", path);
  if (typeof raw !== "string") throw new PackingShapeError("wrong_type", path);
  return raw;
}

function requireTrimmed(
  host: Record<string, unknown>,
  key: string,
  path: string,
  max: number,
): string {
  const trimmed = requireString(host, key, path).trim();
  if (trimmed.length === 0) throw new PackingShapeError("empty_string", path);
  if (trimmed.length > max) throw new PackingShapeError("too_long", path);
  return trimmed;
}

function requireArray(
  host: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
  max: number,
): unknown[] {
  const raw = own(host, key);
  if (raw === undefined) throw new PackingShapeError("missing_field", path);
  if (!Array.isArray(raw)) throw new PackingShapeError("wrong_type", path);
  if (raw.length < min || raw.length > max) {
    throw new PackingShapeError("count_out_of_range", path);
  }
  return raw;
}

function parseQty(host: Record<string, unknown>, path: string): number {
  const raw = own(host, "qty");
  if (raw === undefined) throw new PackingShapeError("missing_field", path);
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new PackingShapeError("wrong_type", path);
  }
  if (raw < QTY_MIN || raw > QTY_MAX) {
    throw new PackingShapeError("out_of_range", path);
  }
  return raw;
}

/**
 * OpenAI strict mode forces `required` to include `reason`, so the model emits
 * `null` or `""` for items it considers obvious — and `JsonSchemaNode` cannot
 * express a `string | null` union to describe that. All four spellings of
 * "nothing to say" (absent, `undefined`, `null`, blank) therefore mean the same
 * thing here: the field is dropped, and the row stores SQL NULL.
 */
function parseReason(
  host: Record<string, unknown>,
  path: string,
): string | undefined {
  const raw = own(host, "reason");
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new PackingShapeError("wrong_type", path);
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > REASON_MAX) throw new PackingShapeError("too_long", path);
  return trimmed;
}

/**
 * The authoritative validator. Recursive descent over a fixed shape in a single
 * pass: presence → type → bounds → project into a freshly constructed object.
 *
 * Nothing from `value` is ever returned by reference. Every string is a fresh
 * trimmed copy and every object is built here from named fields, which is what
 * structurally guarantees that a model-authored extra property cannot reach
 * `putCached` or a response body. Unknown properties at any node are dropped
 * silently rather than rejected — a vendor adding a field to its output must not
 * take the feature down.
 *
 * Throws `PackingShapeError` on the first violation; the adapter retries once
 * and then gives up with `bad_output`.
 */
export function parsePackingList(value: unknown, mode: TravelMode): PackingList {
  const root = asObject(value, "");
  const summary = requireTrimmed(root, "summary", "summary", SUMMARY_MAX);
  const rawCategories = requireArray(
    root,
    "categories",
    "categories",
    CATEGORIES_MIN,
    CATEGORIES_MAX,
  );

  const modeTitle = MODE_CATEGORY_TITLE[mode];
  // Two checkboxes sharing one tick is worse than a retry, so a repeated key
  // anywhere in the list is a hard failure rather than a silent merge.
  const seenKeys = new Set<string>();
  /**
   * Category names must be unique too, and not for tidiness. `readStoredList`
   * groups the persisted rows by `category`, so two categories called "Gear"
   * rehydrate as one after a reload and the list the user sees stops matching
   * the list that was generated. Two both titled with the mode heading would
   * also both be flagged `modeCategory`, contradicting "exactly one section is
   * expanded".
   */
  const seenCategories = new Set<string>();
  const categories: PackingCategory[] = [];

  for (let i = 0; i < rawCategories.length; i += 1) {
    const categoryPath = `categories[${i}]`;
    const rawCategory = asObject(rawCategories[i], categoryPath);
    const name = requireTrimmed(
      rawCategory,
      "name",
      `${categoryPath}.name`,
      CATEGORY_NAME_MAX,
    );
    if (seenCategories.has(name)) {
      throw new PackingShapeError("duplicate_item", `${categoryPath}.name`);
    }
    seenCategories.add(name);

    const itemsPath = `${categoryPath}.items`;
    const rawItems = requireArray(
      rawCategory,
      "items",
      itemsPath,
      ITEMS_MIN,
      ITEMS_MAX,
    );

    const items: PackingItem[] = [];
    for (let j = 0; j < rawItems.length; j += 1) {
      const itemPath = `${itemsPath}[${j}]`;
      const rawItem = asObject(rawItems[j], itemPath);
      const label = requireTrimmed(
        rawItem,
        "label",
        `${itemPath}.label`,
        LABEL_MAX,
      );
      const qty = parseQty(rawItem, `${itemPath}.qty`);
      const reason = parseReason(rawItem, `${itemPath}.reason`);

      const itemKey = itemKeyFor(name, label);
      if (seenKeys.has(itemKey)) {
        throw new PackingShapeError("duplicate_item", itemPath);
      }
      seenKeys.add(itemKey);

      const item: PackingItem = { itemKey, label, qty };
      if (reason !== undefined) item.reason = reason;
      items.push(item);
    }

    // Zero matches is legal: the model disobeyed the dictated heading, which
    // costs the client an expanded-by-default section, not a failed request.
    categories.push({ name, modeCategory: name === modeTitle, items });
  }

  return { summary, categories };
}

/**
 * A factory because `CompletionRequest<T>.parse` is `(value: unknown) => T`, so
 * the mode has to be closed over. Doing it this way sets `modeCategory` inside
 * the same pass that validates, so the flag is already present in `result.data`
 * when the route calls `putCached`. The alternative — a `markModeCategory(list,
 * mode)` post-step — is a step the cache-*miss* path can forget while the
 * cache-*hit* path keeps working, and that bug only surfaces in production.
 */
export function makePackingParser(
  mode: TravelMode,
): (value: unknown) => PackingList {
  return (value: unknown) => parsePackingList(value, mode);
}
